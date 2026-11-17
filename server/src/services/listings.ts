// Creating and updating seller listings (shared by the seller API, CSV import and seed data).

import { type Db, placeholders, utcnow } from "../db.js";
import { ApiError } from "../http.js";
import { normalizePartNumber, slugify } from "../util.js";
import { mediaUrl, reindexProduct, variantsByIds } from "./catalog.js";

// Changing any of these on a live listing sends it back to moderation.
export const REVIEWED_FIELDS = [
  "title",
  "category_id",
  "brand_id",
  "part_number",
  "condition",
  "description",
  "is_universal",
] as const;

export interface ListingData {
  title: string;
  sku: string;
  categoryId: number;
  brandId: number;
  partNumber: string;
  condition: string;
  pricePaise: number;
  mrpPaise: number;
  stock: number;
  gstRateBps: number;
  hsnCode: string;
  warrantyMonths: number;
  weightGrams: number;
  description: string;
  isUniversal: boolean;
  oemNumbers?: string[];
  specs?: Array<[string, string]>;
  variantIds?: number[];
  /** null / undefined = leave photos untouched. */
  imageIds?: number[] | null;
}

/** Map a DB column name of a reviewed field to the ListingData value. */
function reviewedValue(data: ListingData, field: (typeof REVIEWED_FIELDS)[number]): unknown {
  switch (field) {
    case "title":
      return data.title;
    case "category_id":
      return data.categoryId;
    case "brand_id":
      return data.brandId;
    case "part_number":
      return data.partNumber;
    case "condition":
      return data.condition;
    case "description":
      return data.description;
    case "is_universal":
      return data.isUniversal;
  }
}

function uniqueSorted(values: number[]): number[] {
  return [...new Set(values)].sort((a, b) => a - b);
}

export async function validateListing(
  db: Db,
  sellerId: number,
  data: ListingData,
  productId: number | null,
  opts: { submitting: boolean },
): Promise<void> {
  const errors: Record<string, string> = {};
  const imageIds = data.imageIds ?? null;
  const category = await db.one("SELECT id, is_active FROM categories WHERE id = ?", [data.categoryId]);
  if (!category || !category.is_active) errors.category_id = "Choose a category.";
  const brand = await db.one("SELECT id, is_oem, is_active FROM brands WHERE id = ?", [data.brandId]);
  if (!brand || !brand.is_active) {
    errors.brand_id = "Choose a brand.";
  } else if (data.condition === "oem_genuine" && !brand.is_oem) {
    errors.condition = "Only vehicle-maker (OEM) brands can be listed as OEM genuine.";
  }
  if (data.mrpPaise < data.pricePaise) errors.mrp_paise = "MRP can't be lower than your selling price.";
  const clash = await db.scalar("SELECT id FROM products WHERE seller_id = ? AND sku = ? AND id != ?", [
    sellerId,
    data.sku,
    productId ?? 0,
  ]);
  if (clash) errors.sku = "You already have a listing with this SKU.";
  const ids = uniqueSorted(data.variantIds ?? []);
  if (ids.length) {
    const found = Number(
      await db.scalar(`SELECT COUNT(*) FROM variants WHERE is_active AND id IN (${placeholders(ids)})`, ids),
    );
    if (found !== ids.length) {
      errors.variant_ids = "Some selected vehicles are no longer available. Refresh and reselect.";
    }
  }
  if (opts.submitting && !data.isUniversal && !ids.length) {
    errors.variant_ids = "Add at least one vehicle this part fits, or mark it as universal.";
  }
  if (imageIds && imageIds.length) {
    const rows = await db.all(
      `SELECT id, product_id FROM media WHERE seller_id = ? AND id IN (${placeholders(imageIds)})`,
      [sellerId, ...imageIds],
    );
    const valid = new Set(
      rows.filter((r) => r.product_id === null || r.product_id === productId).map((r) => Number(r.id)),
    );
    const wanted = new Set(imageIds);
    const same = valid.size === wanted.size && [...wanted].every((id) => valid.has(id));
    if (!same) errors.image_ids = "One of the photos couldn't be attached. Upload it again.";
  }
  if (opts.submitting) {
    let photoCount: number;
    if (imageIds !== null) {
      photoCount = imageIds.length;
    } else {
      photoCount = Number((await db.scalar("SELECT COUNT(*) FROM media WHERE product_id = ?", [productId ?? 0])) ?? 0);
    }
    if (photoCount === 0) errors.image_ids = "Add at least one photo before submitting for review.";
  }
  if (Object.keys(errors).length) {
    throw new ApiError(422, "validation_error", "Please check the highlighted fields.", { fields: errors });
  }
}

/** Insert or update a listing and its child rows. Returns `[productId, status]`. */
export async function saveListing(
  db: Db,
  sellerId: number,
  data: ListingData,
  productId: number | null = null,
  opts: { submit?: boolean } = {},
): Promise<[number, string]> {
  const submit = opts.submit ?? false;
  const oemNumbers = data.oemNumbers ?? [];
  const specs = data.specs ?? [];
  const variantIds = data.variantIds ?? [];
  const imageIds = data.imageIds ?? null;
  await validateListing(db, sellerId, data, productId, { submitting: submit });
  const now = utcnow();
  const values = [
    data.sku,
    data.title,
    slugify(data.title),
    data.description,
    data.categoryId,
    data.brandId,
    data.partNumber,
    data.condition,
    data.pricePaise,
    data.mrpPaise,
    data.stock,
    data.gstRateBps,
    data.hsnCode,
    data.warrantyMonths,
    data.weightGrams,
    Boolean(data.isUniversal),
  ];
  let status: string;
  let id: number;
  if (productId === null) {
    status = submit ? "pending" : "draft";
    id = await db.insert(
      `INSERT INTO products (sku, title, slug, description, category_id, brand_id, part_number, condition,
           price_paise, mrp_paise, stock, gst_rate_bps, hsn_code, warranty_months, weight_grams,
           is_universal, seller_id, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [...values, sellerId, status, now, now],
    );
  } else {
    id = productId;
    // Lock the row so concurrent edits / stock reservations serialise on it.
    const current = await db.one("SELECT * FROM products WHERE id = ? AND seller_id = ? FOR UPDATE", [id, sellerId]);
    if (!current) throw new ApiError(404, "not_found", "Listing not found.");
    status = current.status;
    const oldFit = new Set(
      (await db.all("SELECT variant_id FROM product_fitments WHERE product_id = ?", [id])).map((r) => Number(r.variant_id)),
    );
    const oldNumbers = new Set(
      (
        await db.all("SELECT number_norm FROM product_part_numbers WHERE product_id = ? AND kind != 'primary'", [id])
      ).map((r) => r.number_norm as string),
    );
    const primaryNorm = normalizePartNumber(data.partNumber);
    const newNumbers = new Set(oemNumbers.map(normalizePartNumber).filter((n) => n !== primaryNorm));
    const oldSpecs = (
      await db.all("SELECT label, value FROM product_specs WHERE product_id = ? ORDER BY position", [id])
    ).map((r) => [r.label as string, r.value as string]);
    const oldImages = (await db.all("SELECT id FROM media WHERE product_id = ? ORDER BY position, id", [id])).map((r) =>
      Number(r.id),
    );
    const newFit = new Set(variantIds);
    const setsEqual = <T>(a: Set<T>, b: Set<T>) => a.size === b.size && [...a].every((x) => b.has(x));
    const changed =
      REVIEWED_FIELDS.some((f) => f !== "is_universal" && current[f] !== reviewedValue(data, f)) ||
      Boolean(current.is_universal) !== Boolean(data.isUniversal) ||
      !setsEqual(oldFit, newFit) ||
      !setsEqual(oldNumbers, newNumbers) || // cross-references rank first in part-number search
      oldSpecs.length !== specs.length ||
      oldSpecs.some(([l, v], i) => specs[i][0] !== l || specs[i][1] !== v) ||
      (imageIds !== null && (oldImages.length !== imageIds.length || oldImages.some((m, i) => imageIds[i] !== m)));
    if (status === "archived") throw new ApiError(409, "archived", "Restore this listing before editing it.");
    if (submit || (status === "active" && changed) || (status === "rejected" && submit)) status = "pending";
    await db.execute(
      `UPDATE products SET sku=?, title=?, slug=?, description=?, category_id=?, brand_id=?, part_number=?,
           condition=?, price_paise=?, mrp_paise=?, stock=?, gst_rate_bps=?, hsn_code=?, warranty_months=?,
           weight_grams=?, is_universal=?, status=?, moderation_note = CASE WHEN ?::text = 'pending' THEN NULL
           ELSE moderation_note END, updated_at=? WHERE id=?`,
      [...values, status, status, now, id],
    );
  }

  // Part numbers: primary + OEM / cross references.
  await db.execute("DELETE FROM product_part_numbers WHERE product_id = ?", [id]);
  const numbers = new Map<string, [string, string]>([[normalizePartNumber(data.partNumber), [data.partNumber, "primary"]]]);
  for (const number of oemNumbers) {
    const norm = normalizePartNumber(number);
    if (norm && !numbers.has(norm)) numbers.set(norm, [number, "oem"]);
  }
  for (const [norm, [number, kind]] of numbers) {
    await db.execute("INSERT INTO product_part_numbers (product_id, number, number_norm, kind) VALUES (?, ?, ?, ?)", [
      id,
      number,
      norm,
      kind,
    ]);
  }

  await db.execute("DELETE FROM product_specs WHERE product_id = ?", [id]);
  for (const [position, [label, value]] of specs.entries()) {
    await db.execute("INSERT INTO product_specs (product_id, position, label, value) VALUES (?, ?, ?, ?)", [
      id,
      position,
      label,
      value,
    ]);
  }

  await db.execute("DELETE FROM product_fitments WHERE product_id = ?", [id]);
  for (const variantId of uniqueSorted(variantIds)) {
    await db.execute("INSERT INTO product_fitments (product_id, variant_id) VALUES (?, ?)", [id, variantId]);
  }

  if (imageIds !== null) {
    await db.execute("UPDATE media SET product_id = NULL WHERE product_id = ? AND seller_id = ?", [id, sellerId]);
    for (const [position, mediaId] of imageIds.entries()) {
      await db.execute("UPDATE media SET product_id = ?, position = ? WHERE id = ? AND seller_id = ?", [
        id,
        position,
        mediaId,
        sellerId,
      ]);
    }
  }

  await reindexProduct(db, id);
  return [id, status];
}

export async function setStatus(db: Db, productId: number, status: string, note: string | null = null): Promise<void> {
  await db.execute("UPDATE products SET status = ?, moderation_note = ?, updated_at = ? WHERE id = ?", [
    status,
    note,
    utcnow(),
    productId,
  ]);
  await reindexProduct(db, productId);
}

const EDITABLE_KEYS = [
  "id",
  "sku",
  "title",
  "description",
  "category_id",
  "brand_id",
  "part_number",
  "condition",
  "price_paise",
  "mrp_paise",
  "stock",
  "gst_rate_bps",
  "hsn_code",
  "warranty_months",
  "weight_grams",
  "status",
  "moderation_note",
  "created_at",
  "updated_at",
  "sold_count",
  "rating_avg",
  "rating_count",
  "brand",
  "category",
] as const;

export async function listingEditable(db: Db, productId: number) {
  const row = await db.one(
    `SELECT p.*, b.name AS brand, c.name AS category FROM products p JOIN brands b ON b.id = p.brand_id
     JOIN categories c ON c.id = p.category_id WHERE p.id = ?`,
    [productId],
  );
  if (!row) throw new Error(`product ${productId} missing`);
  const variantIds = (await db.all("SELECT variant_id FROM product_fitments WHERE product_id = ?", [productId])).map(
    (r) => Number(r.variant_id),
  );
  const images = await db.all("SELECT id, path, thumb_path FROM media WHERE product_id = ? ORDER BY position, id", [
    productId,
  ]);
  const base: Record<string, unknown> = {};
  for (const k of EDITABLE_KEYS) base[k] = row[k];
  return {
    ...base,
    is_universal: Boolean(row.is_universal),
    oem_numbers: (
      await db.all(
        "SELECT number FROM product_part_numbers WHERE product_id = ? AND kind != 'primary' ORDER BY number COLLATE \"C\"",
        [productId],
      )
    ).map((r) => r.number as string),
    specs: await db.all("SELECT label, value FROM product_specs WHERE product_id = ? ORDER BY position", [productId]),
    fitment: await variantsByIds(db, variantIds),
    images: images.map((i) => ({ id: i.id, url: mediaUrl(i.path), thumb: mediaUrl(i.thumb_path) })),
  };
}
