// Notifications: who is told what on each order event, the bell API, push-device registration and
// the push outbox worker (retry, give up, dead tokens, not configured).
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Db } from "../src/db.js";
import { MAX_ATTEMPTS, type PushMessage, type PushResult, type PushSender, processPushOutbox } from "../src/services/push.js";
import { ADMIN, BUYER, BUYER_2, type Client, SELLER_A, SELLER_B, type TestEnv, checkout, productFor, setup } from "./helpers.js";

async function withEnv(fn: (env: TestEnv) => Promise<void>) {
  const env = await setup();
  try {
    await fn(env);
  } finally {
    await env.close();
  }
}

const uid = async (db: Db, email: string) => Number(await db.scalar("SELECT id FROM users WHERE email = ?", [email]));

/** Notifications of one user created after `afterId`, oldest first. */
async function noticesFor(db: Db, email: string, afterId: number) {
  return db.all("SELECT kind, title, body, link FROM notifications WHERE user_id = ? AND id > ? ORDER BY id", [
    await uid(db, email),
    afterId,
  ]);
}

const lastId = async (db: Db) => Number((await db.scalar("SELECT COALESCE(MAX(id), 0) FROM notifications")) ?? 0);

let keyCounter = 0;
async function order(env: TestEnv, buyer: Client, sellers: string[], method = "cod") {
  for (const s of sellers) {
    const product = await productFor(env.db, s);
    await buyer.put(`/api/cart/items/${product.id}`, { quantity: 1 });
  }
  const res = await checkout(buyer, method, `notify-key-${Date.now()}-${++keyCounter}-abcdefgh`);
  assert.equal(res.status, 201, res.text);
  return res.body.data;
}

const token = (n: number | string) => `fcm-test-token-${n}-${"x".repeat(30)}`;

class FakeSender implements PushSender {
  sent: PushMessage[] = [];
  constructor(private readonly reply: (m: PushMessage) => PushResult = () => ({ ok: true })) {}
  async send(m: PushMessage) {
    this.sent.push(m);
    return this.reply(m);
  }
}

test("COD order: buyer gets a confirmation, each seller a new-order alert", () =>
  withEnv(async (env) => {
    const since = await lastId(env.db);
    const buyer = await env.client(BUYER);
    const o = await order(env, buyer, [SELLER_A[0], SELLER_B[0]]);

    const mine = await noticesFor(env.db, BUYER[0], since);
    assert.equal(mine.length, 1, "one confirmation per order, not per seller");
    assert.equal(mine[0]!.kind, "order_placed");
    assert.match(mine[0]!.body, new RegExp(o.number));
    assert.equal(mine[0]!.link, `/orders/${o.id}`);

    for (const seller of [SELLER_A[0], SELLER_B[0]]) {
      const alerts = await noticesFor(env.db, seller, since);
      assert.equal(alerts.length, 1);
      assert.equal(alerts[0]!.kind, "seller_new_order");
      assert.match(alerts[0]!.link, /^\/seller\/orders\/\d+$/);
    }
  }));

test("online order: nothing until paid, then one confirmation", () =>
  withEnv(async (env) => {
    const since = await lastId(env.db);
    const buyer = await env.client(BUYER);
    const o = await order(env, buyer, [SELLER_A[0], SELLER_B[0]], "online");
    assert.equal((await env.db.scalar("SELECT COUNT(*) FROM notifications WHERE id > ?", [since])), 0);

    const paid = await buyer.post(`/api/orders/${o.id}/payment/confirm`, { intent_id: o.payment.intent_id, outcome: "success" });
    assert.equal(paid.status, 200, paid.text);
    assert.deepEqual((await noticesFor(env.db, BUYER[0], since)).map((n) => n.kind), ["order_placed"]);
    assert.equal((await noticesFor(env.db, SELLER_A[0], since)).length, 1);
    assert.equal((await noticesFor(env.db, SELLER_B[0], since)).length, 1);
  }));

test("ship, deliver, return: the buyer and seller are told at each step", () =>
  withEnv(async (env) => {
    const buyer = await env.client(BUYER);
    const seller = await env.client(SELLER_A);
    const o = await order(env, buyer, [SELLER_A[0]]);
    const fid = o.fulfilments[0].id;
    const since = await lastId(env.db);

    assert.equal((await seller.post(`/api/seller/orders/${fid}/pack`, {})).status, 200);
    assert.equal((await noticesFor(env.db, BUYER[0], since)).length, 0, "packing is not announced");
    assert.equal((await seller.post(`/api/seller/orders/${fid}/ship`, { carrier: "Delhivery", tracking_number: "DL99887766" })).status, 200);
    assert.equal((await seller.post(`/api/seller/orders/${fid}/deliver`, {})).status, 200);

    const buyerNotes = await noticesFor(env.db, BUYER[0], since);
    assert.deepEqual(buyerNotes.map((n) => n.kind), ["order_shipped", "order_delivered"]);
    assert.match(buyerNotes[0]!.body, /Delhivery/);
    assert.match(buyerNotes[0]!.body, /DL99887766/);

    const ret = await buyer.post(`/api/orders/${o.id}/fulfilments/${fid}/return`, { reason: "Wrong size for my car" });
    assert.equal(ret.status, 200, ret.text);
    const sellerNotes = await noticesFor(env.db, SELLER_A[0], since);
    assert.equal(sellerNotes.at(-1)!.kind, "seller_return_requested");
    assert.match(sellerNotes.at(-1)!.body, /Wrong size for my car/);

    assert.equal((await seller.post(`/api/seller/orders/${fid}/accept_return`, {})).status, 200);
    assert.equal((await noticesFor(env.db, BUYER[0], since)).at(-1)!.kind, "return_accepted");
  }));

test("cancellations notify the other side", () =>
  withEnv(async (env) => {
    const buyer = await env.client(BUYER);
    const seller = await env.client(SELLER_A);

    const first = await order(env, buyer, [SELLER_A[0]]);
    let since = await lastId(env.db);
    const cancel = await buyer.post(`/api/orders/${first.id}/fulfilments/${first.fulfilments[0].id}/cancel`, { reason: "Ordered by mistake" });
    assert.equal(cancel.status, 200, cancel.text);
    const toSeller = await noticesFor(env.db, SELLER_A[0], since);
    assert.equal(toSeller.length, 1);
    assert.equal(toSeller[0]!.kind, "seller_order_cancelled");
    assert.equal((await noticesFor(env.db, BUYER[0], since)).length, 0, "the buyer did it themselves");

    const second = await order(env, buyer, [SELLER_A[0]]);
    since = await lastId(env.db);
    const res = await seller.post(`/api/seller/orders/${second.fulfilments[0].id}/cancel`, { reason: "Out of stock" });
    assert.equal(res.status, 200, res.text);
    const toBuyer = await noticesFor(env.db, BUYER[0], since);
    assert.equal(toBuyer.length, 1);
    assert.equal(toBuyer[0]!.kind, "order_cancelled");
    assert.match(toBuyer[0]!.body, /Out of stock/);
  }));

test("bell API: list, unread count, mark read; users only see and change their own", () =>
  withEnv(async (env) => {
    const buyer = await env.client(BUYER);
    await env.db.execute("UPDATE notifications SET read_at = now()");
    await order(env, buyer, [SELLER_A[0]]);
    await order(env, buyer, [SELLER_A[0]]);

    assert.equal((await buyer.get("/api/notifications/unread")).body.data.count, 2);
    const list = (await buyer.get("/api/notifications?per_page=1")).body.data;
    assert.equal(list.items.length, 1);
    assert.equal(list.unread, 2);
    assert.equal(list.items[0].read, false);
    const newest = list.items[0].id;

    // Another user cannot mark someone else's notification read.
    const other = await env.client(BUYER_2);
    await other.post("/api/notifications/read", { ids: [newest] });
    assert.equal((await buyer.get("/api/notifications/unread")).body.data.count, 2);
    assert.ok(!(await other.get("/api/notifications")).body.data.items.some((n: { id: number }) => n.id === newest));

    assert.equal((await buyer.post("/api/notifications/read", { ids: [newest] })).body.data.unread, 1);
    assert.equal((await buyer.post("/api/notifications/read", {})).body.data.unread, 0);

    const anonymous = await env.client();
    assert.equal((await anonymous.get("/api/notifications")).status, 401);
    assert.equal((await anonymous.post("/api/push/devices", { token: token(1), platform: "android" })).status, 401);
  }));

test("push devices: a token follows the latest user; ten devices per user at most", () =>
  withEnv(async (env) => {
    const buyer = await env.client(BUYER);
    const other = await env.client(BUYER_2);
    assert.equal((await buyer.post("/api/push/devices", { token: token("shared"), platform: "android" })).status, 200);
    assert.equal((await other.post("/api/push/devices", { token: token("shared"), platform: "android" })).status, 200);
    assert.equal(Number(await env.db.scalar("SELECT user_id FROM push_devices WHERE token = ?", [token("shared")])), await uid(env.db, BUYER_2[0]));

    for (let i = 0; i < 12; i++) await buyer.post("/api/push/devices", { token: token(`b${i}`), platform: "ios" });
    assert.equal(Number(await env.db.scalar("SELECT COUNT(*) FROM push_devices WHERE user_id = ?", [await uid(env.db, BUYER[0])])), 10);

    assert.equal((await buyer.post("/api/push/devices", { token: "short", platform: "android" })).status, 422);
    assert.equal((await buyer.post("/api/push/devices", { token: token(1), platform: "windows" })).status, 422);

    await buyer.post("/api/push/devices/remove", { token: token("b11") });
    assert.equal(await env.db.scalar("SELECT COUNT(*) FROM push_devices WHERE token = ?", [token("b11")]), 0);
  }));

test("push outbox: one push per phone, sent once, even with two workers", () =>
  withEnv(async (env) => {
    const buyer = await env.client(BUYER);
    await env.db.execute("DELETE FROM push_outbox");
    await buyer.post("/api/push/devices", { token: token("phone"), platform: "android" });
    await buyer.post("/api/push/devices", { token: token("tablet"), platform: "ios" });
    await order(env, buyer, [SELLER_A[0]]);
    assert.equal(await env.db.scalar("SELECT COUNT(*) FROM push_outbox WHERE status = 'pending'"), 2);

    const sender = new FakeSender();
    await Promise.all([processPushOutbox(env.database, sender), processPushOutbox(env.database, sender)]);
    assert.equal(sender.sent.length, 2, "two workers never send the same row");
    assert.deepEqual(sender.sent.map((m) => m.token).sort(), [token("phone"), token("tablet")].sort());
    assert.equal(sender.sent[0]!.title, "Order confirmed");
    assert.match(sender.sent[0]!.link ?? "", /^\/orders\/\d+$/);
    assert.equal(await env.db.scalar("SELECT COUNT(*) FROM push_outbox WHERE status = 'sent'"), 2);

    await processPushOutbox(env.database, sender);
    assert.equal(sender.sent.length, 2, "nothing is sent twice");
  }));

test("push outbox: temporary failures retry with backoff, then give up", () =>
  withEnv(async (env) => {
    const buyer = await env.client(BUYER);
    await env.db.execute("DELETE FROM push_outbox");
    await buyer.post("/api/push/devices", { token: token("flaky"), platform: "android" });
    await order(env, buyer, [SELLER_A[0]]);
    const sender = new FakeSender(() => ({ ok: false, retry: true, error: "FCM 503" }));

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      await processPushOutbox(env.database, sender);
      const row = (await env.db.one("SELECT status, attempts, last_error, next_attempt_at > now() AS later FROM push_outbox"))!;
      assert.equal(row.attempts, attempt);
      assert.equal(row.last_error, "FCM 503");
      assert.equal(row.status, attempt < MAX_ATTEMPTS ? "pending" : "failed");
      if (attempt < MAX_ATTEMPTS) {
        assert.equal(row.later, true, "waits before retrying");
        await processPushOutbox(env.database, sender);
        assert.equal(sender.sent.length, attempt, "not retried before its time");
        await env.db.execute("UPDATE push_outbox SET next_attempt_at = now()");
      }
    }
    await processPushOutbox(env.database, sender);
    assert.equal(sender.sent.length, MAX_ATTEMPTS);
  }));

test("push outbox: an uninstalled app's token is removed; unconfigured push is skipped", () =>
  withEnv(async (env) => {
    const buyer = await env.client(BUYER);
    await env.db.execute("DELETE FROM push_outbox");
    await buyer.post("/api/push/devices", { token: token("gone"), platform: "android" });
    await order(env, buyer, [SELLER_A[0]]);
    await order(env, buyer, [SELLER_A[0]]);
    await processPushOutbox(env.database, new FakeSender(() => ({ ok: false, invalidToken: true, retry: false, error: "FCM 404" })));
    assert.equal(await env.db.scalar("SELECT COUNT(*) FROM push_devices WHERE token = ?", [token("gone")]), 0);
    assert.equal(await env.db.scalar("SELECT COUNT(*) FROM push_outbox"), 0, "its queued pushes go with it");

    await buyer.post("/api/push/devices", { token: token("later"), platform: "android" });
    await order(env, buyer, [SELLER_A[0]]);
    await processPushOutbox(env.database, null);
    assert.equal(await env.db.scalar("SELECT status FROM push_outbox"), "skipped");
  }));

test("admins can use the bell too", () =>
  withEnv(async (env) => {
    const admin = await env.client(ADMIN);
    assert.equal((await admin.get("/api/notifications/unread")).status, 200);
  }));
