// Port of backend/tests/test_commerce.py
import assert from "node:assert/strict";
import { test } from "node:test";
import { expireUnpaidOrders } from "../src/services/commerce.js";
import { roundHalfEven } from "../src/util.js";
import {
  ADMIN,
  BUYER,
  BUYER_2,
  type Client,
  SELLER_A,
  SELLER_B,
  type TestEnv,
  addressId,
  checkout,
  productFor,
  setup,
} from "./helpers.js";

async function withEnv(fn: (env: TestEnv) => Promise<void>, overrides = {}) {
  const env = await setup(overrides);
  try {
    await fn(env);
  } finally {
    await env.close();
  }
}

function add(client: Client, productId: number, quantity = 1) {
  return client.put(`/api/cart/items/${productId}`, { quantity });
}

const stockOf = (env: TestEnv, id: number) => env.db.scalar("SELECT stock FROM products WHERE id = ?", [id]);

test("cart prices come from server", () =>
  withEnv(async (env) => {
    const buyer = await env.client(BUYER);
    const product = await productFor(env.db, SELLER_A[0]);
    const res = await buyer.put(`/api/cart/items/${product.id}`, { quantity: 2, price_paise: 1 });
    assert.equal(res.status, 200);
    const line = res.body.data.groups[0].lines[0];
    assert.equal(line.price_paise, product.price_paise);
    assert.equal(res.body.data.summary.items_paise, product.price_paise * 2);
  }));

test("quantity capped by stock and limits", () =>
  withEnv(async (env) => {
    const buyer = await env.client(BUYER);
    const product = await productFor(env.db, SELLER_A[0]);
    await env.db.execute("UPDATE products SET stock = 2 WHERE id = ?", [product.id]);
    const res = await add(buyer, product.id, 5);
    assert.equal(res.body.data.groups[0].lines[0].quantity, 2);
    assert.equal((await add(buyer, product.id, 21)).status, 422);
    assert.equal((await add(buyer, 99999999)).status, 404);
  }));

test("guest preview and merge", () =>
  withEnv(async (env) => {
    const anon = await env.client();
    const product = await productFor(env.db, SELLER_A[0]);
    const preview = await anon.post("/api/cart/preview", { items: [{ product_id: product.id, quantity: 1 }] });
    assert.equal(preview.status, 200);
    assert.equal(preview.body.data.summary.items_paise, product.price_paise);
    await anon.login(...BUYER_2);
    const merged = await anon.post("/api/cart/merge", { items: [{ product_id: product.id, quantity: 1 }] });
    assert.equal(merged.body.data.summary.item_count, 1);
  }));

test("cod checkout end to end", () =>
  withEnv(async (env) => {
    const buyer = await env.client(BUYER);
    const a = await productFor(env.db, SELLER_A[0]);
    const b = await productFor(env.db, SELLER_B[0]);
    await add(buyer, a.id, 2);
    await add(buyer, b.id, 1);
    const res = await checkout(buyer);
    assert.equal(res.status, 201, res.text);
    const order = res.body.data;
    assert.equal(order.payment_status, "cod_due");
    assert.equal(order.fulfilments.length, 2);
    assert.ok(order.fulfilments.every((f: any) => f.status === "placed"));
    assert.equal(order.items_paise, a.price_paise * 2 + b.price_paise);
    assert.equal(order.total_paise, order.items_paise + order.shipping_paise);
    assert.ok(order.gst_paise > 0);
    assert.equal(await stockOf(env, a.id), a.stock - 2);
    assert.deepEqual((await buyer.get("/api/cart")).body.data.groups, []);
  }));

test("shipping rule per seller", () =>
  withEnv(async (env) => {
    const buyer = await env.client(BUYER);
    const cheap = (await env.db.one(
      "SELECT p.* FROM products p JOIN sellers s ON s.id = p.seller_id WHERE s.kyc_status = 'approved' AND p.status = 'active' AND p.stock > 3 AND p.price_paise < 50000 LIMIT 1",
    ))!;
    await add(buyer, cheap.id, 1);
    const cart = (await buyer.get("/api/cart")).body.data;
    assert.equal(cart.groups[0].shipping_paise, 7900);
    assert.equal(cart.groups[0].free_shipping_remaining_paise, 99900 - cheap.price_paise);
  }));

test("checkout is idempotent", () =>
  withEnv(async (env) => {
    const buyer = await env.client(BUYER);
    const product = await productFor(env.db, SELLER_A[0]);
    await add(buyer, product.id, 1);
    const first = await checkout(buyer, "cod", "same-key-aaaaaaaaaaaa");
    const second = await checkout(buyer, "cod", "same-key-aaaaaaaaaaaa");
    assert.ok(first.status === 201 && second.status === 201);
    assert.equal(first.body.data.id, second.body.data.id);
    assert.equal(await stockOf(env, product.id), product.stock - 1);
  }));

test("checkout rejects changed cart", () =>
  withEnv(async (env) => {
    const buyer = await env.client(BUYER);
    const product = await productFor(env.db, SELLER_A[0]);
    await add(buyer, product.id, 2);
    await env.db.execute("UPDATE products SET stock = 1 WHERE id = ?", [product.id]);
    const res = await checkout(buyer);
    assert.ok(res.status === 409 && res.body.error.code === "cart_changed");
    assert.equal(await stockOf(env, product.id), 1);
    const stranger = await env.client();
    assert.equal(
      (await stranger.post("/api/orders", { address_id: 1, payment_method: "cod", idempotency_key: "k".repeat(20) }))
        .status,
      401,
    );
  }));

test("empty cart and bad address", () =>
  withEnv(async (env) => {
    const buyer = await env.client(BUYER);
    let res = await checkout(buyer);
    assert.ok(res.status === 400 && res.body.error.code === "empty_cart");
    const other = await env.client(BUYER_2);
    const foreign = await addressId(other);
    res = await buyer.post("/api/orders", { address_id: foreign, payment_method: "cod", idempotency_key: "k".repeat(20) });
    assert.equal(res.status, 422);
  }));

test("no overselling under concurrency", () =>
  withEnv(async (env) => {
    const product = await productFor(env.db, SELLER_A[0]);
    await env.db.execute("UPDATE products SET stock = 1 WHERE id = ?", [product.id]);
    const shoppers = [await env.client(BUYER), await env.client(BUYER_2)];
    for (const s of shoppers) {
      await addressId(s);
      assert.equal((await add(s, product.id, 1)).status, 200);
    }
    const results = await Promise.all(
      shoppers.map(async (s, n) => (await checkout(s, "cod", `race-key-${String(n).padStart(12, "0")}`)).status),
    );
    assert.deepEqual(
      [...results].sort((x, y) => x - y),
      [201, 409],
    );
    assert.equal(await stockOf(env, product.id), 0);
  }));

test("online payment flow", () =>
  withEnv(async (env) => {
    const buyer = await env.client(BUYER);
    const product = await productFor(env.db, SELLER_A[0]);
    await add(buyer, product.id, 1);
    const order = (await checkout(buyer, "online")).body.data;
    assert.equal(order.payment_status, "pending");
    assert.equal(order.fulfilments[0].status, "pending_payment");
    const intent = order.payment.intent_id;
    const url = `/api/orders/${order.id}/payment/confirm`;
    const failed = (await buyer.post(url, { intent_id: intent, outcome: "failure" })).body.data;
    assert.equal(failed.payment_status, "failed");
    const retried = (await buyer.post(`/api/orders/${order.id}/payment/retry`)).body.data;
    const newIntent = retried.payment.intent_id;
    assert.notEqual(newIntent, intent);
    const paid = (await buyer.post(url, { intent_id: newIntent, outcome: "success" })).body.data;
    assert.equal(paid.payment_status, "paid");
    assert.equal(paid.fulfilments[0].status, "placed");
    const replay = await buyer.post(url, { intent_id: newIntent, outcome: "success" });
    assert.equal(replay.status, 409);
    assert.equal((await buyer.post(url, { intent_id: "testpay_forged_value", outcome: "success" })).status, 400);
  }));

test("test payments disabled outside test mode", () =>
  withEnv(
    async (env) => {
      const client = await env.client(BUYER);
      const res = await client.post("/api/orders/1/payment/confirm", { intent_id: "testpay_123456789", outcome: "success" });
      assert.equal(res.status, 403);
    },
    { paymentsTestMode: false },
  ));

test("buyer cancel restocks and refunds", () =>
  withEnv(async (env) => {
    const buyer = await env.client(BUYER);
    const product = await productFor(env.db, SELLER_A[0]);
    await add(buyer, product.id, 1);
    const order = (await checkout(buyer, "online")).body.data;
    await buyer.post(`/api/orders/${order.id}/payment/confirm`, { intent_id: order.payment.intent_id, outcome: "success" });
    const f = order.fulfilments[0];
    const res = await buyer.post(`/api/orders/${order.id}/fulfilments/${f.id}/cancel`, { reason: "Found it locally" });
    assert.equal(res.status, 200, res.text);
    const data = res.body.data;
    assert.equal(data.fulfilments[0].status, "cancelled");
    assert.equal(data.payment_status, "refunded");
    assert.equal(await stockOf(env, product.id), product.stock);
    const again = await buyer.post(`/api/orders/${order.id}/fulfilments/${f.id}/cancel`, { reason: "again" });
    assert.equal(again.status, 409);
  }));

test("cannot buy own listing", () =>
  withEnv(async (env) => {
    const sellerAsBuyer = await env.client(SELLER_A);
    const product = await productFor(env.db, SELLER_A[0]);
    const res = await add(sellerAsBuyer, product.id, 1);
    assert.ok(res.status === 400 && res.body.error.code === "own_listing");
  }));

test("full fulfilment lifecycle returns reviews and payouts", () =>
  withEnv(async (env) => {
    const db = env.db;
    const buyer = await env.client(BUYER);
    const seller = await env.client(SELLER_A);
    const admin = await env.client(ADMIN);
    const product = await productFor(db, SELLER_A[0]);
    await add(buyer, product.id, 1);
    const order = (await checkout(buyer)).body.data;
    const fid = order.fulfilments[0].id;

    assert.equal((await seller.post(`/api/seller/orders/${fid}/ship`, {})).status, 409); // must pack first
    assert.equal((await seller.post(`/api/seller/orders/${fid}/pack`, {})).status, 200);
    const missing = await seller.post(`/api/seller/orders/${fid}/ship`, {});
    assert.ok(missing.status === 422 && "tracking_number" in missing.body.error.fields);
    const shipped = await seller.post(`/api/seller/orders/${fid}/ship`, {
      carrier: "Delhivery",
      tracking_number: "DL1234567890",
    });
    assert.equal(shipped.body.data.status, "shipped");
    assert.equal(
      (await buyer.post(`/api/orders/${order.id}/fulfilments/${fid}/cancel`, { reason: "too late" })).status,
      409,
    );

    const review = { rating: 5, title: "Perfect fit", body: "Fitted in ten minutes, exact match." };
    assert.equal((await buyer.post(`/api/products/${product.id}/reviews`, review)).status, 403); // not delivered yet
    assert.equal((await seller.post(`/api/seller/orders/${fid}/deliver`, {})).body.data.status, "delivered");
    assert.equal(await db.scalar("SELECT payment_status FROM orders WHERE id = ?", [order.id]), "cod_collected");
    assert.equal((await buyer.post(`/api/products/${product.id}/reviews`, review)).status, 201);
    assert.equal((await buyer.post(`/api/products/${product.id}/reviews`, review)).status, 409);
    assert.ok((await db.scalar("SELECT rating_count FROM products WHERE id = ?", [product.id])) >= 1);

    // Not yet payable: still inside the return window.
    const sellerId = await db.scalar("SELECT seller_id FROM fulfilments WHERE id = ?", [fid]);
    const holding = (await seller.get("/api/seller/payouts")).body.data;
    assert.ok(holding.holding.some((line: any) => line.id === fid));
    await db.execute("UPDATE fulfilments SET delivered_at = now() - interval '30 days' WHERE id = ?", [fid]);
    const line = (await seller.get("/api/seller/payouts")).body.data.eligible.find((r: any) => r.id === fid);
    assert.ok(line);
    const f = (await db.one("SELECT * FROM fulfilments WHERE id = ?", [fid]))!;
    assert.equal(line.net_paise, f.items_paise + f.shipping_paise - f.commission_paise - f.tcs_paise);
    assert.equal(f.commission_paise, roundHalfEven(f.items_paise * 0.08));

    const payout = await admin.post("/api/admin/payouts", { seller_id: sellerId });
    assert.equal(payout.status, 201, payout.text);
    assert.equal(await db.scalar("SELECT payout_id FROM fulfilments WHERE id = ?", [fid]), payout.body.data.id);
    assert.equal((await admin.post("/api/admin/payouts", { seller_id: sellerId })).status, 409);
  }));

const DELIVERY_STEPS: Array<[string, object]> = [
  ["pack", {}],
  ["ship", { carrier: "DTDC", tracking_number: "DT99887766" }],
  ["deliver", {}],
];

test("return flow", () =>
  withEnv(async (env) => {
    const buyer = await env.client(BUYER);
    const seller = await env.client(SELLER_A);
    const product = await productFor(env.db, SELLER_A[0]);
    await add(buyer, product.id, 1);
    const order = (await checkout(buyer)).body.data;
    const fid = order.fulfilments[0].id;
    for (const [action, body] of DELIVERY_STEPS) {
      assert.equal((await seller.post(`/api/seller/orders/${fid}/${action}`, body)).status, 200);
    }
    const stockBefore = await stockOf(env, product.id);
    const res = await buyer.post(`/api/orders/${order.id}/fulfilments/${fid}/return`, { reason: "Wrong connector" });
    assert.equal(res.body.data.fulfilments[0].status, "return_requested");
    assert.equal((await seller.post(`/api/seller/orders/${fid}/reject_return`, {})).status, 422);
    assert.equal((await seller.post(`/api/seller/orders/${fid}/accept_return`, {})).body.data.status, "returned");
    assert.equal(await stockOf(env, product.id), stockBefore + 1);
  }));

test("return window enforced", () =>
  withEnv(async (env) => {
    const buyer = await env.client(BUYER);
    const seller = await env.client(SELLER_A);
    const product = await productFor(env.db, SELLER_A[0]);
    await add(buyer, product.id, 1);
    const order = (await checkout(buyer)).body.data;
    const fid = order.fulfilments[0].id;
    for (const [action, body] of DELIVERY_STEPS) {
      await seller.post(`/api/seller/orders/${fid}/${action}`, body);
    }
    await env.db.execute("UPDATE fulfilments SET delivered_at = now() - interval '9 days' WHERE id = ?", [fid]);
    const res = await buyer.post(`/api/orders/${order.id}/fulfilments/${fid}/return`, { reason: "Changed my mind" });
    assert.ok(res.status === 409 && res.body.error.code === "return_window_closed");
  }));

test("commission setting applies to new orders", () =>
  withEnv(async (env) => {
    const buyer = await env.client(BUYER);
    const admin = await env.client(ADMIN);
    const current = (await admin.get("/api/admin/settings")).body.data;
    const res = await admin.put("/api/admin/settings", { ...current, commission_bps: 1000 });
    assert.ok(res.status === 200 && res.body.data.commission_bps === 1000);
    const product = await productFor(env.db, SELLER_A[0]);
    await add(buyer, product.id, 1);
    const order = (await checkout(buyer)).body.data;
    const f = (await env.db.one("SELECT * FROM fulfilments WHERE order_id = ?", [order.id]))!;
    assert.ok(f.commission_bps === 1000 && f.commission_paise === roundHalfEven(f.items_paise * 0.1));
    assert.equal(await env.db.scalar("SELECT COUNT(*) FROM audit_log WHERE action = 'settings.updated'"), 1);
  }));

test("cancelling an unpaid order cancels all of it", () =>
  withEnv(async (env) => {
    const buyer = await env.client(BUYER);
    const a = await productFor(env.db, SELLER_A[0]);
    const b = await productFor(env.db, SELLER_B[0]);
    await add(buyer, a.id, 1);
    await add(buyer, b.id, 1);
    const order = (await checkout(buyer, "online")).body.data;
    const first = order.fulfilments[0];
    const res = await buyer.post(`/api/orders/${order.id}/fulfilments/${first.id}/cancel`, { reason: "Changed my mind" });
    const data = res.body.data;
    assert.deepEqual(new Set(data.fulfilments.map((f: any) => f.status)), new Set(["cancelled"]));
    assert.equal(data.payment, null);
    // The stale payment request can no longer charge the buyer.
    const intent = order.payment.intent_id;
    assert.equal(
      (await buyer.post(`/api/orders/${order.id}/payment/confirm`, { intent_id: intent, outcome: "success" })).status,
      409,
    );
    assert.equal(await stockOf(env, a.id), a.stock);
  }));

test("unpaid orders expire and release stock", () =>
  withEnv(async (env) => {
    const db = env.db;
    const buyer = await env.client(BUYER);
    await env.client(ADMIN);
    await expireUnpaidOrders(db); // clear any stale unpaid demo orders first
    const product = await productFor(db, SELLER_A[0]);
    await add(buyer, product.id, 2);
    const order = (await checkout(buyer, "online")).body.data;
    assert.equal(await stockOf(env, product.id), product.stock - 2);
    assert.equal(await expireUnpaidOrders(db), 0); // still inside the payment window
    await db.execute("UPDATE fulfilments SET created_at = now() - interval '45 minutes' WHERE order_id = ?", [order.id]);
    assert.ok((await expireUnpaidOrders(db)) >= 1);
    assert.equal(await stockOf(env, product.id), product.stock);
    assert.equal(await db.scalar("SELECT payment_status FROM orders WHERE id = ?", [order.id]), "failed");
  }));

test("admin can cancel unpaid order", () =>
  withEnv(async (env) => {
    const buyer = await env.client(BUYER);
    const admin = await env.client(ADMIN);
    const product = await productFor(env.db, SELLER_A[0]);
    await add(buyer, product.id, 1);
    const order = (await checkout(buyer, "online")).body.data;
    const fid = order.fulfilments[0].id;
    assert.equal(
      (await admin.post(`/api/admin/fulfilments/${fid}/cancel`, { reason: "Suspected stock hoarding" })).status,
      200,
    );
    assert.equal(await env.db.scalar("SELECT status FROM fulfilments WHERE id = ?", [fid]), "cancelled");
  }));
