// Port of backend/tests/test_seller_admin.py
import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import zlib from "node:zlib";
import sharp from "sharp";
import type { Db } from "../src/db.js";
import { makeGstin } from "../src/seed.js";
import { ADMIN, type Client, SELLER_A, SELLER_PENDING, type TestEnv, pngBytes, setup } from "./helpers.js";

async function withEnv(fn: (env: TestEnv) => Promise<void>) {
  const env = await setup();
  try {
    await fn(env);
  } finally {
    await env.close();
  }
}

function applyPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    business_name: "Test Spares Pvt Ltd",
    display_name: "Test Spares",
    gstin: makeGstin("27", "AAACT1234Q"),
    pan: "AAACT1234Q",
    phone: "9876501234",
    address_line: "Plot 9, MIDC Bhosari",
    city: "Pune",
    state: "Maharashtra",
    pincode: "411026",
    bank_account_name: "Test Spares Pvt Ltd",
    bank_account_number: "001234567890",
    bank_ifsc: "HDFC0001234",
    ...overrides,
  };
}

async function newSeller(anon: Client): Promise<Client> {
  let res = await anon.post("/api/auth/register", {
    full_name: "Seller Person",
    email: "seller.new@example.com",
    password: "Sturdy#Pass2026",
  });
  anon.csrf = res.body.data.csrf;
  res = await anon.post("/api/seller/apply", applyPayload());
  assert.equal(res.status, 201, res.text);
  assert.equal(res.body.data.seller.status, "pending");
  return anon;
}

async function listingPayload(db: Db, overrides: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const category = await db.scalar("SELECT id FROM categories WHERE slug = 'brake-pads'");
  const brand = await db.scalar("SELECT id FROM brands WHERE slug = 'bosch'");
  const variants = (
    await db.all("SELECT v.id FROM variants v JOIN models m ON m.id = v.model_id WHERE m.name = 'City'")
  ).map((r) => r.id);
  return {
    title: "Front brake pads for Honda City",
    sku: "TEST-HC-01",
    category_id: category,
    brand_id: brand,
    part_number: "TP-4455-HC",
    oem_numbers: ["45022-T9A-T00"],
    condition: "new",
    price_paise: 149900,
    mrp_paise: 189900,
    stock: 10,
    gst_rate_bps: 1800,
    hsn_code: "8708",
    warranty_months: 6,
    weight_grams: 900,
    description: "Ceramic pads.",
    specs: [{ label: "Position", value: "Front" }],
    is_universal: false,
    variant_ids: variants,
    image_ids: [],
    submit: false,
    ...overrides,
  };
}

function upload(client: Client, data: Buffer, contentType = "image/png", name = "photo.png") {
  // `filepath` keeps directory parts in the multipart filename (plain `filename` is basename()d by form-data),
  // so "../../evil.jpg" reaches the server as-is, like httpx sent it.
  return client.agent
    .post("/api/seller/media")
    .set("Host", "testserver")
    .set("X-CSRF-Token", client.csrf)
    .attach("file", data, { filepath: name, contentType } as any);
}

test("seller application validation", () =>
  withEnv(async (env) => {
    const anon = await env.client();
    await anon.post("/api/auth/register", {
      full_name: "Seller Person",
      email: "s2@example.com",
      password: "Sturdy#Pass2026",
    });
    anon.csrf = (await anon.get("/api/auth/session")).body.data.csrf;
    const badChecksum = applyPayload({ gstin: "27AAACT1234Q1Z1" });
    const res = await anon.post("/api/seller/apply", badChecksum);
    assert.ok(res.status === 422 && "gstin" in res.body.error.fields);
    const mismatch = await anon.post("/api/seller/apply", applyPayload({ pan: "AAACX1234Q" }));
    assert.equal(mismatch.status, 422);
    assert.equal((await anon.post("/api/seller/apply", applyPayload({ bank_ifsc: "BAD" }))).status, 422);
    const ok = await anon.post("/api/seller/apply", applyPayload());
    assert.equal(ok.status, 201);
    assert.equal((await anon.post("/api/seller/apply", applyPayload())).status, 409);
    const profile = (await anon.get("/api/seller/profile")).body.data;
    assert.ok(profile.bank_account_last4 === "7890" && !("bank_account_number" in profile));
  }));

test("listing lifecycle moderation and search", () =>
  withEnv(async (env) => {
    const db = env.db;
    const anon = await env.client();
    const admin = await env.client(ADMIN);
    const seller = await newSeller(anon);
    const payload = await listingPayload(db);
    const draft = await seller.post("/api/seller/products", payload);
    assert.equal(draft.status, 201, draft.text);
    const productId = draft.body.data.id;
    assert.equal(draft.body.data.status, "draft");
    // Pending sellers cannot submit for review.
    assert.equal((await seller.post(`/api/seller/products/${productId}/submit`)).status, 403);

    const sellerId = await db.scalar("SELECT id FROM sellers WHERE gstin = ?", [applyPayload().gstin]);
    assert.equal((await admin.post(`/api/admin/sellers/${sellerId}/review`, { decision: "reject" })).status, 422);
    assert.equal((await admin.post(`/api/admin/sellers/${sellerId}/review`, { decision: "approve" })).status, 200);
    seller.csrf = (await seller.get("/api/auth/session")).body.data.csrf;

    const noPhoto = await seller.post(`/api/seller/products/${productId}/submit`);
    assert.ok(noPhoto.status === 422 && "image_ids" in noPhoto.body.error.fields);
    const media = (await upload(seller, await pngBytes())).body.data;
    const updated = await seller.put(`/api/seller/products/${productId}`, {
      ...payload,
      image_ids: [media.id],
      submit: true,
    });
    assert.equal(updated.status, 200, updated.text);
    assert.equal(updated.body.data.status, "pending");

    assert.equal((await anon.get(`/api/products/${productId}`)).status, 200); // owner can preview
    const pub = await env.client();
    assert.equal((await pub.get(`/api/products/${productId}`)).status, 404);

    assert.equal((await admin.post(`/api/admin/products/${productId}/moderate`, { decision: "reject" })).status, 422);
    const approved = await admin.post(`/api/admin/products/${productId}/moderate`, { decision: "approve" });
    assert.equal(approved.body.data.status, "active");
    const found = (await pub.get("/api/search").query({ q: "TP4455HC" })).body.data.items;
    assert.deepEqual(
      found.map((i: any) => i.id),
      [productId],
    );
    const byOem = (await pub.get("/api/search").query({ q: "45022T9AT00" })).body.data.items;
    assert.ok(byOem.map((i: any) => i.id).includes(productId));

    // Price/stock edits stay live; content edits go back to review.
    assert.equal((await seller.patch(`/api/seller/products/${productId}/inventory`, { price_paise: 139900 })).status, 200);
    assert.equal(await db.scalar("SELECT status FROM products WHERE id = ?", [productId]), "active");
    assert.equal((await seller.patch(`/api/seller/products/${productId}/inventory`, { price_paise: 999900 })).status, 422);
    const edited = await seller.put(`/api/seller/products/${productId}`, {
      ...payload,
      title: "Front brake pads for Honda City (ceramic)",
      image_ids: [media.id],
    });
    assert.equal(edited.body.data.status, "pending");
    assert.deepEqual((await pub.get("/api/search").query({ q: "TP4455HC" })).body.data.items, []);

    // Photos, specs and cross-reference numbers are reviewed too.
    assert.equal((await admin.post(`/api/admin/products/${productId}/moderate`, { decision: "approve" })).status, 200);
    const hijack = {
      ...payload,
      title: "Front brake pads for Honda City (ceramic)",
      image_ids: [media.id],
      oem_numbers: ["45022-T9A-T00", "55810M68K00"],
    };
    assert.equal((await seller.put(`/api/seller/products/${productId}`, hijack)).body.data.status, "pending");
    assert.ok((await db.scalar("SELECT COUNT(*) FROM audit_log WHERE action LIKE 'listing.%'")) >= 3);
  }));

test("listing validation", () =>
  withEnv(async (env) => {
    const db = env.db;
    const seller = await newSeller(await env.client());
    const res = await seller.post("/api/seller/products", await listingPayload(db, { mrp_paise: 100 }));
    assert.ok(res.status === 422 && "mrp_paise" in res.body.error.fields);
    const oem = await seller.post("/api/seller/products", await listingPayload(db, { condition: "oem_genuine" }));
    assert.ok(oem.status === 422 && "condition" in oem.body.error.fields);
    const badVariant = await seller.post("/api/seller/products", await listingPayload(db, { variant_ids: [99999] }));
    assert.equal(badVariant.status, 422);
    assert.equal((await seller.post("/api/seller/products", await listingPayload(db))).status, 201);
    const dup = await seller.post("/api/seller/products", await listingPayload(db));
    assert.ok(dup.status === 422 && "sku" in dup.body.error.fields);
  }));

test("image upload sanitises", () =>
  withEnv(async (env) => {
    const seller = await newSeller(await env.client());
    const ok = await upload(seller, await pngBytes(undefined, undefined, "jpeg", true), "image/jpeg", "../../evil.jpg");
    assert.equal(ok.status, 201, ok.text);
    const data = ok.body.data;
    assert.ok(data.url.endsWith(".webp") && !data.url.includes("evil"));
    const stored = path.join(env.settings.uploadDir, data.url.replace(/^\/media\//, ""));
    const meta = await sharp(stored).metadata();
    assert.ok(meta.format === "webp" && !meta.exif);
    const served = await seller.get(data.url);
    assert.ok(served.status === 200 && served.headers["x-content-type-options"] === "nosniff");

    assert.equal((await upload(seller, Buffer.from("<?php echo 1; ?>"), "image/png")).status, 415);
    assert.equal((await upload(seller, Buffer.from("GIF89a...."), "image/gif")).status, 415);
    assert.equal((await upload(seller, await pngBytes([120, 120]))).status, 422);
    assert.equal(
      (
        await seller.agent
          .post("/api/seller/media")
          .set("Host", "testserver")
          .set("X-CSRF-Token", seller.csrf)
          .field("x", "1")
      ).status,
      400,
    );
  }));

test("csv import dry run and apply", () =>
  withEnv(async (env) => {
    const db = env.db;
    const seller = await newSeller(await env.client());
    const template = await seller.get("/api/seller/import/template.csv");
    assert.ok(template.status === 200 && template.headers["content-type"].startsWith("text/csv"));
    const codes = (await db.all("SELECT code FROM variants LIMIT 2")).map((r) => r.code);
    const header =
      "sku,title,category,brand,part_number,oem_numbers,condition,price,mrp,stock,gst_rate,hsn_code,warranty_months,weight_grams,universal,vehicle_codes,description\n";
    const good = `CSV-1,Front brake pad set ceramic,brake-pads,bosch,CSV-PN-1,,new,1249,1650,5,18,8708,6,900,no,${codes.join(" ")},Desc\n`;
    const bad = "CSV-2,short,unknown-cat,nobrand,X,,used,abc,10,-1,7,12,999,0,no,NOPE,\n";

    const send = (content: string, dryRun: boolean) =>
      seller.upload(`/api/seller/import?dry_run=${String(dryRun)}`, Buffer.from(content), "listings.csv", "text/csv");

    const report = (await send(header + good + bad, false)).body.data;
    assert.ok(report.ok === false && report.error_count >= 8);
    assert.deepEqual(new Set(report.errors.map((e: any) => e.row)), new Set([3]));
    assert.equal(await db.scalar("SELECT COUNT(*) FROM products WHERE sku LIKE 'CSV-%'"), 0);
    const dry = (await send(header + good, true)).body.data;
    assert.ok(dry.ok && dry.new === 1);
    const applied = (await send(header + good, false)).body.data;
    assert.equal(applied.created, 1);
    assert.equal(await db.scalar("SELECT status FROM products WHERE sku = 'CSV-1'"), "draft");
    const again = (await send(header + good.replaceAll(",5,", ",9,"), false)).body.data;
    assert.equal(again.updated, 1);
    assert.equal(await db.scalar("SELECT stock FROM products WHERE sku = 'CSV-1'"), 9);
    const productId = await db.scalar("SELECT id FROM products WHERE sku = 'CSV-1'");
    assert.equal((await seller.post(`/api/seller/products/${productId}/archive`)).status, 200);
    const archived = (await send(header + good, true)).body.data;
    assert.ok(archived.ok === false && archived.errors[0].field === "sku");
  }));

test("pending seller portal", () =>
  withEnv(async (env) => {
    const pending = await env.client(SELLER_PENDING);
    assert.equal((await pending.get("/api/seller/dashboard")).status, 200);
    assert.equal((await pending.get("/api/seller/products")).body.data.counts.draft, 1);
    const res = await pending.post("/api/seller/orders/1/pack", {});
    assert.ok([403, 404].includes(res.status));
  }));

test("admin master data", () =>
  withEnv(async (env) => {
    const admin = await env.client(ADMIN);
    const make = await admin.post("/api/admin/makes", { name: "Skoda", country: "Czech Republic" });
    assert.equal(make.status, 201);
    assert.equal((await admin.post("/api/admin/makes", { name: "Skoda" })).status, 409);
    const model = await admin.post("/api/admin/models", { make_id: make.body.data.id, name: "Kushaq", body_type: "suv" });
    assert.equal(model.status, 201);
    const variant = await admin.post("/api/admin/variants", {
      model_id: model.body.data.id,
      name: "Style 1.5 TSI DSG",
      year_from: 2021,
      fuel: "petrol",
      transmission: "dct",
      engine_cc: 1498,
    });
    assert.ok(variant.status === 201 && variant.body.data.code.startsWith("SKOD-KUSH-STYL-P-DCT"));
    const badYears = await admin.post("/api/admin/variants", {
      model_id: model.body.data.id,
      name: "X",
      year_from: 2022,
      year_to: 2020,
      fuel: "petrol",
      transmission: "manual",
    });
    assert.equal(badYears.status, 422);
    const tree: any[] = (await admin.get("/api/admin/vehicles")).body.data;
    assert.ok(tree.some((m) => m.name === "Skoda" && m.models[0].variants.length > 0));
    const cat = await admin.post("/api/admin/categories", { name: "Horns", icon: "electrical" });
    assert.equal(cat.status, 201);
    const child = await admin.post("/api/admin/categories", { name: "Air Horns", parent_id: cat.body.data.id });
    assert.equal(child.status, 201);
    const deep = await admin.post("/api/admin/categories", { name: "Too Deep", parent_id: child.body.data.id });
    assert.equal(deep.status, 400);
    assert.equal((await admin.post("/api/admin/brands", { name: "Uno Minda", is_oem: false })).status, 201);
    const audit = (await admin.get("/api/admin/audit")).body.data;
    assert.ok(audit.total >= 6 && ["make", "model", "variant"].every((e) => audit.entities.includes(e)));
  }));

test("admin cannot suspend admins", () =>
  withEnv(async (env) => {
    const admin = await env.client(ADMIN);
    const adminId = await env.db.scalar("SELECT id FROM users WHERE role = 'admin'");
    assert.equal((await admin.post(`/api/admin/users/${adminId}/status`, { status: "suspended" })).status, 403);
  }));

test("admin dashboards", () =>
  withEnv(async (env) => {
    const admin = await env.client(ADMIN);
    const seller = await env.client(SELLER_A);
    const data = (await admin.get("/api/admin/dashboard")).body.data;
    assert.ok(data.series.length === 30 && data.kpis.gmv_30d > 0);
    assert.ok((await admin.get("/api/admin/orders")).body.data.total > 0);
    assert.equal((await admin.get("/api/admin/sellers").query({ status: "pending" })).body.data.total, 1);
    const sd = (await seller.get("/api/seller/dashboard")).body.data;
    assert.ok(sd.series.length === 30 && "to_ship" in sd.kpis);
  }));

/** A 1-bit 12000x12000 PNG (what Pillow writes for Image.new("1", ...)): tiny file, huge pixel count. */
function bilevelPng(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 1; // bit depth
  ihdr[9] = 0; // greyscale
  const raw = Buffer.alloc((1 + Math.ceil(width / 8)) * height); // filter byte 0 + all-black row
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

test("image bomb rejected", () =>
  withEnv(async (env) => {
    const seller = await newSeller(await env.client());
    const res = await upload(seller, bilevelPng(12000, 12000));
    assert.equal(res.status, 415);
  }));
