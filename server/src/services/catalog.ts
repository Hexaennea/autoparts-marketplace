// Read models for vehicles, categories, brands and product listings.

import { type Db, type Row, placeholders } from "../db.js";
import { mediaBase } from "./storage.js";

export const FUEL_LABEL: Record<string, string> = {
  petrol: "Petrol",
  diesel: "Diesel",
  cng: "CNG",
  electric: "Electric",
  hybrid: "Hybrid",
};
export const TRANSMISSION_LABEL: Record<string, string> = {
  manual: "MT",
  automatic: "AT",
  amt: "AMT",
  cvt: "CVT",
  dct: "DCT",
};

export const VARIANT_SELECT = `
    SELECT v.id, v.code, v.name, v.generation, v.year_from, v.year_to, v.fuel, v.transmission,
           v.engine_cc, v.engine_code, v.is_active,
           mo.id AS model_id, mo.name AS model, mo.slug AS model_slug, mo.body_type,
           mk.id AS make_id, mk.name AS make, mk.slug AS make_slug
    FROM variants v
    JOIN models mo ON mo.id = v.model_id
    JOIN makes mk ON mk.id = mo.make_id
`;

export function yearsLabel(yearFrom: number, yearTo: number | null): string {
  return yearTo ? `${yearFrom}–${yearTo}` : `${yearFrom}–present`;
}

export function round1(x: number): number {
  return Math.round(x * 10) / 10;
}

export function variantOut(row: Row) {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    generation: row.generation,
    year_from: row.year_from,
    year_to: row.year_to,
    years: yearsLabel(row.year_from, row.year_to),
    fuel: row.fuel,
    fuel_label: FUEL_LABEL[row.fuel],
    transmission: row.transmission,
    transmission_label: TRANSMISSION_LABEL[row.transmission],
    engine_cc: row.engine_cc,
    engine_code: row.engine_code,
    model_id: row.model_id,
    model: row.model,
    body_type: row.body_type,
    make_id: row.make_id,
    make: row.make,
    label: `${row.make} ${row.model} ${row.name}`,
    is_active: Boolean(row.is_active),
  };
}
export type VariantOut = ReturnType<typeof variantOut>;

export async function getVariant(db: Db, variantId: number): Promise<VariantOut | null> {
  const row = await db.one(`${VARIANT_SELECT} WHERE v.id = ?`, [variantId]);
  return row ? variantOut(row) : null;
}

export async function variantsByIds(db: Db, ids: number[]): Promise<VariantOut[]> {
  if (!ids.length) return [];
  const rows = await db.all(
    `${VARIANT_SELECT} WHERE v.id IN (${placeholders(ids)}) ORDER BY mk.name, mo.name, v.year_from, v.name`,
    ids,
  );
  return rows.map(variantOut);
}

export function vehicleLabel(variant: { make: string; model: string; name: string }, year: number | null): string {
  const base = `${variant.make} ${variant.model} ${variant.name}`;
  return year ? `${base} (${year})` : base;
}

export async function categoryDescendants(db: Db, categoryId: number): Promise<number[]> {
  const rows = await db.all(
    `WITH RECURSIVE tree(id) AS (SELECT ?::bigint UNION ALL SELECT c.id FROM categories c JOIN tree t ON c.parent_id = t.id)
     SELECT id FROM tree`,
    [categoryId],
  );
  return rows.map((r) => r.id);
}

export async function categoryTree(db: Db, opts: { includeInactive?: boolean } = {}) {
  const where = opts.includeInactive ? "" : "WHERE c.is_active";
  const rows = await db.all(`SELECT c.id, c.parent_id, c.name, c.slug, c.icon, c.position, c.is_active,
                 (SELECT COUNT(*) FROM products p WHERE p.category_id = c.id AND p.status = 'active') AS product_count
          FROM categories c ${where} ORDER BY c.position, c.name`);
  const byId = new Map<number, Row>();
  for (const r of rows) byId.set(r.id, { ...r, is_active: Boolean(r.is_active), children: [] as Row[] });
  const roots: Row[] = [];
  for (const node of byId.values()) {
    const parent = node.parent_id ? byId.get(node.parent_id) : undefined;
    (parent ? parent.children : roots).push(node);
  }
  for (const node of byId.values()) {
    node.total_count = node.product_count + node.children.reduce((s: number, c: Row) => s + c.product_count, 0);
  }
  return roots;
}

export const PRODUCT_CARD_SELECT = `
    SELECT p.id, p.slug, p.title, p.part_number, p.condition, p.price_paise, p.mrp_paise, p.stock,
           p.rating_avg, p.rating_count, p.is_universal, p.warranty_months, p.status,
           b.name AS brand, b.is_oem AS brand_is_oem,
           c.name AS category, c.slug AS category_slug,
           s.id AS seller_id, s.display_name AS seller_name, s.city AS seller_city,
           (SELECT m.thumb_path FROM media m WHERE m.product_id = p.id ORDER BY m.position, m.id LIMIT 1) AS thumb
    FROM products p
    JOIN brands b ON b.id = p.brand_id
    JOIN categories c ON c.id = p.category_id
    JOIN sellers s ON s.id = p.seller_id
`;

export function mediaUrl(path: string | null | undefined): string | null {
  return path ? `${mediaBase()}/${path}` : null;
}

export function cardOut(row: Row, fits: boolean | null = null) {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    part_number: row.part_number,
    condition: row.condition,
    price_paise: row.price_paise,
    mrp_paise: row.mrp_paise,
    in_stock: row.stock > 0,
    low_stock: row.stock > 0 && row.stock <= 3,
    rating_avg: round1(row.rating_avg),
    rating_count: row.rating_count,
    is_universal: Boolean(row.is_universal),
    warranty_months: row.warranty_months,
    brand: row.brand,
    brand_is_oem: Boolean(row.brand_is_oem),
    category: row.category,
    category_slug: row.category_slug,
    seller: { id: row.seller_id, name: row.seller_name, city: row.seller_city },
    image: mediaUrl(row.thumb),
    fits,
  };
}

export async function fitmentMap(db: Db, productIds: number[], variantId: number): Promise<Set<number>> {
  if (!productIds.length) return new Set();
  const rows = await db.all(
    `SELECT product_id FROM product_fitments WHERE variant_id = ? AND product_id IN (${placeholders(productIds)})`,
    [variantId, ...productIds],
  );
  return new Set(rows.map((r) => r.product_id));
}

export async function cardsWithFit(db: Db, rows: Row[], variantId: number | null) {
  if (variantId === null) return rows.map((r) => cardOut(r));
  const fitting = await fitmentMap(
    db,
    rows.map((r) => r.id),
    variantId,
  );
  return rows.map((r) => cardOut(r, Boolean(r.is_universal) || fitting.has(r.id)));
}

/** Refresh the full-text search row for one product. Only active products are searchable. */
export async function reindexProduct(db: Db, productId: number): Promise<void> {
  await db.execute("DELETE FROM product_search WHERE product_id = ?", [productId]);
  const row = await db.one(
    `SELECT p.id, p.title, p.description, p.status, b.name AS brand, c.name AS category,
            pc.name AS parent_category
     FROM products p JOIN brands b ON b.id = p.brand_id JOIN categories c ON c.id = p.category_id
     LEFT JOIN categories pc ON pc.id = c.parent_id WHERE p.id = ?`,
    [productId],
  );
  if (!row || row.status !== "active") return;
  const numbers = await db.all("SELECT number, number_norm FROM product_part_numbers WHERE product_id = ?", [productId]);
  const partText = numbers.map((n) => `${n.number} ${n.number_norm}`).join(" ");
  const category = `${row.category} ${row.parent_category ?? ""}`.trim();
  await db.execute(
    "INSERT INTO product_search (product_id, title, brand, category, part_numbers, description) VALUES (?, ?, ?, ?, ?, ?)",
    [productId, row.title, row.brand, category, partText, String(row.description).slice(0, 2000)],
  );
}
