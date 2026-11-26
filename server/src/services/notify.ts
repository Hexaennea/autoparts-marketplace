// Order notifications for buyers and sellers.
//
// notify() writes the in-app notification (the bell list) and queues one push per registered phone
// (push_outbox). It runs inside the caller's transaction, so a notification exists exactly when the
// order change that caused it was committed. Pushing happens later, in the outbox worker (push.ts),
// so a slow or failing push service can never fail or slow down an order.
//
// Messages are written here, in one place, so wording stays consistent across web and app.

import type { Db, Row } from "../db.js";

export interface Notice {
  kind: string;
  title: string;
  body: string;
  link: string | null;
}

let outboxDirty = false;
let kicker: (() => void) | null = null;

/** jobs.ts registers the push worker's "run now" here (nothing is registered in tests). */
export function setOutboxKicker(fn: (() => void) | null): void {
  kicker = fn;
}

/**
 * Called by http.ts after a write request commits: if it queued pushes, wake the worker now
 * instead of waiting for its next 15-second pass. (Before commit the worker could not see them.)
 */
export function kickOutboxIfDirty(): void {
  if (!outboxDirty) return;
  outboxDirty = false;
  kicker?.();
}

/** Store a notification for one user and queue it for each of their phones. */
export async function notify(db: Db, userId: number, n: Notice): Promise<number> {
  const id = await db.insert("INSERT INTO notifications (user_id, kind, title, body, link) VALUES (?, ?, ?, ?, ?)", [
    userId,
    n.kind,
    n.title.slice(0, 120),
    n.body.slice(0, 500),
    n.link,
  ]);
  const queued = await db.execute(
    "INSERT INTO push_outbox (notification_id, device_id) SELECT ?, id FROM push_devices WHERE user_id = ?",
    [id, userId],
  );
  if (queued) outboxDirty = true;
  return id;
}

const inr = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 2 });
const rupees = (paise: number) => `₹${inr.format(Number(paise) / 100)}`;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Order, seller and buyer details needed to word a message about one shipment. */
async function shipmentContext(db: Db, fulfilmentId: number) {
  return db.one(
    `SELECT f.id, f.order_id, f.items_paise, f.shipping_paise, f.carrier, f.tracking_number,
            o.number, o.buyer_id, o.payment_method,
            s.user_id AS seller_user_id, s.display_name AS seller_name,
            (SELECT COALESCE(SUM(quantity), 0) FROM order_items WHERE fulfilment_id = f.id) AS units
     FROM fulfilments f JOIN orders o ON o.id = f.order_id JOIN sellers s ON s.id = f.seller_id
     WHERE f.id = ?`,
    [fulfilmentId],
  );
}

/**
 * A new order is live (COD at checkout, or online once paid): confirm to the buyer once, and tell
 * each seller about their part. Shipments still awaiting payment are skipped.
 */
export async function orderPlacedNotices(db: Db, orderId: number): Promise<void> {
  const order = await db.one("SELECT id, number, buyer_id, total_paise, payment_method FROM orders WHERE id = ?", [orderId]);
  if (!order) return;
  const shipments = await db.all("SELECT id FROM fulfilments WHERE order_id = ? AND status = 'placed' ORDER BY id", [orderId]);
  if (!shipments.length) return;
  const payment = order.payment_method === "cod" ? "Cash on delivery" : "Paid online";
  await notify(db, order.buyer_id, {
    kind: "order_placed",
    title: "Order confirmed",
    body: `Order ${order.number} is confirmed. Total ${rupees(order.total_paise)} · ${payment}. We'll tell you when it ships.`,
    link: `/orders/${order.id}`,
  });
  for (const s of shipments) {
    const c = await shipmentContext(db, s.id);
    if (!c) continue;
    await notify(db, c.seller_user_id, {
      kind: "seller_new_order",
      title: `New order ${c.number}`,
      body: `${plural(Number(c.units), "item")} · ${rupees(c.items_paise + c.shipping_paise)} · ${c.payment_method === "cod" ? "COD" : "Prepaid"}. Pack within a day and ship within two.`,
      link: `/seller/orders/${c.id}`,
    });
  }
}

/** The buyer's online payment never arrived, so the whole order was cancelled by the system. */
export async function unpaidCancelledNotice(db: Db, orderId: number): Promise<void> {
  const order = await db.one("SELECT id, number, buyer_id FROM orders WHERE id = ?", [orderId]);
  if (!order) return;
  await notify(db, order.buyer_id, {
    kind: "order_cancelled",
    title: "Order cancelled",
    body: `Payment for order ${order.number} wasn't completed in time, so it was cancelled. Nothing was charged.`,
    link: `/orders/${order.id}`,
  });
}

/**
 * A shipment changed state (see TRANSITIONS in commerce.ts). Called after the row was updated, so
 * carrier and tracking number are current. `note` is the reason given, if any. Actions with no
 * message (pack, pay, cancel_unpaid) are ignored.
 */
export async function shipmentNotice(db: Db, fulfilment: Row, action: string, note: string | null): Promise<void> {
  if (!["ship", "deliver", "cancel_buyer", "cancel_seller", "request_return", "accept_return", "reject_return"].includes(action)) {
    return;
  }
  const c = await shipmentContext(db, fulfilment.id);
  if (!c) return;
  const buyerLink = `/orders/${c.order_id}`;
  const sellerLink = `/seller/orders/${c.id}`;
  const reason = note?.trim() ? ` Reason: ${note.trim()}` : "";
  switch (action) {
    case "ship":
      await notify(db, c.buyer_id, {
        kind: "order_shipped",
        title: "Your order is on the way",
        body:
          `${c.seller_name} shipped your parts from order ${c.number}` +
          `${c.carrier ? ` via ${c.carrier}` : ""}${c.tracking_number ? ` (tracking ${c.tracking_number})` : ""}. ` +
          "Your GST invoice is ready on the order page.",
        link: buyerLink,
      });
      break;
    case "deliver":
      await notify(db, c.buyer_id, {
        kind: "order_delivered",
        title: "Delivered",
        body: `Your parts from ${c.seller_name} (order ${c.number}) were delivered. If something doesn't fit, you can request a return from the order page.`,
        link: buyerLink,
      });
      break;
    case "cancel_buyer":
      await notify(db, c.seller_user_id, {
        kind: "seller_order_cancelled",
        title: `Order ${c.number} cancelled`,
        body: `The buyer cancelled this order. Don't pack or ship it.${reason}`,
        link: sellerLink,
      });
      break;
    case "cancel_seller":
      await notify(db, c.buyer_id, {
        kind: "order_cancelled",
        title: "Part of your order was cancelled",
        body: `${c.seller_name} cancelled their items in order ${c.number}.${reason} Any online payment for them will be refunded.`,
        link: buyerLink,
      });
      break;
    case "request_return":
      await notify(db, c.seller_user_id, {
        kind: "seller_return_requested",
        title: `Return requested · ${c.number}`,
        body: `The buyer wants to return this shipment.${reason} Arrange pickup and accept or decline the return.`,
        link: sellerLink,
      });
      break;
    case "accept_return":
      await notify(db, c.buyer_id, {
        kind: "return_accepted",
        title: "Return accepted",
        body: `${c.seller_name} accepted your return for order ${c.number}. Refund details are on the order page.`,
        link: buyerLink,
      });
      break;
    case "reject_return":
      await notify(db, c.buyer_id, {
        kind: "return_declined",
        title: "Return declined",
        body: `${c.seller_name} declined your return for order ${c.number}.${reason} Contact support if you disagree.`,
        link: buyerLink,
      });
      break;
  }
}
