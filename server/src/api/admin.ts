// Admin portal: dashboard, seller KYC, listing moderation, master data, orders, users, payouts,
// settings and the audit trail. Every state-changing action writes an audit entry.

import { randomBytes } from "node:crypto";
import { z } from "zod";
import { DAY, type Row, placeholders, utcnow, addMs } from "../db.js";
import { ApiError, type Ctx, api, badRequest, conflict, forbidden, notFound, pageMeta, paginate, pathInt } from "../http.js";
import { destroyUserSessions } from "../security/sessions.js";
import { TRANSMISSION_LABEL, VARIANT_SELECT, categoryTree, mediaUrl, variantOut } from "../services/catalog.js";
import { SETTING_KEYS, STATUS_LABEL, cancelUnpaidOrder, getSettings } from "../services/commerce.js";
import { listingEditable, setStatus } from "../services/listings.js";
import { Int, LongText, Text, optional, slugify } from "../util.js";
import { fulfilmentOut, invoiceResponse, orderOut } from "./orders.js";
import { FulfilmentActionIn, applyFulfilmentAction, payoutLines } from "./seller.js";

/** LIKE pattern with %, _ and \ escaped (used with ESCAPE '\'). */
function like(q: string): string {
  return `%${q.trim().replace(/([%_\\])/g, "\\$1")}%`;
}

/** Query-string value where "" means "not provided". */
function blankToNull(maxLen: number) {
  return z.preprocess((v) => (v === "" ? null : v), optional(z.string().max(maxLen)));
}

const PageQuery = z.object({
  q: z.string().max(80).default(""),
  status: blankToNull(30),
  page: Int.pipe(z.number().min(1).max(1000)).default(1),
  per_page: Int.pipe(z.number().min(1).max(100)).default(20),
});

const LIVE = "('placed','packed','shipped','delivered','return_requested')";

/** Admin order tabs: an order is in a tab when any of its shipments is in one of these states. */
const ADMIN_ORDER_GROUPS: Record<string, string[]> = {
  to_ship: ["placed", "packed"],
  shipped: ["shipped"],
  delivered: ["delivered"],
  returns: ["return_requested", "returned"],
  cancelled: ["cancelled"],
  unpaid: ["pending_payment"],
};
const hasShipmentIn = (states: string[]) =>
  `EXISTS (SELECT 1 FROM fulfilments f WHERE f.order_id = o.id AND f.status IN (${states.map((s) => `'${s}'`).join(",")}))`;

// ---- dashboard -------------------------------------------------------------------------------------------

api.route("GET", "/api/admin/dashboard", { auth: "admin" }, async (ctx) => {
  const since = addMs(-30 * DAY);
  const lateCutoff = addMs(-2 * DAY);
  const kpis = await ctx.db.one(
    `SELECT
       COALESCE((SELECT SUM(items_paise + shipping_paise) FROM fulfilments WHERE status IN ${LIVE} AND created_at >= ?), 0) AS gmv_30d,
       COALESCE((SELECT SUM(commission_paise) FROM fulfilments WHERE status IN ${LIVE} AND created_at >= ?), 0) AS commission_30d,
       (SELECT COUNT(*) FROM orders WHERE created_at >= ?) AS orders_30d,
       (SELECT COUNT(*) FROM users WHERE role = 'buyer' AND created_at >= ?) AS new_buyers_30d,
       (SELECT COUNT(*) FROM sellers WHERE kyc_status = 'approved') AS active_sellers,
       (SELECT COUNT(*) FROM sellers WHERE kyc_status = 'pending') AS pending_sellers,
       (SELECT COUNT(*) FROM products WHERE status = 'pending') AS pending_listings,
       (SELECT COUNT(*) FROM products WHERE status = 'active') AS active_listings,
       (SELECT COUNT(*) FROM fulfilments WHERE status = 'return_requested') AS open_returns,
       (SELECT COUNT(*) FROM fulfilments WHERE status IN ('placed','packed') AND created_at <= ?) AS late_shipments`,
    [since, since, since, since, lateCutoff],
  );
  // 30 UTC calendar days ending today (oldest first), zero-filled. Python bucketed on the first 10
  // characters of the UTC ISO timestamp, so bucket on the UTC date here too.
  const series = await ctx.db.all(
    `WITH days AS (
       SELECT to_char(d, 'YYYY-MM-DD') AS day
       FROM generate_series(((now() AT TIME ZONE 'UTC')::date - 29)::timestamp,
                            (now() AT TIME ZONE 'UTC')::date::timestamp, interval '1 day') AS d
     ), agg AS (
       SELECT to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day,
              SUM(items_paise + shipping_paise) AS gmv, COUNT(DISTINCT order_id) AS orders
       FROM fulfilments WHERE status IN ${LIVE} AND created_at >= ? GROUP BY 1
     )
     SELECT days.day, COALESCE(agg.gmv, 0) AS gmv_paise, COALESCE(agg.orders, 0) AS orders
     FROM days LEFT JOIN agg ON agg.day = days.day ORDER BY days.day`,
    [since],
  );
  const topSellers = await ctx.db.all(
    `SELECT s.id, s.display_name, s.city, SUM(f.items_paise) AS sales, COUNT(*) AS orders
     FROM fulfilments f JOIN sellers s ON s.id = f.seller_id
     WHERE f.status IN ${LIVE} AND f.created_at >= ? GROUP BY s.id ORDER BY sales DESC LIMIT 5`,
    [since],
  );
  const topCategories = await ctx.db.all(
    `SELECT c.name, SUM(oi.line_total_paise) AS sales FROM order_items oi
     JOIN fulfilments f ON f.id = oi.fulfilment_id JOIN products p ON p.id = oi.product_id
     JOIN categories c ON c.id = p.category_id
     WHERE f.status IN ${LIVE} AND f.created_at >= ? GROUP BY c.id ORDER BY sales DESC LIMIT 6`,
    [since],
  );
  return { kpis, series, top_sellers: topSellers, top_categories: topCategories };
});

// ---- sellers ----------------------------------------------------------------------------------------------

api.route("GET", "/api/admin/sellers", { auth: "admin", query: PageQuery }, async (ctx) => {
  const q = ctx.query;
  const where = ["1=1"];
  const params: unknown[] = [];
  if (q.status) {
    where.push("s.kyc_status = ?");
    params.push(q.status);
  }
  if (q.q.trim()) {
    where.push(
      "(s.business_name ILIKE ? ESCAPE '\\' OR s.display_name ILIKE ? ESCAPE '\\' OR s.gstin ILIKE ? ESCAPE '\\' OR u.email ILIKE ? ESCAPE '\\')",
    );
    const pattern = like(q.q);
    params.push(pattern, pattern, pattern, pattern);
  }
  const clause = where.join(" AND ");
  const { limit, offset } = paginate(q.page, q.per_page);
  const total = Number(
    await ctx.db.scalar(`SELECT COUNT(*) FROM sellers s JOIN users u ON u.id = s.user_id WHERE ${clause}`, params),
  );
  const rows = await ctx.db.all(
    `SELECT s.id, s.business_name, s.display_name, s.gstin, s.city, s.state, s.kyc_status, s.created_at,
            s.rating_avg, s.rating_count, u.email,
            (SELECT COUNT(*) FROM products p WHERE p.seller_id = s.id AND p.status = 'active') AS active_listings
     FROM sellers s JOIN users u ON u.id = s.user_id WHERE ${clause}
     ORDER BY CASE s.kyc_status WHEN 'pending' THEN 0 ELSE 1 END, s.created_at DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );
  const counts: Record<string, number> = {};
  for (const r of await ctx.db.all("SELECT kyc_status, COUNT(*) AS n FROM sellers GROUP BY kyc_status")) {
    counts[r.kyc_status] = r.n;
  }
  return { items: rows, counts, ...pageMeta(total, q.page, limit) };
});

async function sellerDetail(ctx: Ctx, sellerId: number) {
  const row = await ctx.db.one(
    "SELECT s.*, u.email, u.full_name, u.status AS user_status FROM sellers s JOIN users u ON u.id = s.user_id WHERE s.id = ?",
    [sellerId],
  );
  if (!row) throw notFound("Seller");
  const stats = await ctx.db.one(
    `SELECT (SELECT COUNT(*) FROM products WHERE seller_id = ?) AS listings,
            (SELECT COUNT(*) FROM products WHERE seller_id = ? AND status = 'active') AS active_listings,
            (SELECT COUNT(*) FROM fulfilments WHERE seller_id = ?) AS orders,
            COALESCE((SELECT SUM(items_paise) FROM fulfilments WHERE seller_id = ? AND status = 'delivered'), 0) AS delivered_paise,
            (SELECT COUNT(*) FROM fulfilments WHERE seller_id = ? AND status = 'cancelled') AS cancelled`,
    [sellerId, sellerId, sellerId, sellerId, sellerId],
  );
  const history = await ctx.db.all(
    "SELECT action, detail, created_at FROM audit_log WHERE entity = 'seller' AND entity_id = ? ORDER BY id DESC LIMIT 20",
    [String(sellerId)],
  );
  return { ...row, stats, history };
}

api.route("GET", "/api/admin/sellers/{seller_id:int}", { auth: "admin" }, async (ctx) =>
  sellerDetail(ctx, pathInt(ctx, "seller_id")),
);

const SellerReviewIn = z.object({
  decision: z.enum(["approve", "reject", "suspend", "reinstate"]),
  note: LongText(0, 500).default(""),
});

const REVIEW_ALLOWED: Record<string, Set<string>> = {
  approve: new Set(["pending", "rejected"]),
  reject: new Set(["pending"]),
  suspend: new Set(["approved"]),
  reinstate: new Set(["suspended"]),
};
const REVIEW_TARGET: Record<string, string> = {
  approve: "approved",
  reject: "rejected",
  suspend: "suspended",
  reinstate: "approved",
};

api.route(
  "POST",
  "/api/admin/sellers/{seller_id:int}/review",
  { auth: "admin", body: SellerReviewIn, rate: "write" },
  async (ctx) => {
    const sellerId = pathInt(ctx, "seller_id");
    // Lock the row so two admins reviewing at once can't both pass the transition check.
    const seller = await ctx.db.one("SELECT id, kyc_status, user_id FROM sellers WHERE id = ? FOR NO KEY UPDATE", [sellerId]);
    if (!seller) throw notFound("Seller");
    const b = ctx.body;
    const target = REVIEW_TARGET[b.decision];
    if (!REVIEW_ALLOWED[b.decision].has(seller.kyc_status)) {
      throw conflict(`A ${seller.kyc_status} seller can't be moved to ${target}.`, "invalid_transition");
    }
    if ((b.decision === "reject" || b.decision === "suspend") && b.note.length < 5) {
      throw new ApiError(422, "validation_error", "Add a note the seller will see.", {
        fields: { note: "Explain the decision." },
      });
    }
    await ctx.db.execute("UPDATE sellers SET kyc_status = ?, kyc_note = ?, reviewed_at = ? WHERE id = ?", [
      target,
      b.note || null,
      utcnow(),
      sellerId,
    ]);
    // Suspension hides listings from search immediately (search filters on kyc_status) — reindex is not needed.
    await ctx.audit(`seller.${b.decision}`, "seller", sellerId, b.note ? { note: b.note } : null);
    return sellerDetail(ctx, sellerId);
  },
);

// ---- moderation ---------------------------------------------------------------------------------------------

api.route("GET", "/api/admin/products", { auth: "admin", query: PageQuery }, async (ctx) => {
  const q = ctx.query;
  const where = ["1=1"];
  const params: unknown[] = [];
  if (q.status) {
    where.push("p.status = ?");
    params.push(q.status);
  }
  if (q.q.trim()) {
    where.push("(p.title ILIKE ? ESCAPE '\\' OR p.part_number ILIKE ? ESCAPE '\\' OR s.display_name ILIKE ? ESCAPE '\\')");
    const pattern = like(q.q);
    params.push(pattern, pattern, pattern);
  }
  const clause = where.join(" AND ");
  const { limit, offset } = paginate(q.page, q.per_page);
  const base =
    " FROM products p JOIN sellers s ON s.id = p.seller_id JOIN brands b ON b.id = p.brand_id JOIN categories c ON c.id = p.category_id";
  const total = Number(await ctx.db.scalar(`SELECT COUNT(*)${base} WHERE ${clause}`, params));
  const rows = await ctx.db.all(
    `SELECT p.id, p.title, p.part_number, p.price_paise, p.mrp_paise, p.stock, p.status, p.updated_at,
            p.condition, p.is_universal, b.name AS brand, b.is_oem AS brand_is_oem, c.name AS category,
            s.id AS seller_id, s.display_name AS seller,
            (SELECT COUNT(*) FROM product_fitments f WHERE f.product_id = p.id) AS fitment_count,
            (SELECT m.thumb_path FROM media m WHERE m.product_id = p.id ORDER BY m.position, m.id LIMIT 1) AS thumb
     ${base} WHERE ${clause} ORDER BY CASE p.status WHEN 'pending' THEN 0 ELSE 1 END, p.updated_at ASC LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );
  const counts: Record<string, number> = {};
  for (const r of await ctx.db.all("SELECT status, COUNT(*) AS n FROM products GROUP BY status")) counts[r.status] = r.n;
  const items = rows.map(({ thumb, ...rest }) => ({
    ...rest,
    image: mediaUrl(thumb),
    brand_is_oem: Boolean(rest.brand_is_oem),
    is_universal: Boolean(rest.is_universal),
  }));
  return { items, counts, ...pageMeta(total, q.page, limit) };
});

async function productDetail(ctx: Ctx, productId: number) {
  if (!(await ctx.db.scalar("SELECT 1 FROM products WHERE id = ?", [productId]))) throw notFound("Listing");
  const data = await listingEditable(ctx.db, productId);
  const seller = await ctx.db.one(
    "SELECT s.id, s.display_name, s.kyc_status, s.city FROM sellers s JOIN products p ON p.seller_id = s.id WHERE p.id = ?",
    [productId],
  );
  const duplicates = await ctx.db.all(
    `SELECT DISTINCT p.id, p.title, s.display_name AS seller, p.status FROM product_part_numbers a
     JOIN product_part_numbers b2 ON b2.number_norm = a.number_norm AND b2.product_id != a.product_id
     JOIN products p ON p.id = b2.product_id JOIN sellers s ON s.id = p.seller_id
     WHERE a.product_id = ? LIMIT 10`,
    [productId],
  );
  return { ...data, seller, same_part_number: duplicates };
}

api.route("GET", "/api/admin/products/{product_id:int}", { auth: "admin" }, async (ctx) =>
  productDetail(ctx, pathInt(ctx, "product_id")),
);

const ModerateIn = z.object({
  decision: z.enum(["approve", "reject", "takedown"]),
  note: LongText(0, 500).default(""),
});

api.route(
  "POST",
  "/api/admin/products/{product_id:int}/moderate",
  { auth: "admin", body: ModerateIn, rate: "write" },
  async (ctx) => {
    const productId = pathInt(ctx, "product_id");
    // Row lock: two moderators acting at once must not both pass the status check.
    const status = await ctx.db.scalar<string>("SELECT status FROM products WHERE id = ? FOR NO KEY UPDATE", [productId]);
    if (status === null) throw notFound("Listing");
    const b = ctx.body;
    if (b.decision === "approve" && status !== "pending") {
      throw conflict("Only listings awaiting review can be approved.", "invalid_transition");
    }
    if (b.decision === "reject" && status !== "pending") {
      throw conflict("Only listings awaiting review can be rejected.", "invalid_transition");
    }
    if (b.decision === "takedown" && status !== "active") {
      throw conflict("Only live listings can be taken down.", "invalid_transition");
    }
    if ((b.decision === "reject" || b.decision === "takedown") && b.note.length < 5) {
      throw new ApiError(422, "validation_error", "Tell the seller what to fix.", {
        fields: { note: "Explain the decision." },
      });
    }
    const target = { approve: "active", reject: "rejected", takedown: "rejected" }[b.decision];
    await setStatus(ctx.db, productId, target, b.note || null);
    await ctx.audit(`listing.${b.decision}`, "product", productId, b.note ? { note: b.note } : null);
    return productDetail(ctx, productId);
  },
);

// ---- master data: vehicles, categories, brands ---------------------------------------------------------------

api.route("GET", "/api/admin/vehicles", { auth: "admin" }, async (ctx) => {
  const makes = await ctx.db.all("SELECT id, name, slug, country, is_active FROM makes ORDER BY name");
  const models = await ctx.db.all("SELECT id, make_id, name, slug, body_type, is_active FROM models ORDER BY name");
  const variants = (await ctx.db.all(`${VARIANT_SELECT} ORDER BY v.year_from, v.name`)).map(variantOut);
  const usage = new Map<number, number>();
  for (const r of await ctx.db.all("SELECT variant_id, COUNT(*) AS n FROM product_fitments GROUP BY variant_id")) {
    usage.set(r.variant_id, r.n);
  }
  return makes.map((mk) => ({
    ...mk,
    is_active: Boolean(mk.is_active),
    models: models
      .filter((mo) => mo.make_id === mk.id)
      .map((mo) => ({
        ...mo,
        is_active: Boolean(mo.is_active),
        variants: variants
          .filter((v) => v.model_id === mo.id)
          .map((v) => ({ ...v, fitment_count: usage.get(v.id) ?? 0 })),
      })),
  }));
});

const MakeIn = z.object({
  name: Text(2, 60),
  country: optional(Text(0, 40)),
  is_active: z.boolean().default(true),
});

const ModelIn = z.object({
  make_id: Int.pipe(z.number().gt(0)),
  name: Text(1, 60),
  body_type: z.enum(["hatchback", "sedan", "suv", "muv", "pickup", "coupe", "van"]),
  is_active: z.boolean().default(true),
});

const VariantIn = z.object({
  model_id: Int.pipe(z.number().gt(0)),
  name: Text(1, 80),
  generation: optional(Text(0, 40)),
  year_from: Int.pipe(z.number().min(1950).max(2100)),
  year_to: optional(Int.pipe(z.number().min(1950).max(2100))),
  fuel: z.enum(["petrol", "diesel", "cng", "electric", "hybrid"]),
  transmission: z.enum(["manual", "automatic", "amt", "cvt", "dct"]),
  engine_cc: optional(Int.pipe(z.number().min(0).max(10000))),
  engine_code: optional(Text(0, 30)),
  is_active: z.boolean().default(true),
});
type VariantBody = z.output<typeof VariantIn>;

/** Map a failed INSERT/UPDATE to the API error Python produced (unique violation → 409). */
function uniqueError(err: unknown, message: string): ApiError {
  return (err as { code?: string })?.code === "23505"
    ? new ApiError(409, "duplicate", message)
    : new ApiError(400, "bad_request", "Couldn't save.");
}

api.route("POST", "/api/admin/makes", { auth: "admin", body: MakeIn, rate: "write", status: 201 }, async (ctx) => {
  const b = ctx.body;
  let makeId: number;
  try {
    makeId = await ctx.db.insert("INSERT INTO makes (name, slug, country, is_active) VALUES (?, ?, ?, ?)", [
      b.name,
      slugify(b.name),
      b.country,
      b.is_active,
    ]);
  } catch (err) {
    throw uniqueError(err, "A make with this name already exists.");
  }
  await ctx.audit("make.created", "make", makeId, { name: b.name });
  return { id: makeId };
});

api.route("PATCH", "/api/admin/makes/{make_id:int}", { auth: "admin", body: MakeIn, rate: "write" }, async (ctx) => {
  const b = ctx.body;
  const makeId = pathInt(ctx, "make_id");
  let n: number;
  try {
    n = await ctx.db.execute("UPDATE makes SET name = ?, slug = ?, country = ?, is_active = ? WHERE id = ?", [
      b.name,
      slugify(b.name),
      b.country,
      b.is_active,
      makeId,
    ]);
  } catch (err) {
    throw uniqueError(err, "A make with this name already exists.");
  }
  if (!n) throw notFound("Make");
  await ctx.audit("make.updated", "make", makeId, b);
  return { id: makeId };
});

api.route("POST", "/api/admin/models", { auth: "admin", body: ModelIn, rate: "write", status: 201 }, async (ctx) => {
  const b = ctx.body;
  if (!(await ctx.db.scalar("SELECT 1 FROM makes WHERE id = ?", [b.make_id]))) {
    throw badRequest("Choose a make.", "bad_request", { make_id: "Choose a make." });
  }
  let modelId: number;
  try {
    modelId = await ctx.db.insert("INSERT INTO models (make_id, name, slug, body_type, is_active) VALUES (?, ?, ?, ?, ?)", [
      b.make_id,
      b.name,
      slugify(b.name),
      b.body_type,
      b.is_active,
    ]);
  } catch (err) {
    throw uniqueError(err, "This make already has a model with that name.");
  }
  await ctx.audit("model.created", "model", modelId, { name: b.name });
  return { id: modelId };
});

api.route("PATCH", "/api/admin/models/{model_id:int}", { auth: "admin", body: ModelIn, rate: "write" }, async (ctx) => {
  const b = ctx.body;
  const modelId = pathInt(ctx, "model_id");
  let n: number;
  try {
    n = await ctx.db.execute(
      "UPDATE models SET make_id = ?, name = ?, slug = ?, body_type = ?, is_active = ? WHERE id = ?",
      [b.make_id, b.name, slugify(b.name), b.body_type, b.is_active, modelId],
    );
  } catch (err) {
    throw uniqueError(err, "This make already has a model with that name.");
  }
  if (!n) throw notFound("Model");
  await ctx.audit("model.updated", "model", modelId, b);
  return { id: modelId };
});

async function variantCode(ctx: Ctx, modelId: number, b: VariantBody): Promise<string> {
  const row = await ctx.db.one(
    "SELECT mo.name AS model, mk.name AS make FROM models mo JOIN makes mk ON mk.id = mo.make_id WHERE mo.id = ?",
    [modelId],
  );
  if (!row) throw badRequest("Choose a model.", "bad_request", { model_id: "Choose a model." });
  const words = [row.make as string, row.model as string, b.name.split(/\s+/).filter(Boolean)[0]];
  const stem = words.map((w) => w.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 4)).join("-");
  const base = `${stem}-${b.fuel[0].toUpperCase()}-${TRANSMISSION_LABEL[b.transmission]}-${String(b.year_from).slice(2)}`;
  let code = base;
  let n = 2;
  while (await ctx.db.scalar("SELECT 1 FROM variants WHERE code = ?", [code])) {
    code = `${base}-${n}`;
    n++;
  }
  return code;
}

function checkYears(b: VariantBody): void {
  if (b.year_to !== null && b.year_to < b.year_from) {
    throw new ApiError(422, "validation_error", "End year must be after start year.", {
      fields: { year_to: "Must be ≥ start year." },
    });
  }
}

api.route("POST", "/api/admin/variants", { auth: "admin", body: VariantIn, rate: "write", status: 201 }, async (ctx) => {
  const b = ctx.body;
  checkYears(b);
  const code = await variantCode(ctx, b.model_id, b);
  const variantId = await ctx.db.insert(
    `INSERT INTO variants (model_id, code, name, generation, year_from, year_to, fuel, transmission, engine_cc,
         engine_code, is_active) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      b.model_id,
      code,
      b.name,
      b.generation,
      b.year_from,
      b.year_to,
      b.fuel,
      b.transmission,
      b.engine_cc,
      b.engine_code,
      b.is_active,
    ],
  );
  await ctx.audit("variant.created", "variant", variantId, { code });
  return { id: variantId, code };
});

api.route(
  "PATCH",
  "/api/admin/variants/{variant_id:int}",
  { auth: "admin", body: VariantIn, rate: "write" },
  async (ctx) => {
    const b = ctx.body;
    checkYears(b);
    const variantId = pathInt(ctx, "variant_id");
    const n = await ctx.db.execute(
      `UPDATE variants SET model_id=?, name=?, generation=?, year_from=?, year_to=?, fuel=?, transmission=?,
           engine_cc=?, engine_code=?, is_active=? WHERE id=?`,
      [
        b.model_id,
        b.name,
        b.generation,
        b.year_from,
        b.year_to,
        b.fuel,
        b.transmission,
        b.engine_cc,
        b.engine_code,
        b.is_active,
        variantId,
      ],
    );
    if (!n) throw notFound("Variant");
    await ctx.audit("variant.updated", "variant", variantId, b);
    return { id: variantId };
  },
);

api.route("GET", "/api/admin/categories", { auth: "admin" }, async (ctx) =>
  categoryTree(ctx.db, { includeInactive: true }),
);

const CategoryIn = z.object({
  name: Text(2, 60),
  parent_id: optional(Int.pipe(z.number().gt(0))),
  icon: z
    .string()
    .regex(/^[a-z-]{2,30}$/, "String should match pattern '^[a-z-]{2,30}$'")
    .default("box"),
  position: Int.pipe(z.number().min(0).max(999)).default(0),
  is_active: z.boolean().default(true),
});

api.route(
  "POST",
  "/api/admin/categories",
  { auth: "admin", body: CategoryIn, rate: "write", status: 201 },
  async (ctx) => {
    const b = ctx.body;
    if (b.parent_id && (await ctx.db.scalar("SELECT parent_id FROM categories WHERE id = ?", [b.parent_id])) !== null) {
      throw badRequest("Categories can be at most two levels deep.", "bad_request", {
        parent_id: "Choose a top-level category.",
      });
    }
    let cid: number;
    try {
      cid = await ctx.db.insert(
        "INSERT INTO categories (parent_id, name, slug, icon, position, is_active) VALUES (?, ?, ?, ?, ?, ?)",
        [b.parent_id, b.name, slugify(b.name), b.icon, b.position, b.is_active],
      );
    } catch (err) {
      throw uniqueError(err, "A category with this name already exists.");
    }
    await ctx.audit("category.created", "category", cid, { name: b.name });
    return { id: cid };
  },
);

api.route(
  "PATCH",
  "/api/admin/categories/{category_id:int}",
  { auth: "admin", body: CategoryIn, rate: "write" },
  async (ctx) => {
    const b = ctx.body;
    const cid = pathInt(ctx, "category_id");
    if (b.parent_id === cid) {
      throw badRequest("A category can't be its own parent.", "bad_request", { parent_id: "Choose another parent." });
    }
    if (b.parent_id && (await ctx.db.scalar("SELECT 1 FROM categories WHERE parent_id = ?", [cid]))) {
      throw badRequest("This category has subcategories, so it must stay top-level.", "bad_request", {
        parent_id: "Keep top-level.",
      });
    }
    let n: number;
    try {
      n = await ctx.db.execute(
        "UPDATE categories SET parent_id=?, name=?, slug=?, icon=?, position=?, is_active=? WHERE id=?",
        [b.parent_id, b.name, slugify(b.name), b.icon, b.position, b.is_active, cid],
      );
    } catch (err) {
      throw uniqueError(err, "A category with this name already exists.");
    }
    if (!n) throw notFound("Category");
    await ctx.audit("category.updated", "category", cid, b);
    return { id: cid };
  },
);

api.route("GET", "/api/admin/brands", { auth: "admin" }, async (ctx) => {
  const rows = await ctx.db.all(`SELECT b.*, (SELECT COUNT(*) FROM products p WHERE p.brand_id = b.id) AS product_count
                                 FROM brands b ORDER BY b.name`);
  return rows.map((r) => ({ ...r, is_oem: Boolean(r.is_oem), is_active: Boolean(r.is_active) }));
});

const BrandIn = z.object({
  name: Text(2, 60),
  is_oem: z.boolean().default(false),
  is_active: z.boolean().default(true),
});

api.route("POST", "/api/admin/brands", { auth: "admin", body: BrandIn, rate: "write", status: 201 }, async (ctx) => {
  const b = ctx.body;
  let bid: number;
  try {
    bid = await ctx.db.insert("INSERT INTO brands (name, slug, is_oem, is_active) VALUES (?, ?, ?, ?)", [
      b.name,
      slugify(b.name),
      b.is_oem,
      b.is_active,
    ]);
  } catch (err) {
    throw uniqueError(err, "A brand with this name already exists.");
  }
  await ctx.audit("brand.created", "brand", bid, { name: b.name });
  return { id: bid };
});

api.route("PATCH", "/api/admin/brands/{brand_id:int}", { auth: "admin", body: BrandIn, rate: "write" }, async (ctx) => {
  const b = ctx.body;
  const bid = pathInt(ctx, "brand_id");
  let n: number;
  try {
    n = await ctx.db.execute("UPDATE brands SET name=?, slug=?, is_oem=?, is_active=? WHERE id=?", [
      b.name,
      slugify(b.name),
      b.is_oem,
      b.is_active,
      bid,
    ]);
  } catch (err) {
    throw uniqueError(err, "A brand with this name already exists.");
  }
  if (!n) throw notFound("Brand");
  await ctx.audit("brand.updated", "brand", bid, b);
  return { id: bid };
});

// ---- orders --------------------------------------------------------------------------------------------------

api.route("GET", "/api/admin/orders", { auth: "admin", query: PageQuery }, async (ctx) => {
  const q = ctx.query;
  // Search narrows everything, tab counts included; the status tab is applied on top.
  const base = ["1=1"];
  const baseParams: unknown[] = [];
  if (q.q.trim()) {
    base.push("(o.number ILIKE ? ESCAPE '\\' OR u.email ILIKE ? ESCAPE '\\' OR o.ship_name ILIKE ? ESCAPE '\\')");
    const pattern = like(q.q);
    baseParams.push(pattern, pattern, pattern);
  }
  const where = [...base];
  const params = [...baseParams];
  if (q.status) {
    const group = ADMIN_ORDER_GROUPS[q.status];
    if (group) {
      where.push(hasShipmentIn(group));
    } else {
      where.push("EXISTS (SELECT 1 FROM fulfilments f WHERE f.order_id = o.id AND f.status = ?)");
      params.push(q.status);
    }
  }
  const clause = where.join(" AND ");
  const { limit, offset } = paginate(q.page, q.per_page);
  const total = Number(
    await ctx.db.scalar(`SELECT COUNT(*) FROM orders o JOIN users u ON u.id = o.buyer_id WHERE ${clause}`, params),
  );
  const rows = await ctx.db.all(
    `SELECT o.id, o.number, o.created_at, o.total_paise, o.payment_method, o.payment_status, o.ship_city,
            u.email AS buyer_email, o.ship_name AS buyer_name,
            (SELECT string_agg(f.status, ',') FROM fulfilments f WHERE f.order_id = o.id) AS statuses,
            (SELECT COUNT(*) FROM fulfilments f WHERE f.order_id = o.id) AS seller_count
     FROM orders o JOIN users u ON u.id = o.buyer_id WHERE ${clause} ORDER BY o.id DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );
  for (const r of rows) {
    const statuses: string[] = r.statuses ? [...new Set(String(r.statuses).split(","))].sort() : [];
    r.statuses = statuses;
    r.status_labels = statuses.map((s) => STATUS_LABEL[s]);
  }
  // An order with several sellers can sit in more than one tab, so tabs may add up to more than All.
  const groupCounts = Object.entries(ADMIN_ORDER_GROUPS).map(([k, g]) => `COUNT(*) FILTER (WHERE ${hasShipmentIn(g)}) AS ${k}`);
  const counts = await ctx.db.one(
    `SELECT COUNT(*) AS "all", ${groupCounts.join(", ")} FROM orders o JOIN users u ON u.id = o.buyer_id WHERE ${base.join(" AND ")}`,
    baseParams,
  );
  return { items: rows, counts, ...pageMeta(total, q.page, limit) };
});

api.route("GET", "/api/admin/orders/{order_id:int}", { auth: "admin" }, async (ctx) => {
  const order = await ctx.db.one(
    "SELECT o.*, u.email AS buyer_email, u.full_name AS buyer_full_name FROM orders o JOIN users u ON u.id = o.buyer_id WHERE o.id = ?",
    [pathInt(ctx, "order_id")],
  );
  if (!order) throw notFound("Order");
  const days = (await getSettings(ctx.db, ctx.settings)).return_window_days;
  const out: Record<string, any> = await orderOut(ctx.db, order, { returnDays: days });
  const fulfilments = await ctx.db.all(
    "SELECT f.*, s.display_name AS seller_name FROM fulfilments f JOIN sellers s ON s.id = f.seller_id WHERE f.order_id = ?",
    [order.id],
  );
  const items: Row[] = [];
  for (const f of fulfilments) {
    const item: Record<string, any> = await fulfilmentOut(ctx.db, f, { returnDays: days, perspective: "admin" });
    item.commission_paise = f.commission_paise;
    item.tcs_paise = f.tcs_paise;
    item.payout_id = f.payout_id;
    items.push(item);
  }
  out.fulfilments = items;
  out.buyer = { id: order.buyer_id, email: order.buyer_email, name: order.buyer_full_name };
  out.payments = await ctx.db.all(
    "SELECT provider, intent_id, amount_paise, status, created_at FROM payments WHERE order_id = ? ORDER BY id",
    [order.id],
  );
  return out;
});

api.route("GET", "/api/admin/fulfilments/{fulfilment_id:int}/invoice.pdf", { auth: "admin" }, async (ctx) => {
  const f = await ctx.db.one("SELECT * FROM fulfilments WHERE id = ?", [pathInt(ctx, "fulfilment_id")]);
  if (!f) throw notFound("Shipment");
  return invoiceResponse(ctx, f);
});

const ADMIN_FULFILMENT_ACTIONS = new Set(["deliver", "cancel", "accept_return", "reject_return"]);

api.route(
  "POST",
  "/api/admin/fulfilments/{fulfilment_id:int}/{action}",
  { auth: "admin", body: FulfilmentActionIn, rate: "write" },
  async (ctx) => {
    const action = String(ctx.path.action);
    if (!ADMIN_FULFILMENT_ACTIONS.has(action)) throw notFound();
    const f = await ctx.db.one("SELECT * FROM fulfilments WHERE id = ?", [pathInt(ctx, "fulfilment_id")]);
    if (!f) throw notFound("Shipment");
    const userId = ctx.requireUser().id;
    if (action === "cancel" && f.status === "pending_payment") {
      const reason = ctx.body.reason || "Cancelled by PartPilot support";
      await cancelUnpaidOrder(ctx.db, f.order_id, "admin", userId, reason);
    } else {
      await applyFulfilmentAction(ctx, f, action, "admin", userId, ctx.body);
    }
    await ctx.audit(`fulfilment.admin_${action}`, "fulfilment", f.id);
    return { ok: true, order_id: f.order_id };
  },
);

// ---- users -----------------------------------------------------------------------------------------------------

api.route("GET", "/api/admin/users", { auth: "admin", query: PageQuery }, async (ctx) => {
  const q = ctx.query;
  const where = ["1=1"];
  const params: unknown[] = [];
  if (q.status === "buyer" || q.status === "seller" || q.status === "admin") {
    where.push("u.role = ?");
    params.push(q.status);
  } else if (q.status === "suspended") {
    where.push("u.status = 'suspended'");
  }
  if (q.q.trim()) {
    where.push("(u.email ILIKE ? ESCAPE '\\' OR u.full_name ILIKE ? ESCAPE '\\')");
    const pattern = like(q.q);
    params.push(pattern, pattern);
  }
  const clause = where.join(" AND ");
  const { limit, offset } = paginate(q.page, q.per_page);
  const total = Number(await ctx.db.scalar(`SELECT COUNT(*) FROM users u WHERE ${clause}`, params));
  const rows = await ctx.db.all(
    `SELECT u.id, u.email, u.full_name, u.phone, u.role, u.status, u.created_at,
            (SELECT COUNT(*) FROM orders o WHERE o.buyer_id = u.id) AS orders,
            (SELECT MAX(last_seen_at) FROM sessions s WHERE s.user_id = u.id) AS last_seen
     FROM users u WHERE ${clause} ORDER BY u.id DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );
  return { items: rows, ...pageMeta(total, q.page, limit) };
});

const UserStatusIn = z.object({
  status: z.enum(["active", "suspended"]),
  note: LongText(0, 300).default(""),
});

api.route(
  "POST",
  "/api/admin/users/{user_id:int}/status",
  { auth: "admin", body: UserStatusIn, rate: "write" },
  async (ctx) => {
    const userId = pathInt(ctx, "user_id");
    const target = await ctx.db.one("SELECT id, role, status FROM users WHERE id = ?", [userId]);
    if (!target) throw notFound("User");
    if (target.id === ctx.requireUser().id) throw forbidden("You can't change your own account status.");
    if (target.role === "admin") throw forbidden("Manage admin accounts from the Admins page (super admins only).");
    const b = ctx.body;
    await ctx.db.execute("UPDATE users SET status = ?, updated_at = ? WHERE id = ?", [b.status, utcnow(), userId]);
    if (b.status === "suspended") await destroyUserSessions(ctx.db, userId);
    await ctx.audit(`user.${b.status}`, "user", userId, b.note ? { note: b.note } : null);
    return { id: userId, status: b.status };
  },
);

// ---- payouts --------------------------------------------------------------------------------------------------

api.route("GET", "/api/admin/payouts", { auth: "admin" }, async (ctx) => {
  const sellers = await ctx.db.all(
    "SELECT id, display_name, bank_account_last4, bank_ifsc FROM sellers WHERE kyc_status IN ('approved','suspended') ORDER BY display_name",
  );
  const summary: Row[] = [];
  for (const s of sellers) {
    const lines = await payoutLines(ctx, s.id);
    const eligibleRows: Row[] = lines.eligible;
    const holdingRows: Row[] = lines.holding;
    const eligible = eligibleRows.reduce((sum, r) => sum + Number(r.net_paise), 0);
    const holding = holdingRows.reduce((sum, r) => sum + Number(r.net_paise), 0);
    if (eligible || holding) {
      summary.push({ ...s, eligible_paise: eligible, eligible_count: eligibleRows.length, holding_paise: holding });
    }
  }
  const history = await ctx.db.all(
    "SELECT p.*, s.display_name AS seller FROM payouts p JOIN sellers s ON s.id = p.seller_id ORDER BY p.id DESC LIMIT 50",
  );
  return { sellers: summary, history };
});

const PayoutIn = z.object({
  seller_id: Int.pipe(z.number().gt(0)),
});

api.route("POST", "/api/admin/payouts", { auth: "admin", body: PayoutIn, rate: "write", status: 201 }, async (ctx) => {
  const sellerId = ctx.body.seller_id;
  // Serialise payouts per seller: a second admin submitting at the same time waits here, then (READ
  // COMMITTED) reads the payout lines afresh and finds nothing due instead of paying twice.
  // NO KEY UPDATE does not block the FK check of the payouts INSERT below.
  if (!(await ctx.db.scalar("SELECT 1 FROM sellers WHERE id = ? FOR NO KEY UPDATE", [sellerId]))) {
    throw notFound("Seller");
  }
  const lines: Row[] = (await payoutLines(ctx, sellerId)).eligible;
  if (!lines.length) throw conflict("Nothing is due to this seller yet.", "nothing_due");
  const gross = lines.reduce((s, r) => s + Number(r.items_paise) + Number(r.shipping_paise), 0);
  const commission = lines.reduce((s, r) => s + Number(r.commission_paise), 0);
  const tcs = lines.reduce((s, r) => s + Number(r.tcs_paise), 0);
  const net = gross - commission - tcs;
  const now = new Date();
  const yymmdd = now.toISOString().slice(2, 10).replace(/-/g, "");
  const reference = `PO-${yymmdd}-${randomBytes(3).toString("hex").toUpperCase()}`;
  const payoutId = await ctx.db.insert(
    `INSERT INTO payouts (seller_id, reference, gross_paise, commission_paise, tcs_paise, refund_paise, net_paise,
         fulfilment_count, created_by, created_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
    [sellerId, reference, gross, commission, tcs, net, lines.length, ctx.requireUser().id, utcnow()],
  );
  const ids = lines.map((r) => r.id as number);
  // Conditional claim as a second guard: only lines still unpaid (and still delivered) are attached.
  const updated = await ctx.db.execute(
    `UPDATE fulfilments SET payout_id = ? WHERE payout_id IS NULL AND status = 'delivered' AND id IN (${placeholders(ids)})`,
    [payoutId, ...ids],
  );
  if (updated !== ids.length) throw conflict("Payout lines changed while settling. Try again.", "stale_state");
  await ctx.audit("payout.created", "payout", payoutId, { seller_id: sellerId, net_paise: net, reference });
  return { id: payoutId, reference, net_paise: net };
});

// ---- settings + audit ---------------------------------------------------------------------------------------------

api.route("GET", "/api/admin/settings", { auth: "admin" }, async (ctx) => getSettings(ctx.db, ctx.settings));

const SettingsIn = z.object({
  commission_bps: Int.pipe(z.number().min(0).max(3000)),
  shipping_fee_paise: Int.pipe(z.number().min(0).max(50_000)),
  free_shipping_threshold_paise: Int.pipe(z.number().min(0).max(10_000_000)),
  return_window_days: Int.pipe(z.number().min(0).max(30)),
});

api.route("PUT", "/api/admin/settings", { auth: "admin", body: SettingsIn, rate: "write" }, async (ctx) => {
  const before = (await getSettings(ctx.db, ctx.settings)) as unknown as Record<string, number>;
  const values = ctx.body as Record<string, number>;
  for (const key of Object.keys(SETTING_KEYS)) {
    await ctx.db.execute(
      "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
      [key, String(values[key])],
    );
  }
  const changes: Record<string, [number, number]> = {};
  for (const k of Object.keys(values)) {
    if (before[k] !== values[k]) changes[k] = [before[k], values[k]];
  }
  if (Object.keys(changes).length) await ctx.audit("settings.updated", "settings", null, changes);
  return getSettings(ctx.db, ctx.settings);
});

const AuditQuery = z.object({
  q: z.string().max(80).default(""),
  entity: blankToNull(30),
  page: Int.pipe(z.number().min(1).max(1000)).default(1),
  per_page: Int.pipe(z.number().min(1).max(100)).default(30),
});

api.route("GET", "/api/admin/audit", { auth: "admin", query: AuditQuery }, async (ctx) => {
  const q = ctx.query;
  const where = ["1=1"];
  const params: unknown[] = [];
  if (q.entity) {
    where.push("a.entity = ?");
    params.push(q.entity);
  }
  if (q.q.trim()) {
    where.push("(a.action ILIKE ? ESCAPE '\\' OR u.email ILIKE ? ESCAPE '\\' OR a.entity_id = ?)");
    params.push(like(q.q), like(q.q), q.q.trim());
  }
  const clause = where.join(" AND ");
  const { limit, offset } = paginate(q.page, q.per_page);
  const total = Number(
    await ctx.db.scalar(`SELECT COUNT(*) FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id WHERE ${clause}`, params),
  );
  const rows = await ctx.db.all(
    `SELECT a.id, a.action, a.entity, a.entity_id, a.detail, a.ip, a.created_at, a.actor_role, u.email AS actor
     FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id WHERE ${clause} ORDER BY a.id DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );
  for (const r of rows) r.detail = r.detail ? JSON.parse(r.detail) : null;
  const entities = (await ctx.db.all("SELECT DISTINCT entity FROM audit_log ORDER BY entity")).map((r) => r.entity as string);
  return { items: rows, entities, ...pageMeta(total, q.page, limit) };
});
