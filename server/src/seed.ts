// Loads master data and the synthetic demo marketplace. Refuses to run in production.
// Port of backend/app/seed.py.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { type Settings, SERVER_ROOT, isProduction } from "./config.js";
import { DAY, type Database, type Db, MINUTE, type Row, isoUtc, utcnow } from "./db.js";
import { hashPassword } from "./security/passwords.js";
import {
  AFTERMARKET_BRANDS,
  BUYERS,
  CATEGORIES,
  type FitSpec,
  MAKE_OEM,
  OEM_BRANDS,
  PRODUCTS,
  SELLERS,
  VEHICLES,
} from "./seed_data.js";
import { TRANSMISSION_LABEL, reindexProduct } from "./services/catalog.js";
import { type Address, createPaymentIntent, placeOrder, settlePayment } from "./services/commerce.js";
import { type ListingData, saveListing, setStatus } from "./services/listings.js";
import { saveMedia } from "./services/storage.js";
import { roundHalfEven, slugify } from "./util.js";

export { createPaymentIntent };

/** Demo artwork; falls back to the source tree when running the compiled build from dist/. */
const ART_DIR = (() => {
  const local = path.join(path.dirname(fileURLToPath(import.meta.url)), "seed_assets");
  return fs.existsSync(local) ? local : path.join(SERVER_ROOT, "src", "seed_assets");
})();

export const DEMO_PASSWORD = "Demo@12345";
export const ADMIN_EMAIL = "admin@partpilot.test";
export const ADMIN_PASSWORD = "Admin@12345";

const GSTIN_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/** Small deterministic PRNG (mulberry32) so demo data is reproducible between runs. */
class Rng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  /** Float in [0, 1). */
  random(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Integer in [a, b], both inclusive (like Python's randint). */
  randint(a: number, b: number): number {
    return a + Math.floor(this.random() * (b - a + 1));
  }

  choice<T>(items: readonly T[]): T {
    return items[Math.floor(this.random() * items.length)];
  }

  /** k distinct items, without modifying the input (like Python's random.sample). */
  sample<T>(items: readonly T[], k: number): T[] {
    if (k > items.length) throw new Error("Sample larger than population");
    const pool = [...items];
    const out: T[] = [];
    for (let i = 0; i < k; i++) {
      const j = i + Math.floor(this.random() * (pool.length - i));
      [pool[i], pool[j]] = [pool[j], pool[i]];
      out.push(pool[i]);
    }
    return out;
  }
}

export function makeGstin(stateCode: string, pan: string, entity = "1"): string {
  const body = `${stateCode}${pan}${entity}Z`;
  let total = 0;
  for (let i = 0; i < body.length; i++) {
    const value = GSTIN_CHARS.indexOf(body[i]) * (i % 2 ? 2 : 1);
    total += Math.floor(value / 36) + (value % 36);
  }
  return body + GSTIN_CHARS[(36 - (total % 36)) % 36];
}

function abbr(text: string, n: number): string {
  return text.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, n);
}

export async function seedMaster(db: Db): Promise<void> {
  for (const [make, country, models] of VEHICLES) {
    const makeId = await db.insert("INSERT INTO makes (name, slug, country) VALUES (?, ?, ?)", [make, slugify(make), country]);
    for (const [model, body, variants] of models) {
      const modelId = await db.insert("INSERT INTO models (make_id, name, slug, body_type) VALUES (?, ?, ?, ?)", [
        makeId,
        model,
        slugify(model),
        body,
      ]);
      for (const [name, gen, y0, y1, fuel, trans, cc, engine] of variants) {
        const trim = abbr(name.split(/\s+/)[0], 5);
        const makePart = make.includes(" ")
          ? make
              .split(/\s+/)
              .filter(Boolean)
              .map((w) => w[0])
              .join("")
          : abbr(make, 2);
        const genPart = /^\d/.test(gen) ? abbr(gen, 1) : "";
        let code =
          `${makePart}-${abbr(model, 4)}${genPart}-${trim}-${fuel[0].toUpperCase()}-` +
          `${TRANSMISSION_LABEL[trans]}-${String(y0).slice(2)}`;
        const base = code;
        let n = 2;
        while (await db.scalar("SELECT 1 FROM variants WHERE code = ?", [code])) {
          code = `${base}-${n}`;
          n += 1;
        }
        await db.insert(
          `INSERT INTO variants (model_id, code, name, generation, year_from, year_to, fuel, transmission,
               engine_cc, engine_code) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [modelId, code, name, gen, y0, y1, fuel, trans, cc, engine],
        );
      }
    }
  }
  for (const [position, [name, icon, children]] of CATEGORIES.entries()) {
    const parent = await db.insert("INSERT INTO categories (name, slug, icon, position) VALUES (?, ?, ?, ?)", [
      name,
      slugify(name),
      icon,
      position,
    ]);
    for (const [childPos, child] of children.entries()) {
      await db.insert("INSERT INTO categories (parent_id, name, slug, icon, position) VALUES (?, ?, ?, ?, ?)", [
        parent,
        child,
        slugify(child),
        icon,
        childPos,
      ]);
    }
  }
  for (const name of OEM_BRANDS) {
    await db.insert("INSERT INTO brands (name, slug, is_oem) VALUES (?, ?, true)", [name, slugify(name)]);
  }
  for (const name of AFTERMARKET_BRANDS) {
    await db.insert("INSERT INTO brands (name, slug, is_oem) VALUES (?, ?, false)", [name, slugify(name)]);
  }
}

async function createUser(
  db: Db,
  email: string,
  name: string,
  role: string,
  password: string,
  phone: string | null,
  created: string,
): Promise<number> {
  return db.insert(
    "INSERT INTO users (email, password_hash, full_name, phone, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [email, await hashPassword(password), name, phone, role, created, created],
  );
}

async function variantIds(db: Db, fit: readonly FitSpec[]): Promise<number[]> {
  const ids = new Set<number>();
  for (const [make, model, fuel, gen] of fit) {
    let sql = `SELECT v.id FROM variants v JOIN models mo ON mo.id = v.model_id JOIN makes mk ON mk.id = mo.make_id
               WHERE mk.name = ? AND mo.name = ?`;
    const params: unknown[] = [make, model];
    if (fuel) {
      sql += " AND v.fuel = ?";
      params.push(fuel);
    }
    if (gen) {
      sql += " AND v.generation = ?";
      params.push(gen);
    }
    for (const r of await db.all(sql, params)) ids.add(Number(r.id));
  }
  return [...ids].sort((a, b) => a - b);
}

async function attachArt(db: Db, settings: Settings, sellerId: number, art: string, productId: number): Promise<number> {
  const full = `products/demo-${productId}-${art}.webp`;
  const thumb = `products/demo-${productId}-${art}_t.webp`;
  const src = path.join(ART_DIR, `${art}.webp`);
  const srcT = path.join(ART_DIR, `${art}_t.webp`);
  let width = 800;
  let height = 800;
  if (fs.existsSync(src)) {
    await saveMedia(settings.uploadDir, full, fs.readFileSync(src));
    await saveMedia(settings.uploadDir, thumb, fs.readFileSync(fs.existsSync(srcT) ? srcT : src));
    const meta = await sharp(src).metadata();
    width = meta.width ?? width;
    height = meta.height ?? height;
  }
  return db.insert(
    "INSERT INTO media (seller_id, product_id, path, thumb_path, width, height, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [sellerId, productId, full, thumb, width, height, utcnow()],
  );
}

/** A timestamp `days` ago minus a random 0-600 minutes, whole seconds. */
function ago(days: number, rng: Rng): string {
  return isoUtc(new Date(Date.now() - days * DAY - rng.randint(0, 600) * MINUTE));
}

const FIT_FOR_PENDING: FitSpec[] = [
  ["Maruti Suzuki", "Swift", null, "4th gen"],
  ["Maruti Suzuki", "Baleno", "petrol", "2nd gen"],
];

export async function seedDemo(db: Db, settings: Settings): Promise<Record<string, number>> {
  const rng = new Rng(20261110);
  const created = ago(120, rng);
  await createUser(db, ADMIN_EMAIL, "Platform Admin", "admin", ADMIN_PASSWORD, null, created);

  const sellerIds: number[] = [];
  for (const s of SELLERS) {
    const uid = await createUser(db, s.email, s.name, "seller", DEMO_PASSWORD, s.phone, created);
    const status = s.kyc ?? "approved";
    const sid = await db.insert(
      `INSERT INTO sellers (user_id, business_name, display_name, gstin, pan, phone, address_line, city, state,
           pincode, bank_account_name, bank_account_last4, bank_ifsc, kyc_status, created_at, reviewed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        uid,
        s.business,
        s.display,
        makeGstin(s.state_code, s.pan),
        s.pan,
        s.phone,
        s.address,
        s.city,
        s.state,
        s.pincode,
        s.business,
        `${rng.randint(1000, 9999)}`,
        s.ifsc,
        status,
        created,
        status === "approved" ? created : null,
      ],
    );
    sellerIds.push(sid);
  }
  const approved = sellerIds.slice(0, 3);

  const cats = new Map((await db.all("SELECT id, name FROM categories")).map((r) => [r.name as string, Number(r.id)]));
  const brands = new Map((await db.all("SELECT id, name FROM brands")).map((r) => [r.name as string, Number(r.id)]));
  const oemBrandNames = new Set(Object.values(MAKE_OEM));
  const productIds: number[] = [];
  for (const [index, product] of PRODUCTS.entries()) {
    const [cat, art, title, brand, part, oems, price, mrp, gst, hsn, warranty, weight, fit, universal, specs, desc] = product;
    const listings: Array<[number, number]> = [[approved[index % 3], 1.0]];
    if (index % 3 === 0) listings.push([approved[(index + 1) % 3], index % 2 ? 0.96 : 1.04]);
    for (const [n, [sellerId, factor]] of listings.entries()) {
      const isOem = oemBrandNames.has(brand);
      const data: ListingData = {
        title,
        sku: `${abbr(brand, 4)}-${abbr(part, 10)}-${n + 1}`,
        categoryId: cats.get(cat)!,
        brandId: brands.get(brand)!,
        partNumber: part,
        condition: isOem ? "oem_genuine" : "new",
        pricePaise: roundHalfEven(price * factor) * 100,
        mrpPaise: mrp * 100,
        stock:
          (index + n) % 11 === 5 ? rng.choice([0, 2, 3, 8, 12, 18, 25, 40]) : rng.choice([6, 12, 18, 25, 40, 60]),
        gstRateBps: gst * 100,
        hsnCode: hsn,
        warrantyMonths: warranty,
        weightGrams: weight,
        description: desc,
        isUniversal: universal,
        oemNumbers: [...oems],
        specs: specs.map(([k, v]) => [k, v] as [string, string]),
        variantIds: await variantIds(db, fit),
        imageIds: null,
      };
      if (data.mrpPaise < data.pricePaise) data.mrpPaise = data.pricePaise;
      const [pid] = await saveListing(db, sellerId, data, null, { submit: false });
      await attachArt(db, settings, sellerId, art, pid);
      await setStatus(db, pid, "active");
      const when = ago(rng.randint(20, 90), rng);
      await db.execute("UPDATE products SET created_at = ?, updated_at = ? WHERE id = ?", [when, when, pid]);
      productIds.push(pid);
    }
  }

  // A pending listing and a draft so the moderation queue and seller tabs have content.
  const pend = PRODUCTS[0];
  const extra: Array<[number, string]> = [
    [approved[1], "pending"],
    [sellerIds[3], "draft"],
  ];
  for (const [sellerId, status] of extra) {
    const data: ListingData = {
      title: "Rear Brake Pad Set — Ceramic",
      sku: `BOSC-REAR-${sellerId}`,
      categoryId: cats.get("Brake Pads")!,
      brandId: brands.get("Bosch")!,
      partNumber: "0 986 AB3 517",
      condition: "new",
      pricePaise: 139900,
      mrpPaise: 179900,
      stock: 14,
      gstRateBps: 1800,
      hsnCode: "8708",
      warrantyMonths: 6,
      weightGrams: 800,
      description: "Rear axle ceramic pad set for disc-rear variants.",
      isUniversal: false,
      oemNumbers: ["55800M68K00"],
      specs: [["Position", "Rear axle"]],
      variantIds: await variantIds(db, FIT_FOR_PENDING),
      imageIds: null,
    };
    const [pid] = await saveListing(db, sellerId, data, null, { submit: false });
    await attachArt(db, settings, sellerId, pend[1], pid);
    await setStatus(db, pid, status);
  }

  // Buyers, garages, addresses and order history across every fulfilment state.
  const buyers: Array<[number, Address]> = [];
  for (const [name, email, phone, [line1, line2, city, state, pincode]] of BUYERS) {
    const uid = await createUser(db, email, name, "buyer", DEMO_PASSWORD, phone, ago(rng.randint(40, 100), rng));
    await db.insert(
      `INSERT INTO addresses (user_id, full_name, phone, line1, line2, city, state, pincode, is_default, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, true, ?)`,
      [uid, name, phone, line1, line2, city, state, pincode, utcnow()],
    );
    const address = await db.one("SELECT * FROM addresses WHERE user_id = ?", [uid]);
    if (!address) throw new Error("seed: address missing");
    buyers.push([uid, address as unknown as Address]);
  }
  const swift = await db.one(
    "SELECT v.id FROM variants v JOIN models mo ON mo.id = v.model_id WHERE mo.name = 'Swift' AND v.name = 'VXi 1.2'",
  );
  if (!swift) throw new Error("seed: Swift VXi 1.2 variant missing");
  await db.insert(
    "INSERT INTO garage_vehicles (user_id, variant_id, year, nickname, created_at) VALUES (?, ?, 2019, 'Daily', ?)",
    [buyers[0][0], swift.id, utcnow()],
  );

  const plans: Array<[number, string, "online" | "cod"]> = [
    // [days ago, final state, payment]
    [26, "delivered", "online"],
    [24, "delivered", "cod"],
    [22, "delivered", "online"],
    [19, "delivered", "cod"],
    [17, "delivered", "online"],
    [15, "returned", "online"],
    [13, "delivered", "cod"],
    [11, "delivered", "online"],
    [9, "cancelled", "cod"],
    [8, "delivered", "online"],
    [6, "return_requested", "cod"],
    [5, "delivered", "cod"],
    [4, "shipped", "online"],
    [3, "shipped", "cod"],
    [2, "packed", "online"],
    [1.5, "placed", "cod"],
    [1, "placed", "online"],
    [0.5, "placed", "cod"],
    [0.2, "pending_payment", "online"],
  ];
  const inStock = (await db.all("SELECT id FROM products WHERE status = 'active' AND stock >= 4 ORDER BY id")).map((r) =>
    Number(r.id),
  );
  let orders = 0;
  for (const [i, [days, final, method]] of plans.entries()) {
    const [buyerId, address] = buyers[i % buyers.length];
    const picks = rng.sample(inStock, rng.choice([1, 1, 2, 2, 3]));
    for (const pid of picks) {
      await db.execute(
        `INSERT INTO cart_items (user_id, product_id, quantity, added_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (user_id, product_id) DO UPDATE SET quantity = EXCLUDED.quantity, added_at = EXCLUDED.added_at`,
        [buyerId, pid, rng.choice([1, 1, 2]), utcnow()],
      );
    }
    const orderId = await placeOrder(db, settings, {
      buyerId,
      address,
      paymentMethod: method,
      idempotencyKey: `seed-order-${String(i).padStart(4, "0")}-xxxxxxxx`,
      vehicleLabel: null,
    });
    orders += 1;
    if (method === "online" && final !== "pending_payment") {
      const intent = await db.scalar<string>("SELECT intent_id FROM payments WHERE order_id = ?", [orderId]);
      await settlePayment(db, orderId, intent!, true, buyerId);
    }
    const when = ago(days, rng);
    await db.execute("UPDATE orders SET created_at = ?, updated_at = ? WHERE id = ?", [when, when, orderId]);
    for (const f of await db.all("SELECT * FROM fulfilments WHERE order_id = ? ORDER BY id", [orderId])) {
      await walk(db, f, final, when, days, rng);
    }
    await db.execute("UPDATE fulfilments SET created_at = ? WHERE order_id = ?", [when, orderId]);
    await db.execute(
      "UPDATE fulfilment_events SET created_at = ? WHERE fulfilment_id IN (SELECT id FROM fulfilments WHERE order_id = ?)" +
        " AND status IN ('placed','pending_payment')",
      [when, orderId],
    );
    if (["delivered", "returned", "return_requested"].includes(final) && method === "cod") {
      await db.execute("UPDATE orders SET payment_status = 'cod_collected' WHERE id = ?", [orderId]);
    }
  }

  // Verified reviews on delivered items.
  const texts: Array<[number, string, string]> = [
    [5, "Exact fit, quick delivery", "Matched the part number on my old one. Fitted at my local garage in 20 minutes."],
    [4, "Good quality, well packed", "Genuine packaging and the invoice had GST. Took a day longer than shown."],
    [5, "Fits perfectly", "Used the vehicle selector and it was spot on for my car. Will buy again."],
    [4, "Works as expected", "Mechanic said the quality is the same as the dealer part, for less money."],
    [3, "Okay, box was dented", "Part itself was fine but the outer box was damaged in transit."],
  ];
  const delivered = await db.all(
    `SELECT DISTINCT oi.product_id, o.buyer_id FROM order_items oi JOIN fulfilments f ON f.id = oi.fulfilment_id
     JOIN orders o ON o.id = f.order_id WHERE f.status = 'delivered' ORDER BY oi.product_id, o.buyer_id`,
  );
  for (const [n, row] of delivered.entries()) {
    const [rating, title, body] = texts[n % texts.length];
    await db.execute(
      `INSERT INTO reviews (product_id, user_id, rating, title, body, created_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT DO NOTHING`,
      [row.product_id, row.buyer_id, rating, title, body, ago(rng.randint(1, 10), rng)],
    );
  }
  await db.execute(
    `UPDATE products SET rating_avg = COALESCE((SELECT AVG(rating) FROM reviews r WHERE r.product_id = products.id), 0),
            rating_count = (SELECT COUNT(*) FROM reviews r WHERE r.product_id = products.id)`,
  );
  await db.execute(
    `UPDATE sellers SET rating_avg = COALESCE((SELECT AVG(r.rating) FROM reviews r JOIN products p ON p.id = r.product_id
            WHERE p.seller_id = sellers.id), 0), rating_count = (SELECT COUNT(*) FROM reviews r JOIN products p
            ON p.id = r.product_id WHERE p.seller_id = sellers.id)`,
  );
  // Popularity signal for ranking on an otherwise fresh catalogue.
  for (const pid of productIds) {
    await db.execute("UPDATE products SET sold_count = sold_count + ? WHERE id = ?", [rng.randint(0, 140), pid]);
  }
  for (const pid of productIds) await reindexProduct(db, pid);
  await db.execute("DELETE FROM cart_items");
  await db.execute("DELETE FROM audit_log");
  return { products: productIds.length, orders, sellers: sellerIds.length, buyers: buyers.length };
}

const WALK_STEPS: Record<string, string[]> = {
  packed: ["packed"],
  shipped: ["packed", "shipped"],
  delivered: ["packed", "shipped", "delivered"],
  return_requested: ["packed", "shipped", "delivered", "return_requested"],
  returned: ["packed", "shipped", "delivered", "return_requested", "returned"],
  cancelled: ["cancelled"],
};

/** Advance a seeded fulfilment to `final` with plausible timestamps. */
async function walk(db: Db, f: Row, final: string, when: string, days: number, rng: Rng): Promise<void> {
  if (final === "pending_payment" || final === "placed") return;
  const base = new Date(when).getTime();
  const steps = WALK_STEPS[final];
  const span = Math.max(days - 0.1, 0.2);
  for (const [i, status] of steps.entries()) {
    const n = i + 1;
    const offset = Math.min((span * n) / (steps.length + 0.5), n * 1.4); // realistic courier pace: ~1-2 days per step
    const moment = isoUtc(new Date(base + offset * DAY));
    const updates: Record<string, unknown> = { status, updated_at: moment };
    let note: string | null = null;
    if (status === "shipped") {
      const carrier = rng.choice(["Delhivery", "Blue Dart", "DTDC", "Ekart"]);
      const tracking = `${carrier.slice(0, 2).toUpperCase()}${rng.randint(10 ** 9, 10 ** 10 - 1)}`;
      Object.assign(updates, { carrier, tracking_number: tracking, shipped_at: moment });
      note = `${carrier} · ${tracking}`;
    }
    if (status === "delivered") updates.delivered_at = moment;
    if (status === "cancelled") {
      updates.cancel_reason = "Ordered the wrong variant by mistake.";
      note = updates.cancel_reason as string;
      for (const item of await db.all("SELECT product_id, quantity FROM order_items WHERE fulfilment_id = ?", [f.id])) {
        await db.execute("UPDATE products SET stock = stock + ? WHERE id = ?", [item.quantity, item.product_id]);
      }
    }
    if (status === "return_requested") {
      updates.return_reason = "Connector is different from my car's original part.";
      note = updates.return_reason as string;
    }
    if (status === "returned") {
      updates.refund_paise = Number(f.items_paise) + Number(f.shipping_paise);
      note = "Return received and refunded";
    }
    const cols = Object.keys(updates)
      .map((k) => `${k} = ?`)
      .join(", ");
    await db.execute(`UPDATE fulfilments SET ${cols} WHERE id = ?`, [...Object.values(updates), f.id]);
    await db.insert("INSERT INTO fulfilment_events (fulfilment_id, status, note, created_at) VALUES (?, ?, ?, ?)", [
      f.id,
      status,
      note,
      moment,
    ]);
  }
  if (final === "returned") {
    await db.execute(
      "UPDATE orders SET payment_status = CASE WHEN payment_method = 'online' THEN 'refunded' ELSE payment_status END" +
        " WHERE id = ?",
      [f.order_id],
    );
  }
}

export async function runSeed(
  database: Database,
  settings: Settings,
  { reset }: { reset: boolean } = { reset: false },
): Promise<Record<string, number>> {
  if (isProduction(settings)) throw new Error("Refusing to load demo data in production.");
  if (reset) {
    // Drop every table, sequence and extension, then rebuild from the migrations
    // (0001_initial.sql recreates the pg_trgm and unaccent extensions).
    await database.withClient(async (db) => {
      await db.conn.query("DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;");
    });
    // Only the products folder is ever written by the app (services/media.ts), same as the Python reset.
    fs.rmSync(path.join(settings.uploadDir, "products"), { recursive: true, force: true });
  }
  await database.migrate();
  return database.writer(async (db) => {
    if (await db.scalar("SELECT COUNT(*) FROM makes")) {
      throw new Error("Database already has data. Use --reset to rebuild it.");
    }
    await seedMaster(db);
    return seedDemo(db, settings);
  });
}
