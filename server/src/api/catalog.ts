// Public catalogue: vehicles, categories, brands, search, product pages, reviews.

import { z } from "zod";
import { type Row, placeholders, utcnow } from "../db.js";
import { ApiError, type Ctx, api, conflict, forbidden, notFound, pageMeta, paginate, pathInt } from "../http.js";
import {
  PRODUCT_CARD_SELECT,
  VARIANT_SELECT,
  type VariantOut,
  cardsWithFit,
  categoryTree,
  getVariant,
  mediaUrl,
  round1,
  variantOut,
  variantsByIds,
  vehicleLabel,
} from "../services/catalog.js";
import { Search, type SearchParams } from "../services/search.js";
import { Int, LongText, QueryBool, Text, normalizePartNumber, optional } from "../util.js";

export { vehicleLabel };

/** Query-string value where "" means "not provided" (pydantic blank_to_none). */
function blankToNull<T extends z.ZodTypeAny>(schema: T) {
  return z.preprocess((v) => (v === "" ? null : v), optional(schema));
}

// ---- vehicles ---------------------------------------------------------------------------------------

api.route("GET", "/api/vehicles/makes", {}, async (ctx) => {
  return ctx.db.all(`SELECT mk.id, mk.name, mk.slug, COUNT(DISTINCT mo.id) AS model_count
           FROM makes mk JOIN models mo ON mo.make_id = mk.id AND mo.is_active
           WHERE mk.is_active GROUP BY mk.id ORDER BY mk.name`);
});

api.route("GET", "/api/vehicles/makes/{make_id:int}/models", {}, async (ctx) => {
  return ctx.db.all(
    `SELECT mo.id, mo.name, mo.slug, mo.body_type,
            MIN(v.year_from) AS year_from,
            CASE WHEN bool_or(v.year_to IS NULL) THEN NULL ELSE MAX(v.year_to) END AS year_to
     FROM models mo JOIN variants v ON v.model_id = mo.id AND v.is_active
     WHERE mo.make_id = ? AND mo.is_active GROUP BY mo.id ORDER BY mo.name`,
    [pathInt(ctx, "make_id")],
  );
});

api.route("GET", "/api/vehicles/models/{model_id:int}/years", {}, async (ctx) => {
  const rows = await ctx.db.all("SELECT year_from, year_to FROM variants WHERE model_id = ? AND is_active", [
    pathInt(ctx, "model_id"),
  ]);
  const years = new Set<number>();
  const current = new Date().getUTCFullYear();
  for (const r of rows) {
    const end = r.year_to || current;
    for (let y = r.year_from; y <= end; y++) years.add(y);
  }
  return [...years].sort((a, b) => b - a);
});

const VariantQuery = z.object({
  year: optional(Int.pipe(z.number().min(1950).max(2100))),
});

api.route("GET", "/api/vehicles/models/{model_id:int}/variants", { query: VariantQuery }, async (ctx) => {
  const year = ctx.query.year;
  let sql = `${VARIANT_SELECT} WHERE v.model_id = ? AND v.is_active`;
  const params: unknown[] = [pathInt(ctx, "model_id")];
  if (year) {
    sql += " AND v.year_from <= ? AND (v.year_to IS NULL OR v.year_to >= ?)";
    params.push(year, year);
  }
  const rows = await ctx.db.all(`${sql} ORDER BY v.fuel, v.transmission, v.name`, params);
  return rows.map(variantOut);
});

api.route("GET", "/api/vehicles/variants/{variant_id:int}", {}, async (ctx) => {
  const variant = await getVariant(ctx.db, pathInt(ctx, "variant_id"));
  if (variant === null) throw notFound("Vehicle");
  const partCount = await ctx.db.scalar(
    `SELECT COUNT(*) FROM products p JOIN sellers s ON s.id = p.seller_id
     WHERE p.status = 'active' AND s.kyc_status = 'approved'
       AND (p.is_universal OR EXISTS (SELECT 1 FROM product_fitments f WHERE f.product_id = p.id AND f.variant_id = ?))`,
    [variant.id],
  );
  return { ...variant, part_count: partCount };
});

// ---- taxonomy ---------------------------------------------------------------------------------------

api.route("GET", "/api/categories", {}, async (ctx) => categoryTree(ctx.db));

api.route("GET", "/api/brands", {}, async (ctx) => {
  const rows = await ctx.db.all("SELECT id, name, slug, is_oem FROM brands WHERE is_active ORDER BY name");
  return rows.map((r) => ({ ...r, is_oem: Boolean(r.is_oem) }));
});

const HomeQuery = z.object({
  vehicle: optional(Int.pipe(z.number().gt(0))),
});

api.route("GET", "/api/home", { query: HomeQuery }, async (ctx) => {
  const variantId = ctx.query.vehicle;
  const params: unknown[] = [];
  let fitClause = "";
  if (variantId) {
    fitClause =
      " AND (p.is_universal OR EXISTS (SELECT 1 FROM product_fitments f" +
      " WHERE f.product_id = p.id AND f.variant_id = ?))";
    params.push(variantId);
  }
  // Independent reads run together (the database can be a long round trip away).
  const [popular, topBrands, stats, categories, vehicle] = await Promise.all([
    ctx.db.all(
      `${PRODUCT_CARD_SELECT} WHERE p.status = 'active' AND s.kyc_status = 'approved' AND p.stock > 0${fitClause}` +
        // One card per part number: the best-selling listing represents it.
        " AND p.id = (SELECT p2.id FROM products p2 JOIN sellers s2 ON s2.id = p2.seller_id" +
        " WHERE p2.part_number = p.part_number AND p2.status = 'active' AND s2.kyc_status = 'approved'" +
        " AND p2.stock > 0 ORDER BY p2.sold_count DESC, p2.id LIMIT 1)" +
        " ORDER BY p.sold_count DESC, p.rating_avg DESC LIMIT 10",
      params,
    ),
    ctx.db.all(
      `SELECT b.name, b.slug, b.is_oem, COUNT(*) AS count FROM products p JOIN brands b ON b.id = p.brand_id
       WHERE p.status = 'active' GROUP BY b.id ORDER BY b.is_oem DESC, count DESC LIMIT 30`,
    ),
    ctx.db.one(`SELECT (SELECT COUNT(*) FROM products WHERE status = 'active') AS parts,
                  (SELECT COUNT(*) FROM sellers WHERE kyc_status = 'approved') AS sellers,
                  (SELECT COUNT(*) FROM variants WHERE is_active) AS variants`),
    categoryTree(ctx.db),
    variantId ? getVariant(ctx.db, variantId) : Promise.resolve(null),
  ]);
  return {
    categories,
    popular: await cardsWithFit(ctx.db, popular, variantId),
    brands: topBrands.map((b) => ({ ...b, is_oem: Boolean(b.is_oem) })),
    stats,
    vehicle,
  };
});

// ---- search ----------------------------------------------------------------------------------------

const SearchQuery = z.object({
  q: z.string().max(120).default(""),
  category: blankToNull(z.string().max(80)),
  brand: blankToNull(z.string().max(400)),
  vehicle: optional(Int.pipe(z.number().gt(0))),
  fit: z.enum(["only", "all"]).default("only"),
  min_price: optional(Int.pipe(z.number().min(0).max(10_000_000))),
  max_price: optional(Int.pipe(z.number().min(0).max(10_000_000))),
  in_stock: QueryBool.default(false),
  condition: blankToNull(z.enum(["new", "oem_genuine"])),
  sort: z.enum(["relevance", "price_asc", "price_desc", "newest", "rating"]).default("relevance"),
  page: Int.pipe(z.number().min(1).max(500)).default(1),
  per_page: Int.pipe(z.number().min(1).max(60)).default(24),
});

api.route("GET", "/api/search", { query: SearchQuery }, async (ctx) => {
  const q = ctx.query;
  const params: SearchParams = {
    q: q.q,
    category: q.category,
    brands: (q.brand ?? "")
      .split(",")
      .filter((b) => b)
      .slice(0, 20),
    variantId: q.vehicle,
    fit: q.fit,
    minPaise: q.min_price !== null ? q.min_price * 100 : null,
    maxPaise: q.max_price !== null ? q.max_price * 100 : null,
    inStock: q.in_stock,
    condition: q.condition,
    sort: q.sort,
    page: q.page,
    perPage: q.per_page,
  };
  return new Search(ctx.db, params).run();
});

api.route("GET", "/api/search/suggest", { query: SearchQuery }, async (ctx) => {
  const text = ctx.query.q.trim();
  if (text.length < 2) return { products: [], categories: [], part_number: null };
  const result = await new Search(ctx.db, { q: text, perPage: 6, variantId: ctx.query.vehicle }).run();
  const norm = normalizePartNumber(text);
  let exact: number | null = null;
  if (norm.length >= 4) {
    exact = await ctx.db.scalar<number>(
      `SELECT COUNT(DISTINCT pn.product_id) FROM product_part_numbers pn JOIN products p ON p.id = pn.product_id
       WHERE pn.number_norm = ? AND p.status = 'active'`,
      [norm],
    );
  }
  return {
    products: result.items,
    categories: result.facets.categories.slice(0, 4),
    part_number: exact ? { query: text, matches: exact } : null,
    detected_model: result.detected_model,
  };
});

// ---- product detail ------------------------------------------------------------------------------

export async function visibleProduct(ctx: Ctx, productId: number): Promise<Row> {
  const row = await ctx.db.one(
    `SELECT p.*, b.name AS brand, b.slug AS brand_slug, b.is_oem AS brand_is_oem,
            c.name AS category, c.slug AS category_slug, pc.name AS parent_category, pc.slug AS parent_slug,
            s.display_name AS seller_name, s.city AS seller_city, s.state AS seller_state,
            s.rating_avg AS seller_rating, s.rating_count AS seller_rating_count, s.kyc_status,
            s.created_at AS seller_since, s.user_id AS seller_user_id
     FROM products p JOIN brands b ON b.id = p.brand_id JOIN categories c ON c.id = p.category_id
     LEFT JOIN categories pc ON pc.id = c.parent_id JOIN sellers s ON s.id = p.seller_id WHERE p.id = ?`,
    [productId],
  );
  if (row === null) throw notFound("Product");
  const isPublic = row.status === "active" && row.kyc_status === "approved";
  const owner = ctx.user !== null && ctx.user.id === row.seller_user_id;
  const admin = ctx.user !== null && ctx.user.role === "admin";
  if (!(isPublic || owner || admin)) throw notFound("Product");
  return row;
}

interface FitmentGroup {
  make: string;
  model: string;
  model_id: number;
  variants: VariantOut[];
}

export function fitmentGroups(variants: VariantOut[]): FitmentGroup[] {
  const groups = new Map<string, FitmentGroup>();
  for (const v of variants) {
    const key = JSON.stringify([v.make, v.model]);
    let group = groups.get(key);
    if (!group) {
      group = { make: v.make, model: v.model, model_id: v.model_id, variants: [] };
      groups.set(key, group);
    }
    group.variants.push(v);
  }
  return [...groups.values()];
}

const ProductQuery = z.object({
  vehicle: optional(Int.pipe(z.number().gt(0))),
});

api.route("GET", "/api/products/{product_id:int}", { query: ProductQuery }, async (ctx) => {
  const productId = pathInt(ctx, "product_id");
  // The database can be a long round trip away, so independent reads run together. Nothing is
  // returned unless visibleProduct passes (it throws 404 otherwise).
  const [row, images, specs, numbers, fitmentRows, vehicle, ratingRows] = await Promise.all([
    visibleProduct(ctx, productId),
    ctx.db.all("SELECT id, path, thumb_path, width, height FROM media WHERE product_id = ? ORDER BY position, id", [productId]),
    ctx.db.all("SELECT label, value FROM product_specs WHERE product_id = ? ORDER BY position", [productId]),
    ctx.db.all("SELECT number, kind FROM product_part_numbers WHERE product_id = ? ORDER BY kind DESC, number", [productId]),
    ctx.db.all("SELECT variant_id FROM product_fitments WHERE product_id = ?", [productId]),
    ctx.query.vehicle ? getVariant(ctx.db, ctx.query.vehicle) : Promise.resolve(null),
    ctx.db.all("SELECT rating, COUNT(*) AS n FROM reviews WHERE product_id = ? GROUP BY rating", [productId]),
  ]);
  const variantIds = fitmentRows.map((r) => r.variant_id as number);
  let fits: boolean | null = null;
  if (vehicle) fits = Boolean(row.is_universal) || variantIds.includes(vehicle.id);

  const norms = numbers.map((n) => normalizePartNumber(n.number));
  const [fitments, others] = await Promise.all([
    variantsByIds(ctx.db, variantIds),
    norms.length
      ? ctx.db.all(
          `${PRODUCT_CARD_SELECT} WHERE p.id <> ? AND p.status = 'active' AND s.kyc_status = 'approved'
             AND p.id IN (SELECT product_id FROM product_part_numbers WHERE number_norm IN (${placeholders(norms)}))
             ORDER BY p.price_paise LIMIT 6`,
          [productId, ...norms],
        )
      : Promise.resolve([] as Row[]),
  ]);
  const seen = [productId, ...others.map((o) => o.id as number)]; // don't repeat the "other sellers" rail
  const relatedParams: unknown[] = [row.category_id, ...seen];
  let relatedFit = "";
  if (vehicle) {
    relatedFit =
      " AND (p.is_universal OR EXISTS (SELECT 1 FROM product_fitments f" +
      " WHERE f.product_id = p.id AND f.variant_id = ?))";
    relatedParams.push(vehicle.id);
  }
  const related = await ctx.db.all(
    `${PRODUCT_CARD_SELECT} WHERE p.category_id = ? AND p.id NOT IN (${placeholders(seen)}) AND p.status = 'active'` +
      ` AND s.kyc_status = 'approved'${relatedFit} ORDER BY p.sold_count DESC LIMIT 4`,
    relatedParams,
  );
  const distribution = new Map<number, number>();
  for (const r of ratingRows) distribution.set(r.rating, r.n);
  const ratingDistribution: Record<string, number> = {};
  for (let k = 5; k >= 1; k--) ratingDistribution[String(k)] = distribution.get(k) ?? 0;
  const vehicleId = vehicle ? vehicle.id : null;
  const [otherCards, relatedCards] = await Promise.all([
    cardsWithFit(ctx.db, others, vehicleId),
    cardsWithFit(ctx.db, related, vehicleId),
  ]);
  return {
    id: row.id,
    sku: row.sku,
    slug: row.slug,
    title: row.title,
    description: row.description,
    part_number: row.part_number,
    condition: row.condition,
    price_paise: row.price_paise,
    mrp_paise: row.mrp_paise,
    stock: Math.min(row.stock, 50),
    in_stock: row.stock > 0,
    gst_rate_bps: row.gst_rate_bps,
    hsn_code: row.hsn_code,
    warranty_months: row.warranty_months,
    weight_grams: row.weight_grams,
    is_universal: Boolean(row.is_universal),
    status: row.status,
    rating_avg: round1(row.rating_avg),
    rating_count: row.rating_count,
    rating_distribution: ratingDistribution,
    sold_count: row.sold_count,
    brand: { name: row.brand, slug: row.brand_slug, is_oem: Boolean(row.brand_is_oem) },
    category: {
      name: row.category,
      slug: row.category_slug,
      parent: row.parent_slug ? { name: row.parent_category, slug: row.parent_slug } : null,
    },
    seller: {
      id: row.seller_id,
      name: row.seller_name,
      city: row.seller_city,
      state: row.seller_state,
      rating_avg: round1(row.seller_rating),
      rating_count: row.seller_rating_count,
      since: row.seller_since,
    },
    images: images.map((i) => ({
      id: i.id,
      url: mediaUrl(i.path),
      thumb: mediaUrl(i.thumb_path),
      width: i.width,
      height: i.height,
    })),
    specs,
    part_numbers: numbers,
    fitment: fitmentGroups(fitments),
    fitment_count: fitments.length,
    vehicle,
    fits,
    other_sellers: otherCards,
    related: relatedCards,
  };
});

// ---- reviews -----------------------------------------------------------------------------------------

const ReviewsQuery = z.object({
  page: Int.pipe(z.number().min(1).max(1000)).default(1),
  per_page: Int.pipe(z.number().min(1).max(50)).default(10),
});

api.route("GET", "/api/products/{product_id:int}/reviews", { query: ReviewsQuery }, async (ctx) => {
  const productId = pathInt(ctx, "product_id");
  await visibleProduct(ctx, productId);
  const { limit, offset } = paginate(ctx.query.page, ctx.query.per_page);
  const total = Number((await ctx.db.scalar("SELECT COUNT(*) FROM reviews WHERE product_id = ?", [productId])) ?? 0);
  const rows = await ctx.db.all(
    `SELECT r.id, r.rating, r.title, r.body, r.vehicle_label, r.created_at, u.full_name
     FROM reviews r JOIN users u ON u.id = r.user_id WHERE r.product_id = ?
     ORDER BY r.created_at DESC, r.id DESC LIMIT ? OFFSET ?`,
    [productId, limit, offset],
  );
  const items = rows.map((r) => {
    const parts = String(r.full_name).split(/\s+/).filter(Boolean);
    const author = parts[0] + (parts.length > 1 ? ` ${parts[parts.length - 1][0]}.` : "");
    return {
      id: r.id,
      rating: r.rating,
      title: r.title,
      body: r.body,
      vehicle_label: r.vehicle_label,
      created_at: r.created_at,
      author,
      verified: true,
    };
  });
  let canReview = false;
  if (ctx.user !== null) {
    canReview =
      Boolean(
        await ctx.db.scalar(
          `SELECT 1 FROM order_items oi JOIN fulfilments f ON f.id = oi.fulfilment_id JOIN orders o ON o.id = f.order_id
           WHERE oi.product_id = ? AND o.buyer_id = ? AND f.status = 'delivered' LIMIT 1`,
          [productId, ctx.user.id],
        ),
      ) &&
      !(await ctx.db.scalar("SELECT 1 FROM reviews WHERE product_id = ? AND user_id = ?", [productId, ctx.user.id]));
  }
  return { items, can_review: canReview, ...pageMeta(total, ctx.query.page, limit) };
});

const ReviewIn = z.object({
  rating: Int.pipe(z.number().min(1).max(5)),
  title: Text(3, 100),
  body: LongText(10, 2000),
});

api.route(
  "POST",
  "/api/products/{product_id:int}/reviews",
  { auth: "buyer", body: ReviewIn, rate: "review", status: 201 },
  async (ctx) => {
    const user = ctx.requireUser();
    const productId = pathInt(ctx, "product_id");
    const row = await visibleProduct(ctx, productId);
    if (row.seller_user_id === user.id) throw forbidden("You can't review your own listing.");
    const purchase = await ctx.db.one(
      `SELECT o.vehicle_label FROM order_items oi JOIN fulfilments f ON f.id = oi.fulfilment_id
       JOIN orders o ON o.id = f.order_id
       WHERE oi.product_id = ? AND o.buyer_id = ? AND f.status = 'delivered' ORDER BY o.id DESC LIMIT 1`,
      [productId, user.id],
    );
    if (purchase === null) throw new ApiError(403, "not_purchased", "Only buyers who received this part can review it.");
    const alreadyReviewed = conflict("You've already reviewed this part.", "already_reviewed");
    if (await ctx.db.scalar("SELECT 1 FROM reviews WHERE product_id = ? AND user_id = ?", [productId, user.id])) {
      throw alreadyReviewed;
    }
    const body = ctx.body;
    // ON CONFLICT covers a concurrent duplicate submit (UNIQUE (product_id, user_id)).
    const inserted = await ctx.db.one(
      `INSERT INTO reviews (product_id, user_id, rating, title, body, vehicle_label, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (product_id, user_id) DO NOTHING RETURNING id`,
      [productId, user.id, body.rating, body.title, body.body, purchase.vehicle_label, utcnow()],
    );
    if (inserted === null) throw alreadyReviewed;
    await refreshRatings(ctx, productId, row.seller_id);
    return { id: Number(inserted.id) };
  },
);

export async function refreshRatings(ctx: Ctx, productId: number, sellerId: number): Promise<void> {
  await ctx.db.execute(
    `UPDATE products SET rating_avg = COALESCE((SELECT AVG(rating) FROM reviews WHERE product_id = ?), 0),
                         rating_count = (SELECT COUNT(*) FROM reviews WHERE product_id = ?) WHERE id = ?`,
    [productId, productId, productId],
  );
  await ctx.db.execute(
    `UPDATE sellers SET
       rating_avg = COALESCE((SELECT AVG(r.rating) FROM reviews r JOIN products p ON p.id = r.product_id WHERE p.seller_id = ?), 0),
       rating_count = (SELECT COUNT(*) FROM reviews r JOIN products p ON p.id = r.product_id WHERE p.seller_id = ?)
     WHERE id = ?`,
    [sellerId, sellerId, sellerId],
  );
}
