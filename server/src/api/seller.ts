// Seller portal: onboarding, dashboard, listings, photos, CSV import, order fulfilment, payouts.

import { z } from "zod";
import { DAY, type Row, utcnow } from "../db.js";
import { ApiError, type Ctx, RawResponse, api, conflict, notFound, pageMeta, paginate, pathInt } from "../http.js";
import { VARIANT_SELECT, mediaUrl, variantOut } from "../services/catalog.js";
import { STATUS_LABEL, ensureCan, getSettings, refundFulfilment, restock, transition } from "../services/commerce.js";
import { COLUMNS, applyImport, parseImport, toCsv } from "../services/csv_import.js";
import { type ListingData, listingEditable, saveListing, setStatus } from "../services/listings.js";
import { storeImage } from "../services/media.js";
import { GSTIN, IFSC, Int, LongText, PAN, Phone, Pincode, QueryBool, State, Text, optional } from "../util.js";
import { userPayload } from "./auth.js";
import { fulfilmentOut } from "./orders.js";

const pattern = (re: RegExp, source: string) => z.string().regex(re, `String should match pattern '${source}'`);

/** Query-string enum where "" means "not given" (pydantic `mode="before"` blank validator). */
function blankEnum<T extends [string, ...string[]]>(values: T) {
  return z.preprocess(
    (v) => (v === "" || v === undefined ? null : v),
    z.enum(values, { errorMap: () => ({ message: `Input should be ${quoteList(values)}` }) }).nullable(),
  );
}

function quoteList(values: readonly string[]): string {
  const quoted = values.map((v) => `'${v}'`);
  return quoted.length > 1 ? `${quoted.slice(0, -1).join(", ")} or ${quoted[quoted.length - 1]}` : quoted[0];
}

// ---- onboarding -------------------------------------------------------------------------------------

const ApplyFields = z.object({
  business_name: Text(3, 120),
  display_name: Text(3, 60),
  gstin: GSTIN,
  pan: PAN,
  phone: Phone,
  address_line: Text(5, 200),
  city: Text(2, 60),
  state: State,
  pincode: Pincode,
  bank_account_name: Text(3, 120),
  bank_account_number: pattern(/^\d{9,18}$/, "^\\d{9,18}$"),
  bank_ifsc: IFSC,
});

// The PAN/GSTIN cross-check runs only once every field is valid (like a pydantic model_validator).
export const ApplyIn = z.unknown().transform((value, ctx) => {
  const parsed = ApplyFields.safeParse(value);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) ctx.addIssue({ ...issue, code: z.ZodIssueCode.custom });
    return z.NEVER;
  }
  if (parsed.data.gstin.slice(2, 12) !== parsed.data.pan) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "PAN must match the PAN inside your GSTIN (characters 3–12)" });
    return z.NEVER;
  }
  return parsed.data;
});

api.route("POST", "/api/seller/apply", { auth: "user", body: ApplyIn, rate: "register", status: 201 }, async (ctx) => {
  const user = ctx.requireUser();
  const body = ctx.body;
  if (user.role === "admin") throw new ApiError(403, "forbidden", "Admin accounts can't register as sellers.");
  if (user.sellerId !== null) throw conflict("This account already has a seller profile.", "already_seller");
  if (await ctx.db.scalar("SELECT 1 FROM sellers WHERE gstin = ?", [body.gstin])) {
    throw new ApiError(409, "gstin_taken", "This GSTIN is already registered.", {
      fields: { gstin: "This GSTIN is already registered." },
    });
  }
  const sellerId = await ctx.db.insert(
    `INSERT INTO sellers (user_id, business_name, display_name, gstin, pan, phone, address_line, city, state,
         pincode, bank_account_name, bank_account_last4, bank_ifsc, kyc_status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
    [
      user.id,
      body.business_name,
      body.display_name,
      body.gstin,
      body.pan,
      body.phone,
      body.address_line,
      body.city,
      body.state,
      body.pincode,
      body.bank_account_name,
      body.bank_account_number.slice(-4),
      body.bank_ifsc,
      utcnow(),
    ],
  );
  await ctx.db.execute("UPDATE users SET role = 'seller', updated_at = ? WHERE id = ?", [utcnow(), user.id]);
  await ctx.audit("seller.applied", "seller", sellerId, { gstin: body.gstin });
  return userPayload(ctx.db, user.id);
});

const PROFILE_FIELDS = [
  "id",
  "business_name",
  "display_name",
  "gstin",
  "pan",
  "phone",
  "address_line",
  "city",
  "state",
  "pincode",
  "bank_account_name",
  "bank_account_last4",
  "bank_ifsc",
  "kyc_status",
  "kyc_note",
  "rating_avg",
  "rating_count",
  "created_at",
  "reviewed_at",
];

async function profile(ctx: Ctx): Promise<Row> {
  const row = await ctx.db.one(`SELECT ${PROFILE_FIELDS.join(", ")} FROM sellers WHERE id = ?`, [ctx.sellerId()]);
  if (!row) throw new Error("seller profile missing");
  return row;
}

api.route("GET", "/api/seller/profile", { auth: "seller" }, async (ctx) => profile(ctx));

const ProfileIn = z.object({
  display_name: Text(3, 60),
  phone: Phone,
  address_line: Text(5, 200),
  city: Text(2, 60),
  state: State,
  pincode: Pincode,
});

api.route("PATCH", "/api/seller/profile", { auth: "seller", body: ProfileIn, rate: "write" }, async (ctx) => {
  const b = ctx.body;
  await ctx.db.execute(
    "UPDATE sellers SET display_name=?, phone=?, address_line=?, city=?, state=?, pincode=? WHERE id=?",
    [b.display_name, b.phone, b.address_line, b.city, b.state, b.pincode, ctx.sellerId()],
  );
  return profile(ctx);
});

// ---- dashboard -----------------------------------------------------------------------------------------

const LIVE = "('placed','packed','shipped','delivered','return_requested')";

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

api.route("GET", "/api/seller/dashboard", { auth: "seller" }, async (ctx) => {
  const sellerId = ctx.sellerId();
  const nowMs = Date.now();
  const since = new Date(nowMs - 30 * DAY).toISOString().replace(/\.\d{3}Z$/, "+00:00");
  const kpis = await ctx.db.one(
    `SELECT
       COALESCE((SELECT SUM(items_paise) FROM fulfilments WHERE seller_id = ? AND status IN ${LIVE} AND created_at >= ?), 0) AS sales_30d,
       (SELECT COUNT(*) FROM fulfilments WHERE seller_id = ? AND status IN ${LIVE} AND created_at >= ?) AS orders_30d,
       (SELECT COUNT(*) FROM fulfilments WHERE seller_id = ? AND status IN ('placed','packed')) AS to_ship,
       (SELECT COUNT(*) FROM fulfilments WHERE seller_id = ? AND status = 'return_requested') AS returns_open,
       (SELECT COUNT(*) FROM products WHERE seller_id = ? AND status = 'active') AS active_listings,
       (SELECT COUNT(*) FROM products WHERE seller_id = ? AND status = 'pending') AS pending_listings,
       (SELECT COUNT(*) FROM products WHERE seller_id = ? AND status = 'rejected') AS rejected_listings,
       (SELECT COUNT(*) FROM products WHERE seller_id = ? AND status = 'active' AND stock <= 3) AS low_stock`,
    [sellerId, since, sellerId, since, sellerId, sellerId, sellerId, sellerId, sellerId, sellerId],
  );
  const days = await ctx.db.all(
    `SELECT to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, SUM(items_paise) AS sales, COUNT(*) AS orders
     FROM fulfilments WHERE seller_id = ? AND status IN ${LIVE} AND created_at >= ? GROUP BY 1 ORDER BY 1`,
    [sellerId, since],
  );
  const byDay = new Map(days.map((d) => [d.day as string, d]));
  const series = [];
  for (let offset = 29; offset >= 0; offset--) {
    const day = isoDay(new Date(nowMs - offset * DAY));
    const d = byDay.get(day);
    series.push({ day, sales_paise: d?.sales || 0, orders: d?.orders || 0 });
  }
  const top = await ctx.db.all(
    `SELECT oi.product_id, (array_agg(oi.title ORDER BY oi.id DESC))[1] AS title,
            (array_agg(oi.part_number ORDER BY oi.id DESC))[1] AS part_number,
            SUM(oi.quantity) AS units, SUM(oi.line_total_paise) AS revenue
     FROM order_items oi JOIN fulfilments f ON f.id = oi.fulfilment_id
     WHERE f.seller_id = ? AND f.status IN ${LIVE} AND f.created_at >= ?
     GROUP BY oi.product_id ORDER BY revenue DESC LIMIT 5`,
    [sellerId, since],
  );
  const queue = await ctx.db.all(
    `SELECT f.id, f.status, f.items_paise, f.created_at, o.number, o.ship_city,
            (SELECT SUM(quantity) FROM order_items WHERE fulfilment_id = f.id) AS units
     FROM fulfilments f JOIN orders o ON o.id = f.order_id
     WHERE f.seller_id = ? AND f.status IN ('placed','packed','return_requested') ORDER BY f.created_at LIMIT 6`,
    [sellerId],
  );
  return {
    kpis,
    series,
    top_products: top,
    queue: queue.map((q) => ({ ...q, status_label: STATUS_LABEL[q.status] })),
  };
});

// ---- listings ---------------------------------------------------------------------------------------

const SpecIn = z.object({
  label: Text(1, 40),
  value: Text(1, 120),
});

const GST_RATES = new Set([0, 500, 1200, 1800, 2800]);

/** Positive ids, de-duplicated keeping the first occurrence. */
function uniquePositive(max: number) {
  return z
    .array(Int)
    .max(max)
    .default([])
    .transform((v, ctx) => {
      if (v.some((i) => i <= 0)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid selection" });
        return z.NEVER;
      }
      return [...new Set(v)];
    });
}

export const ListingIn = z.object({
  title: Text(8, 150),
  sku: pattern(/^[A-Za-z0-9._-]{2,40}$/, "^[A-Za-z0-9._-]{2,40}$"),
  category_id: Int.pipe(z.number().gt(0)),
  brand_id: Int.pipe(z.number().gt(0)),
  part_number: Text(3, 40),
  oem_numbers: z.array(Text(3, 40)).max(20).default([]),
  condition: z
    .enum(["new", "oem_genuine"], { errorMap: () => ({ message: "Input should be 'new' or 'oem_genuine'" }) })
    .default("new"),
  price_paise: Int.pipe(z.number().gte(100).lte(100_000_000)),
  mrp_paise: Int.pipe(z.number().gte(100).lte(100_000_000)),
  stock: Int.pipe(z.number().gte(0).lte(100_000)),
  gst_rate_bps: Int.refine((v) => GST_RATES.has(v), "Input should be 0, 500, 1200, 1800 or 2800").default(1800),
  hsn_code: pattern(/^\d{4,8}$/, "^\\d{4,8}$").default("8708"),
  warranty_months: Int.pipe(z.number().gte(0).lte(120)).default(0),
  weight_grams: Int.pipe(z.number().gte(1).lte(100_000)).default(500),
  description: LongText(0, 4000).default(""),
  specs: z.array(SpecIn).max(20).default([]),
  is_universal: z.boolean().default(false),
  variant_ids: uniquePositive(600),
  image_ids: uniquePositive(8),
  submit: z.boolean().default(false),
});
type ListingInT = z.output<typeof ListingIn>;

function toData(b: ListingInT): ListingData {
  return {
    title: b.title,
    sku: b.sku,
    categoryId: b.category_id,
    brandId: b.brand_id,
    partNumber: b.part_number,
    condition: b.condition,
    pricePaise: b.price_paise,
    mrpPaise: b.mrp_paise,
    stock: b.stock,
    gstRateBps: b.gst_rate_bps,
    hsnCode: b.hsn_code,
    warrantyMonths: b.warranty_months,
    weightGrams: b.weight_grams,
    description: b.description,
    isUniversal: b.is_universal,
    oemNumbers: [...b.oem_numbers],
    specs: b.specs.map((s) => [s.label, s.value] as [string, string]),
    variantIds: b.variant_ids,
    imageIds: b.image_ids,
  };
}

const ListingsQuery = z.object({
  status: blankEnum(["draft", "pending", "active", "rejected", "archived", "low_stock"]),
  q: z.string().max(80).default(""),
  page: Int.pipe(z.number().gte(1).lte(1000)).default(1),
  per_page: Int.pipe(z.number().gte(1).lte(100)).default(20),
});

function likePattern(q: string): string {
  return `%${q.replace(/([%_\\])/g, "\\$1")}%`;
}

api.route("GET", "/api/seller/products", { auth: "seller", query: ListingsQuery }, async (ctx) => {
  const sellerId = ctx.sellerId();
  const q = ctx.query;
  const where = ["p.seller_id = ?"];
  const params: unknown[] = [sellerId];
  if (q.status === "low_stock") {
    where.push("p.status = 'active' AND p.stock <= 3");
  } else if (q.status) {
    where.push("p.status = ?");
    params.push(q.status);
  } else {
    where.push("p.status != 'archived'");
  }
  if (q.q.trim()) {
    // SQLite LIKE was case-insensitive for ASCII; ILIKE keeps that behaviour.
    where.push("(p.title ILIKE ? ESCAPE '\\' OR p.sku ILIKE ? ESCAPE '\\' OR p.part_number ILIKE ? ESCAPE '\\')");
    const like = likePattern(q.q.trim());
    params.push(like, like, like);
  }
  const clause = where.join(" AND ");
  const { limit, offset } = paginate(q.page, q.per_page);
  const total = Number(await ctx.db.scalar(`SELECT COUNT(*) FROM products p WHERE ${clause}`, params));
  const rows = await ctx.db.all(
    `SELECT p.id, p.sku, p.title, p.part_number, p.price_paise, p.mrp_paise, p.stock, p.status,
            p.moderation_note, p.sold_count, p.updated_at, p.is_universal, b.name AS brand, c.name AS category,
            (SELECT COUNT(*) FROM product_fitments f WHERE f.product_id = p.id) AS fitment_count,
            (SELECT m.thumb_path FROM media m WHERE m.product_id = p.id ORDER BY m.position, m.id LIMIT 1) AS thumb
     FROM products p JOIN brands b ON b.id = p.brand_id JOIN categories c ON c.id = p.category_id
     WHERE ${clause} ORDER BY p.updated_at DESC, p.id DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );
  const counts: Record<string, number> = {};
  for (const r of await ctx.db.all("SELECT status, COUNT(*) AS n FROM products WHERE seller_id = ? GROUP BY status", [
    sellerId,
  ])) {
    counts[r.status] = r.n;
  }
  counts.low_stock = Number(
    await ctx.db.scalar("SELECT COUNT(*) FROM products WHERE seller_id = ? AND status = 'active' AND stock <= 3", [
      sellerId,
    ]),
  );
  const items = rows.map(({ thumb, ...rest }) => ({
    ...rest,
    image: mediaUrl(thumb),
    is_universal: Boolean(rest.is_universal),
  }));
  return { items, counts, ...pageMeta(total, q.page, limit) };
});

async function ownProduct(ctx: Ctx, sellerId: number): Promise<number> {
  const productId = pathInt(ctx, "product_id");
  if (!(await ctx.db.scalar("SELECT 1 FROM products WHERE id = ? AND seller_id = ?", [productId, sellerId]))) {
    throw notFound("Listing");
  }
  return productId;
}

api.route("GET", "/api/seller/products/{product_id:int}", { auth: "seller" }, async (ctx) => {
  return listingEditable(ctx.db, await ownProduct(ctx, ctx.sellerId()));
});

api.route(
  "POST",
  "/api/seller/products",
  { auth: "seller", body: ListingIn, rate: "write", status: 201 },
  async (ctx) => {
    const body = ctx.body;
    const sellerId = body.submit ? ctx.approvedSellerId() : ctx.sellerId();
    const [productId, status] = await saveListing(ctx.db, sellerId, toData(body), null, { submit: body.submit });
    await ctx.audit("listing.created", "product", productId, { status });
    return listingEditable(ctx.db, productId);
  },
);

api.route(
  "PUT",
  "/api/seller/products/{product_id:int}",
  { auth: "seller", body: ListingIn, rate: "write" },
  async (ctx) => {
    const body = ctx.body;
    const sellerId = body.submit ? ctx.approvedSellerId() : ctx.sellerId();
    const productId = await ownProduct(ctx, sellerId);
    const [, status] = await saveListing(ctx.db, sellerId, toData(body), productId, { submit: body.submit });
    await ctx.audit("listing.updated", "product", productId, { status });
    return listingEditable(ctx.db, productId);
  },
);

const InventoryIn = z.object({
  price_paise: optional(Int.pipe(z.number().gte(100).lte(100_000_000))),
  mrp_paise: optional(Int.pipe(z.number().gte(100).lte(100_000_000))),
  stock: optional(Int.pipe(z.number().gte(0).lte(100_000))),
});

api.route(
  "PATCH",
  "/api/seller/products/{product_id:int}/inventory",
  { auth: "seller", body: InventoryIn, rate: "write" },
  async (ctx) => {
    const sellerId = ctx.sellerId();
    const productId = await ownProduct(ctx, sellerId);
    // Row lock: a concurrent checkout's conditional stock decrement waits for this write (and vice versa).
    const row = await ctx.db.one("SELECT price_paise, mrp_paise, stock FROM products WHERE id = ? FOR UPDATE", [
      productId,
    ]);
    if (!row) throw notFound("Listing");
    const b = ctx.body;
    const price = b.price_paise ?? row.price_paise;
    const mrp = b.mrp_paise ?? row.mrp_paise;
    const stock = b.stock ?? row.stock;
    if (mrp < price) {
      throw new ApiError(422, "validation_error", "MRP can't be lower than your selling price.", {
        fields: { mrp_paise: "MRP can't be lower than your selling price." },
      });
    }
    await ctx.db.execute("UPDATE products SET price_paise = ?, mrp_paise = ?, stock = ?, updated_at = ? WHERE id = ?", [
      price,
      mrp,
      stock,
      utcnow(),
      productId,
    ]);
    await ctx.audit("listing.inventory", "product", productId, { price_paise: price, stock });
    return { id: productId, price_paise: price, mrp_paise: mrp, stock };
  },
);

const PRODUCT_ACTIONS = new Set(["submit", "archive", "restore"]);

api.route("POST", "/api/seller/products/{product_id:int}/{action}", { auth: "seller", rate: "write" }, async (ctx) => {
  const action = String(ctx.path.action);
  if (!PRODUCT_ACTIONS.has(action)) throw notFound();
  const sellerId = action === "submit" ? ctx.approvedSellerId() : ctx.sellerId();
  const productId = await ownProduct(ctx, sellerId);
  const status = await ctx.db.scalar<string>("SELECT status FROM products WHERE id = ? FOR UPDATE", [productId]);
  if (action === "submit") {
    if (status !== "draft" && status !== "rejected") {
      throw conflict("Only drafts and rejected listings can be submitted.", "invalid_state");
    }
    const data = await listingEditable(ctx.db, productId);
    if (!data.is_universal && !data.fitment.length) {
      throw new ApiError(422, "validation_error", "Add at least one vehicle this part fits, or mark it as universal.", {
        fields: { variant_ids: "Add at least one vehicle." },
      });
    }
    if (!data.images.length) {
      throw new ApiError(422, "validation_error", "Add at least one photo before submitting for review.", {
        fields: { image_ids: "Add at least one photo." },
      });
    }
    await setStatus(ctx.db, productId, "pending");
  } else if (action === "archive") {
    if (status === "archived") throw conflict("This listing is already archived.", "invalid_state");
    await setStatus(ctx.db, productId, "archived");
  } else {
    if (status !== "archived") throw conflict("Only archived listings can be restored.", "invalid_state");
    await setStatus(ctx.db, productId, "draft");
  }
  await ctx.audit(`listing.${action}`, "product", productId);
  return listingEditable(ctx.db, productId);
});

api.route("POST", "/api/seller/media", { auth: "seller", upload: "image", rate: "upload", status: 201 }, async (ctx) => {
  const sellerId = ctx.sellerId();
  if (!ctx.upload) throw new Error("upload missing");
  const unattached = Number(
    await ctx.db.scalar("SELECT COUNT(*) FROM media WHERE seller_id = ? AND product_id IS NULL", [sellerId]),
  );
  if (unattached >= 100) {
    throw new ApiError(429, "too_many_uploads", "Attach or remove your recent uploads before adding more.");
  }
  const stored = await storeImage(ctx.upload.data, ctx.settings);
  const mediaId = await ctx.db.insert(
    "INSERT INTO media (seller_id, path, thumb_path, width, height, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    [sellerId, stored.path, stored.thumbPath, stored.width, stored.height, utcnow()],
  );
  return {
    id: mediaId,
    url: mediaUrl(stored.path),
    thumb: mediaUrl(stored.thumbPath),
    width: stored.width,
    height: stored.height,
  };
});

// ---- CSV import -----------------------------------------------------------------------------------------

function csvResponse(name: string, body: string): RawResponse {
  return new RawResponse(body, "text/csv; charset=utf-8", { "content-disposition": `attachment; filename="${name}"` });
}

api.route("GET", "/api/seller/import/template.csv", { auth: "seller" }, async (ctx) => {
  const codes = (
    await ctx.db.all(
      "SELECT v.code FROM variants v JOIN models mo ON mo.id = v.model_id WHERE v.is_active ORDER BY mo.name = 'Swift' DESC, v.id LIMIT 2",
    )
  )
    .map((r) => r.code)
    .join(" ");
  const example = [
    "BP-SWIFT-F-01",
    "Front brake pad set for Maruti Swift / Dzire",
    "brake-pads",
    "bosch",
    "0 986 AB2 145",
    "55810M68K00",
    "new",
    "1249",
    "1650",
    "25",
    "18",
    "8708",
    "6",
    "900",
    "no",
    codes,
    "Low-dust ceramic compound. Includes wear sensor clip.",
  ];
  return csvResponse("partpilot-listing-template.csv", toCsv(COLUMNS, [example]));
});

api.route("GET", "/api/seller/import/reference.csv", { auth: "seller" }, async (ctx) => {
  const rows: unknown[][] = (
    await ctx.db.all(`${VARIANT_SELECT} WHERE v.is_active ORDER BY mk.name, mo.name, v.year_from`)
  )
    .map(variantOut)
    .map((v) => [v.code, v.make, v.model, v.name, v.years, v.fuel_label, v.transmission_label]);
  rows.push([]);
  for (const c of await ctx.db.all("SELECT slug, name FROM categories WHERE is_active ORDER BY slug")) {
    rows.push(["category", c.slug, c.name]);
  }
  for (const b of await ctx.db.all("SELECT slug, name FROM brands WHERE is_active ORDER BY slug")) {
    rows.push(["brand", b.slug, b.name]);
  }
  return csvResponse(
    "partpilot-codes.csv",
    toCsv(["code", "make_or_type", "model_or_name", "variant", "years", "fuel", "transmission"], rows),
  );
});

const ImportQuery = z.object({
  dry_run: QueryBool.default(true),
});

api.route(
  "POST",
  "/api/seller/import",
  { auth: "seller", upload: "csv", query: ImportQuery, rate: "upload" },
  async (ctx) => {
    const sellerId = ctx.sellerId();
    if (!ctx.upload) throw new Error("upload missing");
    const [parsed, errors] = await parseImport(ctx.db, sellerId, ctx.upload.data);
    const summary = {
      rows: parsed.length,
      new: parsed.filter((p) => p[2] === null).length,
      updates: parsed.filter((p) => p[2] !== null).length,
    };
    if (errors.length || ctx.query.dry_run) {
      return { ok: !errors.length, dry_run: true, errors: errors.slice(0, 200), error_count: errors.length, ...summary };
    }
    const result = await applyImport(ctx.db, sellerId, parsed);
    await ctx.audit("listing.imported", "seller", sellerId, result);
    return { ok: true, dry_run: false, errors: [], error_count: 0, ...summary, ...result };
  },
);

// ---- fulfilment ---------------------------------------------------------------------------------------

const SellerOrdersQuery = z.object({
  status: blankEnum(["to_ship", "placed", "packed", "shipped", "delivered", "cancelled", "return_requested", "returned"]),
  q: z.string().max(40).default(""),
  page: Int.pipe(z.number().gte(1).lte(1000)).default(1),
  per_page: Int.pipe(z.number().gte(1).lte(100)).default(20),
});

api.route("GET", "/api/seller/orders", { auth: "seller", query: SellerOrdersQuery }, async (ctx) => {
  const sellerId = ctx.sellerId();
  const q = ctx.query;
  const where = ["f.seller_id = ?", "f.status != 'pending_payment'"];
  const params: unknown[] = [sellerId];
  if (q.status === "to_ship") {
    where.push("f.status IN ('placed','packed')");
  } else if (q.status) {
    where[1] = "f.status = ?";
    params.push(q.status);
  }
  if (q.q.trim()) {
    where.push("o.number ILIKE ?");
    params.push(`%${q.q.trim().replace(/[^A-Za-z0-9-]/g, "")}%`);
  }
  const clause = where.join(" AND ");
  const { limit, offset } = paginate(q.page, q.per_page);
  const total = Number(
    await ctx.db.scalar(`SELECT COUNT(*) FROM fulfilments f JOIN orders o ON o.id = f.order_id WHERE ${clause}`, params),
  );
  const rows = await ctx.db.all(
    `SELECT f.id, f.status, f.items_paise, f.shipping_paise, f.created_at, f.tracking_number, f.carrier,
            o.number, o.ship_city, o.ship_state, o.payment_method,
            (SELECT SUM(quantity) FROM order_items WHERE fulfilment_id = f.id) AS units,
            (SELECT title FROM order_items WHERE fulfilment_id = f.id ORDER BY id LIMIT 1) AS first_item
     FROM fulfilments f JOIN orders o ON o.id = f.order_id WHERE ${clause}
     ORDER BY f.created_at DESC, f.id DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );
  const counts: Record<string, number> = {};
  for (const r of await ctx.db.all("SELECT status, COUNT(*) AS n FROM fulfilments WHERE seller_id = ? GROUP BY status", [
    sellerId,
  ])) {
    counts[r.status] = r.n;
  }
  counts.to_ship = (counts.placed ?? 0) + (counts.packed ?? 0);
  return {
    items: rows.map((r) => ({ ...r, status_label: STATUS_LABEL[r.status] })),
    counts,
    ...pageMeta(total, q.page, limit),
  };
});

async function ownFulfilment(ctx: Ctx, sellerId: number, opts: { lock?: boolean } = {}): Promise<Row> {
  const f = await ctx.db.one(
    `SELECT * FROM fulfilments WHERE id = ? AND seller_id = ?${opts.lock ? " FOR UPDATE" : ""}`,
    [pathInt(ctx, "fulfilment_id"), sellerId],
  );
  if (!f || f.status === "pending_payment") throw notFound("Order");
  return f;
}

// action -> fulfilment states it is offered from
const SELLER_ACTIONS: Record<string, Set<string>> = {
  pack: new Set(["placed"]),
  ship: new Set(["packed"]),
  deliver: new Set(["shipped"]),
  cancel: new Set(["placed", "packed"]),
  accept_return: new Set(["return_requested"]),
  reject_return: new Set(["return_requested"]),
};

export async function sellerFulfilmentDetail(ctx: Ctx, f: Row) {
  const order = await ctx.db.one("SELECT * FROM orders WHERE id = ?", [f.order_id]);
  const seller = await ctx.db.one(
    "SELECT display_name, business_name, gstin, address_line, city, state, pincode, phone FROM sellers WHERE id = ?",
    [f.seller_id],
  );
  if (!order || !seller) throw new Error("order or seller missing");
  f.seller_name = seller.display_name;
  const days = (await getSettings(ctx.db, ctx.settings)).return_window_days;
  const out = await fulfilmentOut(ctx.db, f, { returnDays: days, perspective: "seller" });
  return {
    ...out,
    order: {
      id: order.id,
      number: order.number,
      created_at: order.created_at,
      payment_method: order.payment_method,
      payment_status: order.payment_status,
      vehicle_label: order.vehicle_label,
    },
    ship_to: {
      full_name: order.ship_name,
      phone: order.ship_phone,
      line1: order.ship_line1,
      line2: order.ship_line2,
      landmark: order.ship_landmark,
      city: order.ship_city,
      state: order.ship_state,
      pincode: order.ship_pincode,
    },
    ship_from: seller,
    commission_paise: f.commission_paise,
    commission_bps: f.commission_bps,
    tcs_paise: f.tcs_paise,
    net_paise: f.items_paise + f.shipping_paise - f.commission_paise - f.tcs_paise,
    cod_amount_paise: order.payment_method === "cod" ? f.items_paise + f.shipping_paise : 0,
    actions: Object.entries(SELLER_ACTIONS)
      .filter(([, allowed]) => allowed.has(f.status))
      .map(([a]) => a),
  };
}

api.route("GET", "/api/seller/orders/{fulfilment_id:int}", { auth: "seller" }, async (ctx) => {
  return sellerFulfilmentDetail(ctx, await ownFulfilment(ctx, ctx.sellerId()));
});

export const FulfilmentActionIn = z.object({
  carrier: optional(Text(2, 60)),
  tracking_number: optional(pattern(/^[A-Za-z0-9-]{6,40}$/, "^[A-Za-z0-9-]{6,40}$")),
  reason: optional(LongText(0, 500)),
});
export type FulfilmentActionInT = z.output<typeof FulfilmentActionIn>;

api.route(
  "POST",
  "/api/seller/orders/{fulfilment_id:int}/{action}",
  { auth: "seller", body: FulfilmentActionIn, rate: "write" },
  async (ctx) => {
    const action = String(ctx.path.action);
    if (!(action in SELLER_ACTIONS)) throw notFound();
    const sellerId = ctx.approvedSellerId();
    const f = await ownFulfilment(ctx, sellerId, { lock: true });
    const user = ctx.requireUser();
    await applyFulfilmentAction(ctx, f, action, "seller", user.id, ctx.body);
    await ctx.audit(`fulfilment.${action}`, "fulfilment", f.id);
    const fresh = await ctx.db.one("SELECT * FROM fulfilments WHERE id = ?", [f.id]);
    if (!fresh) throw new Error("fulfilment missing");
    return sellerFulfilmentDetail(ctx, fresh);
  },
);

type Actor = Parameters<typeof transition>[3];

export async function applyFulfilmentAction(
  ctx: Ctx,
  f: Row,
  action: string,
  actor: Actor,
  actorUserId: number,
  body: FulfilmentActionInT,
): Promise<void> {
  const now = utcnow();
  ensureCan(f, action === "cancel" ? "cancel_seller" : action);
  if (action === "pack") {
    await transition(ctx.db, f, "pack", actor, actorUserId);
  } else if (action === "ship") {
    if (!body.carrier || !body.tracking_number) {
      const fields: Record<string, string> = {};
      if (!body.carrier) fields.carrier = "Required.";
      if (!body.tracking_number) fields.tracking_number = "Required.";
      throw new ApiError(422, "validation_error", "Enter the courier and tracking number.", { fields });
    }
    await transition(ctx.db, f, "ship", actor, actorUserId, `${body.carrier} · ${body.tracking_number}`, {
      carrier: body.carrier,
      tracking_number: body.tracking_number.toUpperCase(),
      shipped_at: now,
    });
  } else if (action === "deliver") {
    await transition(ctx.db, f, "deliver", actor, actorUserId, null, { delivered_at: now });
    const order = await ctx.db.one("SELECT payment_method FROM orders WHERE id = ?", [f.order_id]);
    if (
      order &&
      order.payment_method === "cod" &&
      !(await ctx.db.scalar("SELECT 1 FROM fulfilments WHERE order_id = ? AND status IN ('placed','packed','shipped')", [
        f.order_id,
      ]))
    ) {
      await ctx.db.execute("UPDATE orders SET payment_status = 'cod_collected', updated_at = ? WHERE id = ?", [
        now,
        f.order_id,
      ]);
    }
  } else if (action === "cancel") {
    if (!body.reason || body.reason.length < 3) {
      throw new ApiError(422, "validation_error", "Tell the buyer why the order is cancelled.", {
        fields: { reason: "Add a short reason." },
      });
    }
    await transition(ctx.db, f, "cancel_seller", actor, actorUserId, body.reason, { cancel_reason: body.reason });
    await restock(ctx.db, f.id);
    await refundFulfilment(ctx.db, f);
  } else if (action === "accept_return") {
    await transition(ctx.db, f, "accept_return", actor, actorUserId, body.reason || "Return accepted");
    await restock(ctx.db, f.id);
    await refundFulfilment(ctx.db, f);
  } else if (action === "reject_return") {
    if (!body.reason || body.reason.length < 3) {
      throw new ApiError(422, "validation_error", "Explain why the return is declined.", {
        fields: { reason: "Add a short reason." },
      });
    }
    await transition(ctx.db, f, "reject_return", actor, actorUserId, body.reason);
  }
}

// ---- payouts --------------------------------------------------------------------------------------------

export async function payoutLines(ctx: Ctx, sellerId: number) {
  const days = (await getSettings(ctx.db, ctx.settings)).return_window_days;
  const cutoff = Date.now() - days * DAY;
  const rows = await ctx.db.all(
    `SELECT f.id, f.items_paise, f.shipping_paise, f.commission_paise, f.tcs_paise, f.delivered_at,
            o.number FROM fulfilments f JOIN orders o ON o.id = f.order_id
     WHERE f.seller_id = ? AND f.status = 'delivered' AND f.payout_id IS NULL ORDER BY f.delivered_at`,
    [sellerId],
  );
  const eligible: Row[] = [];
  const holding: Row[] = [];
  for (const r of rows) {
    r.net_paise = r.items_paise + r.shipping_paise - r.commission_paise - r.tcs_paise;
    // Whole seconds, like the Python ISO-string comparison.
    const deliveredMs = new Date(r.delivered_at).getTime();
    (deliveredMs <= Math.floor(cutoff / 1000) * 1000 ? eligible : holding).push(r);
  }
  return { eligible, holding, return_window_days: days };
}

api.route("GET", "/api/seller/payouts", { auth: "seller" }, async (ctx) => {
  const sellerId = ctx.sellerId();
  const lines = await payoutLines(ctx, sellerId);
  const history = await ctx.db.all("SELECT * FROM payouts WHERE seller_id = ? ORDER BY id DESC LIMIT 50", [sellerId]);
  const inTransit = await ctx.db.one(
    `SELECT COALESCE(SUM(items_paise + shipping_paise - commission_paise - tcs_paise), 0) AS net, COUNT(*) AS n
     FROM fulfilments WHERE seller_id = ? AND status IN ('placed','packed','shipped')`,
    [sellerId],
  );
  const sum = (rows: Row[]) => rows.reduce((s, r) => s + Number(r.net_paise), 0);
  return {
    eligible_paise: sum(lines.eligible),
    holding_paise: sum(lines.holding),
    in_transit_paise: inTransit ? inTransit.net : 0,
    paid_paise: sum(history),
    ...lines,
    history,
  };
});
