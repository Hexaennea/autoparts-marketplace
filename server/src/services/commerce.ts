// Money and order rules: runtime settings, cart pricing, the fulfilment state machine, payments.
// All prices are GST-inclusive integers in paise. The server recomputes every total from the
// database; the client never supplies a price.

import { randomBytes, randomInt } from "node:crypto";
import type { Settings } from "../config.js";
import { DAY, type Db, MINUTE, type Row, addMs, placeholders, utcnow } from "../db.js";
import { ApiError, badRequest, conflict } from "../http.js";
import { bpsOf, gstIncluded } from "../util.js";
import { mediaUrl } from "./catalog.js";

// ---- runtime settings (admin-editable) -----------------------------------------------------------

type SettingAttr = "defaultCommissionBps" | "shippingFeePaise" | "freeShippingThresholdPaise" | "returnWindowDays";

export const SETTING_KEYS: Record<string, [SettingAttr, number, number]> = {
  commission_bps: ["defaultCommissionBps", 0, 3000],
  shipping_fee_paise: ["shippingFeePaise", 0, 50_000],
  free_shipping_threshold_paise: ["freeShippingThresholdPaise", 0, 10_000_000],
  return_window_days: ["returnWindowDays", 0, 30],
};

export interface Rules {
  commission_bps: number;
  shipping_fee_paise: number;
  free_shipping_threshold_paise: number;
  return_window_days: number;
}

export async function getSettings(db: Db, settings: Settings): Promise<Rules> {
  const stored = new Map((await db.all("SELECT key, value FROM settings")).map((r) => [r.key as string, r.value as string]));
  const out: Record<string, number> = {};
  for (const [key, [attr]] of Object.entries(SETTING_KEYS)) {
    const raw = stored.get(key);
    const parsed = raw !== undefined && /^-?\d+$/.test(raw.trim()) ? Number.parseInt(raw, 10) : undefined;
    out[key] = parsed ?? settings[attr];
  }
  return out as unknown as Rules;
}

// ---- pricing ---------------------------------------------------------------------------------------

export interface Line {
  product: Row;
  quantity: number;
  total: number;
}

export interface SellerGroup {
  sellerId: number;
  sellerName: string;
  lines: Line[];
  shippingPaise: number;
  itemsPaise: number;
}

export class Quote {
  constructor(
    readonly groups: SellerGroup[],
    readonly issues: Row[],
  ) {}

  get itemsPaise(): number {
    return this.groups.reduce((s, g) => s + g.itemsPaise, 0);
  }
  get shippingPaise(): number {
    return this.groups.reduce((s, g) => s + g.shippingPaise, 0);
  }
  get totalPaise(): number {
    return this.itemsPaise + this.shippingPaise;
  }
  get gstPaise(): number {
    let sum = 0;
    for (const g of this.groups) for (const l of g.lines) sum += gstIncluded(l.total, l.product.gst_rate_bps);
    return sum;
  }
  get mrpSavingsPaise(): number {
    let sum = 0;
    for (const g of this.groups) for (const l of g.lines) sum += (l.product.mrp_paise - l.product.price_paise) * l.quantity;
    return sum;
  }
  summary() {
    let count = 0;
    for (const g of this.groups) for (const l of g.lines) count += l.quantity;
    return {
      items_paise: this.itemsPaise,
      shipping_paise: this.shippingPaise,
      total_paise: this.totalPaise,
      gst_paise: this.gstPaise,
      savings_paise: this.mrpSavingsPaise,
      item_count: count,
    };
  }
}

export const PRICING_SELECT = `
    SELECT p.id, p.title, p.slug, p.sku, p.part_number, p.price_paise, p.mrp_paise, p.stock, p.status,
           p.gst_rate_bps, p.hsn_code, p.seller_id, p.is_universal, b.name AS brand,
           s.display_name AS seller_name, s.kyc_status,
           (SELECT m.thumb_path FROM media m WHERE m.product_id = p.id ORDER BY m.position, m.id LIMIT 1) AS thumb
    FROM products p JOIN brands b ON b.id = p.brand_id JOIN sellers s ON s.id = p.seller_id
`;

/** Price [productId, quantity] pairs. Unavailable lines become `issues` instead of lines. */
export async function buildQuote(db: Db, settings: Settings, wanted: Array<[number, number]>): Promise<Quote> {
  const rules = await getSettings(db, settings);
  const ids = wanted.map(([pid]) => pid);
  const rows = new Map<number, Row>();
  if (ids.length) {
    for (const r of await db.all(`${PRICING_SELECT} WHERE p.id IN (${placeholders(ids)})`, ids)) rows.set(r.id, r);
  }
  const groups = new Map<number, SellerGroup>();
  const issues: Row[] = [];
  for (const [productId, wantedQty] of wanted) {
    let quantity = wantedQty;
    const row = rows.get(productId);
    if (!row || row.status !== "active" || row.kyc_status !== "approved") {
      issues.push({
        product_id: productId,
        code: "unavailable",
        message: "This part is no longer available.",
        title: row ? row.title : null,
      });
      continue;
    }
    if (row.stock <= 0) {
      issues.push({ product_id: productId, code: "out_of_stock", message: "Out of stock.", title: row.title });
      continue;
    }
    if (quantity > row.stock) {
      issues.push({
        product_id: productId,
        code: "quantity_reduced",
        message: `Only ${row.stock} left — quantity reduced.`,
        title: row.title,
        available: row.stock,
      });
      quantity = row.stock;
    }
    let group = groups.get(row.seller_id);
    if (!group) {
      group = { sellerId: row.seller_id, sellerName: row.seller_name, lines: [], shippingPaise: 0, itemsPaise: 0 };
      groups.set(row.seller_id, group);
    }
    const total = Number(row.price_paise) * quantity;
    group.lines.push({ product: row, quantity, total });
    group.itemsPaise += total;
  }
  for (const group of groups.values()) {
    group.shippingPaise = group.itemsPaise < rules.free_shipping_threshold_paise ? rules.shipping_fee_paise : 0;
  }
  return new Quote([...groups.values()], issues);
}

export function quoteOut(quote: Quote, rules: Rules) {
  return {
    groups: quote.groups.map((g) => ({
      seller: { id: g.sellerId, name: g.sellerName },
      items_paise: g.itemsPaise,
      shipping_paise: g.shippingPaise,
      free_shipping_remaining_paise: Math.max(0, rules.free_shipping_threshold_paise - g.itemsPaise),
      lines: g.lines.map((line) => ({
        product_id: line.product.id,
        title: line.product.title,
        slug: line.product.slug,
        brand: line.product.brand,
        part_number: line.product.part_number,
        price_paise: line.product.price_paise,
        mrp_paise: line.product.mrp_paise,
        quantity: line.quantity,
        max_quantity: Math.min(20, line.product.stock),
        line_total_paise: line.total,
        image: mediaUrl(line.product.thumb),
      })),
    })),
    issues: quote.issues,
    summary: quote.summary(),
    rules: {
      free_shipping_threshold_paise: rules.free_shipping_threshold_paise,
      shipping_fee_paise: rules.shipping_fee_paise,
    },
  };
}

// ---- fulfilment state machine -----------------------------------------------------------------------

type Actor = "system" | "seller" | "admin" | "buyer";

// action -> [allowed from-states, to-state, who may perform it]
export const TRANSITIONS: Record<string, [Set<string>, string, Set<Actor>]> = {
  pay: [new Set(["pending_payment"]), "placed", new Set(["system"])],
  pack: [new Set(["placed"]), "packed", new Set(["seller"])],
  ship: [new Set(["packed"]), "shipped", new Set(["seller"])],
  deliver: [new Set(["shipped"]), "delivered", new Set(["seller", "admin"])],
  cancel_buyer: [new Set(["placed"]), "cancelled", new Set(["buyer"])],
  cancel_seller: [new Set(["placed", "packed"]), "cancelled", new Set(["seller", "admin"])],
  // Unpaid online orders: cancelled whole (by the buyer, an admin, or the expiry job).
  cancel_unpaid: [new Set(["pending_payment"]), "cancelled", new Set(["buyer", "admin", "system"])],
  request_return: [new Set(["delivered"]), "return_requested", new Set(["buyer"])],
  accept_return: [new Set(["return_requested"]), "returned", new Set(["seller", "admin"])],
  reject_return: [new Set(["return_requested"]), "delivered", new Set(["seller", "admin"])],
};

export const STATUS_LABEL: Record<string, string> = {
  pending_payment: "Awaiting payment",
  placed: "Order placed",
  packed: "Packed",
  shipped: "Shipped",
  delivered: "Delivered",
  cancelled: "Cancelled",
  return_requested: "Return requested",
  returned: "Returned",
};

const COLUMN_RE = /^[a-z_]+$/;

export async function transition(
  db: Db,
  fulfilment: Row,
  action: string,
  actor: Actor,
  actorUserId: number | null,
  note: string | null = null,
  updates: Record<string, unknown> = {},
): Promise<string> {
  const [allowed, target, actors] = TRANSITIONS[action];
  if (!actors.has(actor)) throw new ApiError(403, "forbidden", "You can't perform this action on this order.");
  if (!allowed.has(fulfilment.status)) {
    throw conflict(
      `This order is ${STATUS_LABEL[fulfilment.status].toLowerCase()} and can't be changed that way.`,
      "invalid_transition",
    );
  }
  const now = utcnow();
  const columns = ["status = ?", "updated_at = ?"];
  const params: unknown[] = [target, now];
  for (const [column, value] of Object.entries(updates)) {
    if (!COLUMN_RE.test(column)) throw new Error(`bad column ${column}`);
    columns.push(`${column} = ?`);
    params.push(value);
  }
  // Optimistic concurrency: only move from the state we read.
  const changed = await db.execute(`UPDATE fulfilments SET ${columns.join(", ")} WHERE id = ? AND status = ?`, [
    ...params,
    fulfilment.id,
    fulfilment.status,
  ]);
  if (!changed) throw conflict("This order was just updated by someone else. Refresh and try again.", "stale_state");
  await db.execute(
    "INSERT INTO fulfilment_events (fulfilment_id, status, note, actor_user_id, created_at) VALUES (?, ?, ?, ?, ?)",
    [fulfilment.id, target, note, actorUserId, now],
  );
  fulfilment.status = target;
  return target;
}

export const UNPAID_TTL_MINUTES = 30;

/**
 * Cancel every unpaid shipment of an order, release its stock and void open payment requests.
 * An order awaiting online payment is all-or-nothing: cancelling one shipment of it would leave the
 * payment request charging for parts that will never ship.
 */
export async function cancelUnpaidOrder(
  db: Db,
  orderId: number,
  actor: Actor,
  actorUserId: number | null,
  reason: string,
): Promise<number> {
  let cancelled = 0;
  const rows = await db.all("SELECT * FROM fulfilments WHERE order_id = ? AND status = 'pending_payment' FOR UPDATE", [orderId]);
  for (const f of rows) {
    await transition(db, f, "cancel_unpaid", actor, actorUserId, reason, { cancel_reason: reason });
    await restock(db, f.id);
    cancelled++;
  }
  if (cancelled) {
    const now = utcnow();
    await db.execute("UPDATE payments SET status = 'failed', updated_at = ? WHERE order_id = ? AND status = 'created'", [
      now,
      orderId,
    ]);
    await db.execute(
      "UPDATE orders SET payment_status = 'failed', updated_at = ? WHERE id = ? AND payment_status IN ('pending', 'failed')",
      [now, orderId],
    );
  }
  return cancelled;
}

/** Release stock held by online orders that were never paid. Safe to run repeatedly. */
export async function expireUnpaidOrders(db: Db, ttlMinutes = UNPAID_TTL_MINUTES): Promise<number> {
  const cutoff = addMs(-ttlMinutes * MINUTE);
  const ids = (
    await db.all("SELECT DISTINCT order_id FROM fulfilments WHERE status = 'pending_payment' AND created_at <= ?", [cutoff])
  ).map((r) => r.order_id as number);
  let expired = 0;
  for (const orderId of ids) {
    const n = await db.transaction((tx) => cancelUnpaidOrder(tx, orderId, "system", null, "Payment not completed in time"));
    if (n) expired++;
  }
  return expired;
}

/** Fail with a state conflict before validating action-specific input. */
export function ensureCan(fulfilment: Row, action: string): void {
  const [allowed] = TRANSITIONS[action];
  if (!allowed.has(fulfilment.status)) {
    throw conflict(
      `This order is ${STATUS_LABEL[fulfilment.status].toLowerCase()} and can't be changed that way.`,
      "invalid_transition",
    );
  }
}

export async function restock(db: Db, fulfilmentId: number): Promise<void> {
  const items = await db.all("SELECT product_id, quantity FROM order_items WHERE fulfilment_id = ?", [fulfilmentId]);
  for (const item of items) {
    await db.execute("UPDATE products SET stock = stock + ?, sold_count = GREATEST(0, sold_count - ?) WHERE id = ?", [
      item.quantity,
      item.quantity,
      item.product_id,
    ]);
  }
}

/** Record a refund for a cancelled/returned fulfilment when the buyer had paid online. */
export async function refundFulfilment(db: Db, fulfilment: Row): Promise<number> {
  const order = await db.one("SELECT id, payment_status, total_paise FROM orders WHERE id = ? FOR UPDATE", [fulfilment.order_id]);
  if (!order) throw new Error("order missing");
  if (order.payment_status !== "paid" && order.payment_status !== "partially_refunded") return 0;
  const amount = Number(fulfilment.items_paise) + Number(fulfilment.shipping_paise);
  await db.execute("UPDATE fulfilments SET refund_paise = ? WHERE id = ?", [amount, fulfilment.id]);
  const refunded = Number(
    await db.scalar("SELECT COALESCE(SUM(refund_paise), 0) FROM fulfilments WHERE order_id = ?", [order.id]),
  );
  const status = refunded >= order.total_paise ? "refunded" : "partially_refunded";
  await db.execute("UPDATE orders SET payment_status = ?, updated_at = ? WHERE id = ?", [status, utcnow(), order.id]);
  return amount;
}

export function withinReturnWindow(fulfilment: Row, days: number): boolean {
  if (!fulfilment.delivered_at) return false;
  return new Date(fulfilment.delivered_at).getTime() + days * DAY >= Date.now();
}

// ---- order creation -----------------------------------------------------------------------------------

export async function orderNumber(db: Db): Promise<string> {
  const year = String(new Date().getUTCFullYear()).slice(-2);
  for (let i = 0; i < 5; i++) {
    const candidate = `PP${year}-${String(randomInt(10 ** 7)).padStart(7, "0")}`;
    if (!(await db.scalar("SELECT 1 FROM orders WHERE number = ?", [candidate]))) return candidate;
  }
  throw new Error("could not allocate order number");
}

export interface Address {
  full_name: string;
  phone: string;
  line1: string;
  line2: string | null;
  landmark: string | null;
  city: string;
  state: string;
  pincode: string;
}

/** Create an order from the buyer's cart. Must run inside a write transaction. */
export async function placeOrder(
  db: Db,
  settings: Settings,
  args: {
    buyerId: number;
    address: Address;
    paymentMethod: "cod" | "online";
    idempotencyKey: string;
    vehicleLabel: string | null;
  },
): Promise<number> {
  const { buyerId, address, paymentMethod, idempotencyKey, vehicleLabel } = args;
  // Serialise checkouts per buyer so a double-submit cannot create two orders.
  await db.query("SELECT pg_advisory_xact_lock(1, ?::int)", [buyerId]);
  const existing = await db.scalar("SELECT id FROM orders WHERE buyer_id = ? AND idempotency_key = ?", [buyerId, idempotencyKey]);
  if (existing) return Number(existing);
  const cart = await db.all("SELECT product_id, quantity FROM cart_items WHERE user_id = ? ORDER BY added_at", [buyerId]);
  if (!cart.length) throw badRequest("Your cart is empty.", "empty_cart");
  const quote = await buildQuote(
    db,
    settings,
    cart.map((c) => [c.product_id, c.quantity]),
  );
  if (quote.issues.length) {
    throw new ApiError(409, "cart_changed", "Some items in your cart changed. Review your cart and try again.");
  }
  const own = Number(
    await db.scalar(
      `SELECT COUNT(*) FROM products p JOIN sellers s ON s.id = p.seller_id WHERE s.user_id = ?
       AND p.id IN (${placeholders(cart)})`,
      [buyerId, ...cart.map((c) => c.product_id)],
    ),
  );
  if (own) throw badRequest("You can't buy your own listings.", "own_listing");

  // Reserve stock atomically; the WHERE clause makes overselling impossible.
  for (const group of quote.groups) {
    for (const line of group.lines) {
      const changed = await db.execute(
        "UPDATE products SET stock = stock - ?, sold_count = sold_count + ? WHERE id = ? AND stock >= ? AND status = 'active'",
        [line.quantity, line.quantity, line.product.id, line.quantity],
      );
      if (!changed) {
        throw new ApiError(409, "cart_changed", "Some items in your cart changed. Review your cart and try again.");
      }
    }
  }

  const rules = await getSettings(db, settings);
  const now = utcnow();
  const online = paymentMethod === "online";
  const orderId = await db.insert(
    `INSERT INTO orders (number, buyer_id, idempotency_key, ship_name, ship_phone, ship_line1, ship_line2,
         ship_landmark, ship_city, ship_state, ship_pincode, vehicle_label, items_paise, shipping_paise,
         total_paise, gst_paise, payment_method, payment_status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      await orderNumber(db),
      buyerId,
      idempotencyKey,
      address.full_name,
      address.phone,
      address.line1,
      address.line2,
      address.landmark,
      address.city,
      address.state,
      address.pincode,
      vehicleLabel,
      quote.itemsPaise,
      quote.shippingPaise,
      quote.totalPaise,
      quote.gstPaise,
      paymentMethod,
      online ? "pending" : "cod_due",
      now,
      now,
    ],
  );
  const status = online ? "pending_payment" : "placed";
  for (const group of quote.groups) {
    const commission = bpsOf(group.itemsPaise, rules.commission_bps);
    const taxable = group.itemsPaise - group.lines.reduce((s, l) => s + gstIncluded(l.total, l.product.gst_rate_bps), 0);
    const fulfilmentId = await db.insert(
      `INSERT INTO fulfilments (order_id, seller_id, status, items_paise, shipping_paise, commission_bps,
           commission_paise, tcs_paise, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        orderId,
        group.sellerId,
        status,
        group.itemsPaise,
        group.shippingPaise,
        rules.commission_bps,
        commission,
        bpsOf(taxable, settings.tcsBps),
        now,
        now,
      ],
    );
    for (const line of group.lines) {
      const p = line.product;
      await db.execute(
        `INSERT INTO order_items (fulfilment_id, product_id, title, brand, part_number, sku, unit_price_paise,
             quantity, gst_rate_bps, hsn_code, line_total_paise) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [fulfilmentId, p.id, p.title, p.brand, p.part_number, p.sku, p.price_paise, line.quantity, p.gst_rate_bps, p.hsn_code, line.total],
      );
    }
    await db.execute(
      "INSERT INTO fulfilment_events (fulfilment_id, status, note, actor_user_id, created_at) VALUES (?, ?, ?, ?, ?)",
      [fulfilmentId, status, null, buyerId, now],
    );
  }
  await db.execute("DELETE FROM cart_items WHERE user_id = ?", [buyerId]);
  if (online) await createPaymentIntent(db, orderId, quote.totalPaise);
  return orderId;
}

// ---- payments ---------------------------------------------------------------------------------------
// The test gateway stands in for a real provider (Razorpay is the intended production adapter).
// A provider adapter must: create an intent for an amount, and confirm outcomes only through a
// server-verified channel (signed webhook or server-to-server fetch), never trusting the browser.

export async function createPaymentIntent(db: Db, orderId: number, amountPaise: number, provider = "testpay"): Promise<string> {
  const intentId = `${provider}_${randomBytes(18).toString("base64url")}`;
  const now = utcnow();
  await db.execute(
    `INSERT INTO payments (order_id, provider, intent_id, amount_paise, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'created', ?, ?)`,
    [orderId, provider, intentId, amountPaise, now, now],
  );
  return intentId;
}

export async function settlePayment(
  db: Db,
  orderId: number,
  intentId: string,
  succeeded: boolean,
  actorUserId: number | null,
): Promise<void> {
  const payment = await db.one(
    "SELECT id, status, amount_paise FROM payments WHERE order_id = ? AND intent_id = ? FOR UPDATE",
    [orderId, intentId],
  );
  if (!payment) throw badRequest("Unknown payment.", "unknown_payment");
  if (payment.status !== "created") throw conflict("This payment was already processed.", "payment_processed");
  const order = await db.one("SELECT total_paise, payment_status FROM orders WHERE id = ?", [orderId]);
  if (!order) throw new Error("order missing");
  if (payment.amount_paise !== order.total_paise) throw conflict("Payment amount does not match the order.", "amount_mismatch");
  const now = utcnow();
  await db.execute("UPDATE payments SET status = ?, updated_at = ? WHERE id = ?", [succeeded ? "succeeded" : "failed", now, payment.id]);
  if (succeeded) {
    await db.execute("UPDATE orders SET payment_status = 'paid', payment_ref = ?, updated_at = ? WHERE id = ?", [intentId, now, orderId]);
    for (const f of await db.all("SELECT * FROM fulfilments WHERE order_id = ? AND status = 'pending_payment'", [orderId])) {
      await transition(db, f, "pay", "system", actorUserId, "Payment received");
    }
  } else {
    await db.execute("UPDATE orders SET payment_status = 'failed', updated_at = ? WHERE id = ?", [now, orderId]);
  }
}
