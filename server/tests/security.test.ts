// Port of backend/tests/test_security.py
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { makeGstin } from "../src/seed.js";
import { csvSafe } from "../src/services/csv_import.js";
import { gstinChecksumOk } from "../src/util.js";
import { ADMIN, BUYER, BUYER_2, SELLER_A, SELLER_B, type TestEnv, productFor, setup } from "./helpers.js";

async function withEnv(fn: (env: TestEnv) => Promise<void>) {
  const env = await setup();
  try {
    await fn(env);
  } finally {
    await env.close();
  }
}

test("security headers on api and pages", () =>
  withEnv(async (env) => {
    const anon = await env.client();
    for (const url of ["/api/categories", "/some/page"]) {
      const res = await anon.get(url);
      assert.equal(res.headers["x-content-type-options"], "nosniff");
      assert.equal(res.headers["x-frame-options"], "DENY");
      assert.ok(res.headers["content-security-policy"].includes("default-src 'self'"));
      assert.ok(res.headers["content-security-policy"].includes("frame-ancestors 'none'"));
      assert.equal(res.headers["referrer-policy"], "strict-origin-when-cross-origin");
      assert.ok(res.headers["x-request-id"]);
    }
    assert.equal((await anon.get("/api/categories")).headers["cache-control"], "no-store");
  }));

test("unknown api is json 404", () =>
  withEnv(async (env) => {
    const anon = await env.client();
    const res = await anon.get("/api/does-not-exist");
    assert.equal(res.status, 404);
    assert.equal(res.body.error.code, "not_found");
  }));

test("oversized and malformed bodies", () =>
  withEnv(async (env) => {
    const buyer = await env.client(BUYER);
    const huge = await buyer.agent
      .post("/api/me/addresses")
      .set("Host", "testserver")
      .set({ "X-CSRF-Token": buyer.csrf, "content-type": "application/json" })
      .send("{" + " ".repeat(8 * 1024 * 1024) + "}");
    assert.equal(huge.status, 413);
    const bad = await buyer.agent
      .post("/api/me/addresses")
      .set("Host", "testserver")
      .set({ "X-CSRF-Token": buyer.csrf, "content-type": "application/json" })
      .send("{not json");
    assert.ok(bad.status === 400 && bad.body.error.code === "invalid_json");
  }));

const INERT_QUERIES = [
  "' OR 1=1 --",
  '"',
  'brake" OR "a',
  "NEAR(a b)",
  "*",
  "a AND",
  "%_\\",
  "🙂 pads",
  "x".repeat(120),
  "products_fts MATCH 'x'",
];

for (const q of INERT_QUERIES) {
  test(`search input is inert [${q}]`, () =>
    withEnv(async (env) => {
      const anon = await env.client();
      const res = await anon.get("/api/search").query({ q });
      assert.equal(res.status, 200, res.text);
      assert.ok(Array.isArray(res.body.data.items));
    }));
}

test("search rejects bad params", () =>
  withEnv(async (env) => {
    const anon = await env.client();
    assert.equal((await anon.get("/api/search").query({ sort: "DROP TABLE" })).status, 422);
    assert.equal((await anon.get("/api/search").query({ per_page: 10_000 })).status, 422);
    assert.equal((await anon.get("/api/search").query({ q: "x".repeat(500) })).status, 422);
  }));

test("spa fallback never serves outside dist", () =>
  withEnv(async (env) => {
    const anon = await env.client();
    const dist = env.settings.frontendDist;
    fs.mkdirSync(dist, { recursive: true });
    fs.writeFileSync(path.join(dist, "index.html"), "<!doctype html><title>PartPilot</title>");
    fs.writeFileSync(path.join(path.dirname(dist), "secret.txt"), "top secret");
    for (const p of ["/../secret.txt", "/%2e%2e/secret.txt", "/..%2fsecret.txt", "/assets/../../secret.txt"]) {
      const res = await anon.get(p);
      assert.ok(!res.text.includes("top secret"));
    }
    const res = await anon.get("/seller/listings");
    assert.ok(res.status === 200 && res.text.includes("PartPilot"));
  }));

test("media path traversal blocked", () =>
  withEnv(async (env) => {
    const anon = await env.client();
    for (const p of ["/media/../app.db", "/media/%2e%2e/app.db", "/media/..%2fapp.db"]) {
      const res = await anon.get(p);
      assert.ok(!(res.text ?? "").includes("SQLite format"));
      assert.ok(
        (res.headers["content-type"] ?? "").split(";")[0] !== "application/octet-stream" || res.status === 404,
      );
    }
  }));

test("rbac matrix", () =>
  withEnv(async (env) => {
    const anon = await env.client();
    const buyer = await env.client(BUYER);
    const seller = await env.client(SELLER_A);
    const admin = await env.client(ADMIN);
    assert.equal((await anon.get("/api/orders")).status, 401);
    assert.equal((await anon.get("/api/seller/products")).status, 401);
    assert.equal((await buyer.get("/api/seller/products")).status, 403);
    assert.equal((await buyer.get("/api/admin/dashboard")).status, 403);
    assert.equal((await seller.get("/api/admin/sellers")).status, 403);
    assert.equal((await admin.get("/api/seller/products")).status, 403);
    assert.equal((await admin.get("/api/admin/dashboard")).status, 200);
  }));

test("sellers cannot touch each others data", () =>
  withEnv(async (env) => {
    const seller = await env.client(SELLER_A);
    const other = await env.client(SELLER_B);
    const theirs = await productFor(env.db, SELLER_B[0]);
    assert.equal((await seller.get(`/api/seller/products/${theirs.id}`)).status, 404);
    assert.equal((await seller.patch(`/api/seller/products/${theirs.id}/inventory`, { stock: 0 })).status, 404);
    assert.equal((await seller.post(`/api/seller/products/${theirs.id}/archive`)).status, 404);
    const theirFulfilment = await env.db.one(
      `SELECT f.id FROM fulfilments f JOIN sellers s ON s.id = f.seller_id JOIN users u ON u.id = s.user_id
       WHERE u.email = ? AND f.status = 'placed' LIMIT 1`,
      [SELLER_B[0]],
    );
    if (theirFulfilment) {
      assert.equal((await seller.get(`/api/seller/orders/${theirFulfilment.id}`)).status, 404);
      assert.equal((await seller.post(`/api/seller/orders/${theirFulfilment.id}/pack`, {})).status, 404);
    }
    assert.equal((await other.get(`/api/seller/products/${theirs.id}`)).status, 200);
  }));

test("buyers cannot see each others orders", () =>
  withEnv(async (env) => {
    const buyer = await env.client(BUYER);
    const other = await env.client(BUYER_2);
    const order = await env.db.one(
      "SELECT o.id FROM orders o JOIN users u ON u.id = o.buyer_id WHERE u.email = ? LIMIT 1",
      [BUYER_2[0]],
    );
    assert.ok(order !== null);
    assert.equal((await buyer.get(`/api/orders/${order.id}`)).status, 404);
    assert.equal((await other.get(`/api/orders/${order.id}`)).status, 200);
    const fulfilment = (await env.db.one("SELECT id FROM fulfilments WHERE order_id = ?", [order.id]))!;
    const res = await buyer.post(`/api/orders/${order.id}/fulfilments/${fulfilment.id}/cancel`, { reason: "not mine" });
    assert.equal(res.status, 404);
  }));

test("csv formula injection neutralised", () => {
  assert.ok(csvSafe('=HYPERLINK("http://x")').startsWith("'="));
  assert.equal(csvSafe("+1"), "'+1");
  assert.equal(csvSafe("@cmd"), "'@cmd");
  assert.equal(csvSafe("Brake pads"), "Brake pads");
});

test("gstin checksum", () => {
  assert.ok(gstinChecksumOk(makeGstin("33", "AAFCL2468K")));
  assert.ok(!gstinChecksumOk("33AAFCL2468K1ZA") || makeGstin("33", "AAFCL2468K") === "33AAFCL2468K1ZA");
});

test("errors do not leak internals", () =>
  withEnv(async (env) => {
    const anon = await env.client();
    const res = await anon.get("/api/products/999999999");
    assert.equal(res.status, 404);
    const body = res.body;
    const allowed = new Set(["code", "message", "request_id", "fields"]);
    assert.ok(Object.keys(body.error).every((k) => allowed.has(k)));
    assert.ok(!res.text.includes("Traceback"));
  }));
