// Port of backend/tests/test_catalog.py
import assert from "node:assert/strict";
import { test } from "node:test";
import { ADMIN, type Client, type TestEnv, setup } from "./helpers.js";

async function withEnv(fn: (env: TestEnv, anon: Client) => Promise<void>) {
  const env = await setup();
  try {
    await fn(env, await env.client());
  } finally {
    await env.close();
  }
}

async function swiftVxi(anon: Client): Promise<any> {
  const makes: any[] = (await anon.get("/api/vehicles/makes")).body.data;
  const maruti = makes.find((m) => m.name === "Maruti Suzuki");
  const models: any[] = (await anon.get(`/api/vehicles/makes/${maruti.id}/models`)).body.data;
  const swift = models.find((m) => m.name === "Swift");
  const years: number[] = (await anon.get(`/api/vehicles/models/${swift.id}/years`)).body.data;
  assert.ok(years.includes(2019) && !years.includes(2017));
  const variants: any[] = (await anon.get(`/api/vehicles/models/${swift.id}/variants`).query({ year: 2019 })).body.data;
  assert.ok(variants.length > 0 && variants.every((v) => v.year_from <= 2019));
  assert.ok(variants.every((v) => !v.name.includes("Z-Series"))); // 4th gen starts 2024
  const vxi = variants.find((v) => v.name === "VXi 1.2");
  assert.ok(vxi);
  return vxi;
}

test("vehicle cascade", () =>
  withEnv(async (_env, anon) => {
    const variant = await swiftVxi(anon);
    const detail = (await anon.get(`/api/vehicles/variants/${variant.id}`)).body.data;
    assert.equal(detail.label, "Maruti Suzuki Swift VXi 1.2");
    assert.ok(detail.part_count > 0);
  }));

test("search by vehicle only returns fitting parts", () =>
  withEnv(async (_env, anon) => {
    const variant = await swiftVxi(anon);
    const data = (await anon.get("/api/search").query({ vehicle: variant.id, per_page: 60 })).body.data;
    assert.ok(data.total > 5);
    assert.ok(data.items.every((item: any) => item.fits === true));
    const everything = (await anon.get("/api/search").query({ vehicle: variant.id, fit: "all", per_page: 60 })).body.data;
    assert.ok(everything.total > data.total);
    assert.ok(everything.items.some((item: any) => item.fits === false));
  }));

test("model named in query", () =>
  withEnv(async (_env, anon) => {
    const data = (await anon.get("/api/search").query({ q: "swift brake pads" })).body.data;
    assert.equal(data.detected_model.name, "Swift");
    assert.ok(data.total >= 2);
    assert.ok(data.items.every((i: any) => i.category.includes("Brake") || i.title.toLowerCase().includes("brake")));
  }));

test("part number lookup is normalised", () =>
  withEnv(async (_env, anon) => {
    for (const query of ["55810M68K00", "55810-m68k00", "558 10 M68 K00"]) {
      const data = (await anon.get("/api/search").query({ q: query })).body.data;
      const titles: string[] = data.items.map((i: any) => i.title);
      assert.ok(
        titles.some((t) => t.includes("Genuine")),
        JSON.stringify([query, titles]),
      );
      assert.ok(["55810M68K00", "0986AB2145"].includes(data.items[0].part_number.replaceAll(" ", "").toUpperCase()));
    }
  }));

test("filters facets and sorting", () =>
  withEnv(async (_env, anon) => {
    const base = (await anon.get("/api/search").query({ category: "brakes" })).body.data;
    assert.ok(base.total > 0);
    const allowed = new Set(["brake-pads", "brake-discs", "brake-shoes", "brake-fluid"]);
    assert.ok(base.facets.categories.every((c: any) => allowed.has(c.slug)));
    const brand = base.facets.brands[0].slug;
    const filtered = (await anon.get("/api/search").query({ category: "brakes", brand })).body.data;
    assert.equal(filtered.total, base.facets.brands[0].count);
    const cheap = (await anon.get("/api/search").query({ category: "brakes", sort: "price_asc", per_page: 60 })).body.data;
    const prices: number[] = cheap.items.map((i: any) => i.price_paise);
    assert.deepEqual(
      prices,
      [...prices].sort((a, b) => a - b),
    );
    const ranged = (await anon.get("/api/search").query({ category: "brakes", min_price: 1000, max_price: 2000 })).body
      .data;
    assert.ok(ranged.items.every((i: any) => 100_000 <= i.price_paise && i.price_paise <= 200_000));
  }));

test("relaxed search when no exact match", () =>
  withEnv(async (_env, anon) => {
    const data = (await anon.get("/api/search").query({ q: "iridium unicorn" })).body.data;
    assert.ok(data.relaxed === true && data.total >= 1);
  }));

test("product detail with fit check", () =>
  withEnv(async (_env, anon) => {
    const variant = await swiftVxi(anon);
    const item = (await anon.get("/api/search").query({ vehicle: variant.id, q: "brake pad" })).body.data.items[0];
    const detail = (await anon.get(`/api/products/${item.id}`).query({ vehicle: variant.id })).body.data;
    assert.equal(detail.fits, true);
    assert.ok(detail.fitment_count > 0 && detail.fitment[0].variants.length > 0);
    assert.ok(detail.part_numbers[0].number);
    assert.ok("stock" in detail && detail.stock <= 50);
    const creta = (await anon.get("/api/search").query({ q: "creta" })).body.data.detected_model;
    assert.equal(creta.name, "Creta");
  }));

test("hidden listings are not public", () =>
  withEnv(async (env, anon) => {
    const admin = await env.client(ADMIN);
    const pending = (await env.db.one("SELECT id FROM products WHERE status = 'pending' LIMIT 1"))!;
    assert.equal((await anon.get(`/api/products/${pending.id}`)).status, 404);
    assert.equal((await admin.get(`/api/products/${pending.id}`)).status, 200);
    const seller = (await env.db.one(
      "SELECT s.id, p.id AS product_id FROM sellers s JOIN products p ON p.seller_id = s.id WHERE s.kyc_status = 'approved' AND p.status = 'active' LIMIT 1",
    ))!;
    assert.equal((await anon.get(`/api/products/${seller.product_id}`)).status, 200);
    const res = await admin.post(`/api/admin/sellers/${seller.id}/review`, {
      decision: "suspend",
      note: "Counterfeit complaints",
    });
    assert.equal(res.status, 200, res.text);
    assert.equal((await anon.get(`/api/products/${seller.product_id}`)).status, 404);
    const ids = new Set(
      (await anon.get("/api/search").query({ per_page: 60, page: 1 })).body.data.items.map((i: any) => i.id),
    );
    assert.ok(!ids.has(seller.product_id));
  }));

test("home and taxonomy", () =>
  withEnv(async (_env, anon) => {
    const home = (await anon.get("/api/home")).body.data;
    assert.ok(home.categories.length > 0 && home.popular.length > 0 && home.stats.parts > 0);
    const tree: any[] = (await anon.get("/api/categories")).body.data;
    assert.ok(tree.every((node) => node.children.length > 0));
    assert.ok((await anon.get("/api/brands")).body.data.length > 0);
  }));

test("suggest", () =>
  withEnv(async (_env, anon) => {
    const data = (await anon.get("/api/search/suggest").query({ q: "oil fil" })).body.data;
    assert.ok(data.products.length > 0);
    const part = (await anon.get("/api/search/suggest").query({ q: "16510M68K00" })).body.data;
    assert.ok(part.part_number.matches >= 1);
  }));
