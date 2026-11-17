// Shopper orders: checkout, payment confirmation (test gateway), history, cancel, return.

import { z } from "zod";
import { type Db, type Row, utcnow } from "../db.js";
import { ApiError, type Ctx, api, forbidden, notFound, pageMeta, paginate, pathInt } from "../http.js";
import { mediaUrl } from "../services/catalog.js";
import {
  type Address,
  STATUS_LABEL,
  TRANSITIONS,
  cancelUnpaidOrder,
  createPaymentIntent,
  getSettings,
  placeOrder,
  refundFulfilment,
  restock,
  settlePayment,
  transition,
  withinReturnWindow,
} from "../services/commerce.js";
import { LongText, Text, optional } from "../util.js";

/** Integer field (accepts numeric strings like pydantic's lax mode; missing → "Field required"). */
const IntField = () =>
  z.preprocess(
    (v) => (typeof v === "string" && /^\s*-?\d+\s*$/.test(v) ? Number(v) : v),
    z.number({ invalid_type_error: "Input should be a valid integer" }).int("Input should be a valid integer"),
  );

/** Pydantic's Literal wording for a bad value; other issues (e.g. missing field) keep the global message. */
const enumMessage =
  (choices: string): z.ZodErrorMap =>
  (issue, ctx) =>
    issue.code === z.ZodIssueCode.invalid_enum_value ? { message: `Input should be ${choices}` } : { message: ctx.defaultError };

const CheckoutIn = z.object({
  address_id: IntField().pipe(z.number().gt(0)),
  payment_method: z.enum(["cod", "online"], { errorMap: enumMessage("'cod' or 'online'") }),
  idempotency_key: z
    .string()
    .min(16)
    .max(64)
    .regex(/^[A-Za-z0-9_-]+$/, "String should match pattern '^[A-Za-z0-9_-]+$'"),
  vehicle_label: optional(Text(0, 120)),
});

const PaymentConfirmIn = z.object({
  intent_id: z.string().min(8).max(80),
  outcome: z.enum(["success", "failure"], { errorMap: enumMessage("'success' or 'failure'") }),
});

const ReasonIn = z.object({
  reason: LongText(3, 500),
});

const OrdersQuery = z.object({
  page: IntField().pipe(z.number().gte(1).lte(1000)).default(1),
  per_page: IntField().pipe(z.number().gte(1).lte(50)).default(10),
});

export async function fulfilmentOut(
  db: Db,
  f: Row,
  { returnDays, perspective }: { returnDays: number; perspective: string },
): Promise<Record<string, unknown>> {
  const items = await db.all(
    `SELECT oi.id, oi.product_id, oi.title, oi.brand, oi.part_number, oi.sku, oi.unit_price_paise,
            oi.quantity, oi.line_total_paise, oi.gst_rate_bps, oi.hsn_code,
            (SELECT m.thumb_path FROM media m WHERE m.product_id = oi.product_id ORDER BY m.position, m.id LIMIT 1) AS thumb
     FROM order_items oi WHERE oi.fulfilment_id = ? ORDER BY oi.id`,
    [f.id],
  );
  const events = await db.all(
    "SELECT status, note, created_at FROM fulfilment_events WHERE fulfilment_id = ? ORDER BY id",
    [f.id],
  );
  const out: Record<string, unknown> = {
    id: f.id,
    status: f.status,
    status_label: STATUS_LABEL[f.status],
    seller: { id: f.seller_id, name: f.seller_name ?? null },
    items_paise: f.items_paise,
    shipping_paise: f.shipping_paise,
    carrier: f.carrier,
    tracking_number: f.tracking_number,
    cancel_reason: f.cancel_reason,
    return_reason: f.return_reason,
    refund_paise: f.refund_paise,
    shipped_at: f.shipped_at,
    delivered_at: f.delivered_at,
    items: items.map(({ thumb, ...rest }) => ({ ...rest, image: mediaUrl(thumb) })),
    events: events.map((e) => ({ ...e, label: STATUS_LABEL[e.status] ?? e.status })),
  };
  if (perspective === "buyer") {
    out.can_cancel = TRANSITIONS.cancel_buyer[0].has(f.status) || TRANSITIONS.cancel_unpaid[0].has(f.status);
    out.can_return = f.status === "delivered" && withinReturnWindow(f, returnDays);
  }
  return out;
}

export async function orderOut(db: Db, order: Row, { returnDays }: { returnDays: number }) {
  const fulfilments = await db.all(
    `SELECT f.*, s.display_name AS seller_name FROM fulfilments f JOIN sellers s ON s.id = f.seller_id
     WHERE f.order_id = ? ORDER BY f.id`,
    [order.id],
  );
  const payment = await db.one(
    "SELECT intent_id, status, provider FROM payments WHERE order_id = ? ORDER BY id DESC LIMIT 1",
    [order.id],
  );
  // Present while an online payment is still owed (pending, or failed and retryable).
  const paymentOwed =
    payment !== null &&
    order.payment_method === "online" &&
    (order.payment_status === "pending" || order.payment_status === "failed") &&
    fulfilments.some((f) => f.status === "pending_payment");
  const fulfilmentsOut = [];
  for (const f of fulfilments) fulfilmentsOut.push(await fulfilmentOut(db, f, { returnDays, perspective: "buyer" }));
  return {
    id: order.id,
    number: order.number,
    created_at: order.created_at,
    payment_method: order.payment_method,
    payment_status: order.payment_status,
    items_paise: order.items_paise,
    shipping_paise: order.shipping_paise,
    total_paise: order.total_paise,
    gst_paise: order.gst_paise,
    vehicle_label: order.vehicle_label,
    address: {
      full_name: order.ship_name,
      phone: order.ship_phone,
      line1: order.ship_line1,
      line2: order.ship_line2,
      landmark: order.ship_landmark,
      city: order.ship_city,
      state: order.ship_state,
      pincode: order.ship_pincode,
    },
    payment: paymentOwed && payment ? { intent_id: payment.intent_id, status: payment.status, provider: payment.provider } : null,
    fulfilments: fulfilmentsOut,
  };
}

async function returnDays(ctx: Ctx): Promise<number> {
  return (await getSettings(ctx.db, ctx.settings)).return_window_days;
}

/**
 * Load the caller's own order. 404 rather than 403: don't reveal other people's order IDs.
 * Write endpoints lock the row so concurrent confirm/retry/cancel calls on one order serialise
 * (SQLite's single writer did this implicitly).
 */
async function ownOrder(ctx: Ctx, orderId: number, { lock = false }: { lock?: boolean } = {}): Promise<Row> {
  const user = ctx.requireUser();
  const order = await ctx.db.one(`SELECT * FROM orders WHERE id = ?${lock ? " FOR UPDATE" : ""}`, [orderId]);
  if (!order || order.buyer_id !== user.id) throw notFound("Order");
  return order;
}

async function freshOrder(ctx: Ctx, orderId: number): Promise<Row> {
  const fresh = await ctx.db.one("SELECT * FROM orders WHERE id = ?", [orderId]);
  if (!fresh) throw new Error(`order ${orderId} missing`);
  return fresh;
}

api.route("POST", "/api/orders", { auth: "buyer", body: CheckoutIn, rate: "checkout", status: 201 }, async (ctx) => {
  const user = ctx.requireUser();
  const body = ctx.body;
  const address = await ctx.db.one("SELECT * FROM addresses WHERE id = ? AND user_id = ?", [body.address_id, user.id]);
  if (!address) {
    throw new ApiError(422, "validation_error", "Choose a delivery address.", {
      fields: { address_id: "Choose an address." },
    });
  }
  const orderId = await placeOrder(ctx.db, ctx.settings, {
    buyerId: user.id,
    address: address as unknown as Address,
    paymentMethod: body.payment_method,
    idempotencyKey: body.idempotency_key,
    vehicleLabel: body.vehicle_label || null,
  });
  const order = await freshOrder(ctx, orderId);
  await ctx.audit("order.placed", "order", orderId, { total_paise: order.total_paise, method: body.payment_method });
  return orderOut(ctx.db, order, { returnDays: await returnDays(ctx) });
});

api.route("GET", "/api/orders", { auth: "user", query: OrdersQuery }, async (ctx) => {
  const user = ctx.requireUser();
  const { limit, offset } = paginate(ctx.query.page, ctx.query.per_page);
  const total = Number(await ctx.db.scalar("SELECT COUNT(*) FROM orders WHERE buyer_id = ?", [user.id]));
  const rows = await ctx.db.all("SELECT * FROM orders WHERE buyer_id = ? ORDER BY id DESC LIMIT ? OFFSET ?", [
    user.id,
    limit,
    offset,
  ]);
  const days = await returnDays(ctx);
  const items = [];
  for (const r of rows) items.push(await orderOut(ctx.db, r, { returnDays: days }));
  return { items, ...pageMeta(total, ctx.query.page, limit) };
});

api.route("GET", "/api/orders/{order_id:int}", { auth: "user" }, async (ctx) => {
  const order = await ownOrder(ctx, pathInt(ctx, "order_id"));
  return orderOut(ctx.db, order, { returnDays: await returnDays(ctx) });
});

/** Test-mode gateway callback. Disabled in production, where only signed provider webhooks settle payments. */
api.route(
  "POST",
  "/api/orders/{order_id:int}/payment/confirm",
  { auth: "user", body: PaymentConfirmIn, rate: "checkout" },
  async (ctx) => {
    if (!ctx.settings.paymentsTestMode) throw forbidden("Test payments are disabled.");
    const order = await ownOrder(ctx, pathInt(ctx, "order_id"), { lock: true });
    const succeeded = ctx.body.outcome === "success";
    await settlePayment(ctx.db, order.id, ctx.body.intent_id, succeeded, ctx.requireUser().id);
    await ctx.audit(`payment.${succeeded ? "succeeded" : "failed"}`, "order", order.id);
    return orderOut(ctx.db, await freshOrder(ctx, order.id), { returnDays: await returnDays(ctx) });
  },
);

api.route("POST", "/api/orders/{order_id:int}/payment/retry", { auth: "user", rate: "checkout" }, async (ctx) => {
  const order = await ownOrder(ctx, pathInt(ctx, "order_id"), { lock: true });
  if (order.payment_method !== "online" || (order.payment_status !== "pending" && order.payment_status !== "failed")) {
    throw new ApiError(409, "invalid_state", "This order doesn't need payment.");
  }
  if (!(await ctx.db.scalar("SELECT 1 FROM fulfilments WHERE order_id = ? AND status = 'pending_payment'", [order.id]))) {
    throw new ApiError(409, "invalid_state", "This order doesn't need payment.");
  }
  await ctx.db.execute("UPDATE payments SET status = 'failed', updated_at = ? WHERE order_id = ? AND status = 'created'", [
    utcnow(),
    order.id,
  ]);
  await createPaymentIntent(ctx.db, order.id, order.total_paise);
  await ctx.db.execute("UPDATE orders SET payment_status = 'pending', updated_at = ? WHERE id = ?", [utcnow(), order.id]);
  return orderOut(ctx.db, await freshOrder(ctx, order.id), { returnDays: await returnDays(ctx) });
});

async function ownFulfilment(ctx: Ctx): Promise<[Row, Row]> {
  const order = await ownOrder(ctx, pathInt(ctx, "order_id"), { lock: true });
  const f = await ctx.db.one("SELECT * FROM fulfilments WHERE id = ? AND order_id = ?", [
    pathInt(ctx, "fulfilment_id"),
    order.id,
  ]);
  if (!f) throw notFound("Shipment");
  return [order, f];
}

api.route(
  "POST",
  "/api/orders/{order_id:int}/fulfilments/{fulfilment_id:int}/cancel",
  { auth: "user", body: ReasonIn, rate: "write" },
  async (ctx) => {
    const [order, f] = await ownFulfilment(ctx);
    const user = ctx.requireUser();
    if (f.status === "pending_payment") {
      await cancelUnpaidOrder(ctx.db, order.id, "buyer", user.id, ctx.body.reason);
    } else {
      await transition(ctx.db, f, "cancel_buyer", "buyer", user.id, ctx.body.reason, { cancel_reason: ctx.body.reason });
      await restock(ctx.db, f.id);
      await refundFulfilment(ctx.db, f);
    }
    await ctx.audit("fulfilment.cancelled_by_buyer", "fulfilment", f.id, { order: order.number });
    return orderOut(ctx.db, await freshOrder(ctx, order.id), { returnDays: await returnDays(ctx) });
  },
);

api.route(
  "POST",
  "/api/orders/{order_id:int}/fulfilments/{fulfilment_id:int}/return",
  { auth: "user", body: ReasonIn, rate: "write" },
  async (ctx) => {
    const [order, f] = await ownFulfilment(ctx);
    const days = await returnDays(ctx);
    if (f.status === "delivered" && !withinReturnWindow(f, days)) {
      throw new ApiError(409, "return_window_closed", `Returns are accepted within ${days} days of delivery.`);
    }
    await transition(ctx.db, f, "request_return", "buyer", ctx.requireUser().id, ctx.body.reason, {
      return_reason: ctx.body.reason,
    });
    await ctx.audit("fulfilment.return_requested", "fulfilment", f.id, { order: order.number });
    return orderOut(ctx.db, await freshOrder(ctx, order.id), { returnDays: days });
  },
);
