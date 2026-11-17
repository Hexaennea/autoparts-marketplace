// Fitment-aware product search.
//
// Combines three signals:
// 1. Full-text match (PostgreSQL tsvector/tsquery on `product_search.document`, prefix matching,
//    light plural stemming) over title, brand, category, part numbers and description.
// 2. Part-number lookup on normalised numbers (exact match ranks first, then prefix).
// 3. Vehicle fitment: a chosen variant, or a car model named inside the query ("swift brake pads").
//
// Ranking convention (same as the SQLite/bm25 original): a LOWER `rank` is a better match.
// Full-text rows use -ts_rank_cd(...), exact part numbers -1000, part-number prefixes -500.

import { type Db, type Params, placeholders } from "../db.js";
import { normalizePartNumber } from "../util.js";
import { PRODUCT_CARD_SELECT, type VariantOut, cardOut, categoryDescendants, fitmentMap, getVariant } from "./catalog.js";

const TOKEN = /[0-9A-Za-z]+/g;
export const SORTS = new Set(["relevance", "price_asc", "price_desc", "newest", "rating"]);

export interface SearchParams {
  q: string;
  category: string | null;
  brands: string[];
  variantId: number | null;
  fit: "only" | "all";
  minPaise: number | null;
  maxPaise: number | null;
  inStock: boolean;
  condition: string | null;
  sort: string;
  page: number;
  perPage: number;
}

export const SEARCH_DEFAULTS: SearchParams = {
  q: "",
  category: null,
  brands: [],
  variantId: null,
  fit: "only",
  minPaise: null,
  maxPaise: null,
  inStock: false,
  condition: null,
  sort: "relevance",
  page: 1,
  perPage: 24,
};

export interface DetectedModel {
  id: number;
  name: string;
  make: string;
}

type Mode = "and" | "or";

function tokensOf(text: string): string[] {
  return text.match(TOKEN) ?? [];
}

/** Light plural stemming, as in the original: "pads" -> "pad", but "glass" stays. */
function stem(token: string): string {
  return token.length > 3 && token.endsWith("s") && !token.endsWith("ss") ? token.slice(0, -1) : token;
}

/** Find a car model named in the query; return it and the query with the name removed. */
export async function detectModel(db: Db, q: string): Promise<[DetectedModel | null, string]> {
  const lowered = ` ${tokensOf(q.toLowerCase()).join(" ")} `;
  let best: { id: number; name: string; make: string; key: string } | null = null;
  const rows = await db.all(
    "SELECT mo.id, mo.name, mk.name AS make FROM models mo JOIN makes mk ON mk.id = mo.make_id WHERE mo.is_active ORDER BY mo.id",
  );
  for (const row of rows) {
    const name = tokensOf(String(row.name).toLowerCase()).join(" ");
    if (name && lowered.includes(` ${name} `) && (best === null || name.length > best.key.length)) {
      best = { id: row.id, name: row.name, make: row.make, key: name };
    }
  }
  if (best === null) return [null, q];
  let rest = lowered.replace(` ${best.key} `, " ");
  for (const makeWord of tokensOf(best.make.toLowerCase())) {
    rest = rest.replaceAll(` ${makeWord} `, " ");
  }
  return [{ id: best.id, name: best.name, make: best.make }, rest.trim()];
}

const BASE_FROM =
  " FROM products p JOIN brands b ON b.id = p.brand_id JOIN categories c ON c.id = p.category_id" +
  " JOIN sellers s ON s.id = p.seller_id";

export class Search {
  readonly p: SearchParams;
  detectedModel: DetectedModel | null = null;
  variant: VariantOut | null = null;
  tokens: string[] = [];
  partNorm = "";
  relaxed = false;
  private ready = false;

  constructor(
    readonly db: Db,
    params: Partial<SearchParams> = {},
  ) {
    this.p = { ...SEARCH_DEFAULTS, ...params };
  }

  /** Async part of construction (variant lookup and model detection need the database). */
  async init(): Promise<this> {
    if (this.ready) return this;
    const p = this.p;
    this.variant = p.variantId ? await getVariant(this.db, p.variantId) : null;
    let text = p.q.trim().slice(0, 120);
    if (text && this.variant === null) {
      [this.detectedModel, text] = await detectModel(this.db, text);
    }
    this.tokens = tokensOf(text)
      .map((t) => t.toLowerCase())
      .slice(0, 8);
    const norm = normalizePartNumber(p.q);
    // Part numbers carry digits; plain words ("iridium") are left to full-text search.
    this.partNorm = norm.length >= 4 && /\d/.test(norm) ? norm : "";
    this.ready = true;
    return this;
  }

  // -- query assembly ----------------------------------------------------------------------------

  private matchesCte(mode: Mode): [string, unknown[]] | null {
    const selects: string[] = [];
    const params: unknown[] = [];
    let tq = "";
    if (this.tokens.length) {
      // Tokens are [0-9a-z]+ only, and are still passed as a bound array parameter: each one is
      // unaccented like the document, quoted with quote_literal() and given a prefix marker.
      // `op` is a constant chosen here, never user text. The tsquery lives in its own CTE and is
      // read through scalar subqueries (InitPlans) so the GIN index on `document` can be used.
      const op = mode === "or" ? " | " : " & ";
      tq =
        "tq AS (SELECT to_tsquery('simple', string_agg(quote_literal(pp_unaccent(t)) || ':*', " +
        `'${op}')) AS query FROM unnest(?::text[]) AS t), `;
      // Weights {D, C, B, A}: title/brand/part numbers (A) > category (B) > description (C).
      selects.push(
        "SELECT ps.product_id AS id," +
          " (-ts_rank_cd('{0.1, 0.1, 0.4, 1.0}', ps.document, (SELECT query FROM tq)))::float8 AS rank" +
          " FROM product_search ps WHERE ps.document @@ (SELECT query FROM tq)",
      );
      params.push(this.tokens.map(stem));
    }
    if (this.partNorm) {
      selects.push("SELECT product_id AS id, (-1000.0)::float8 AS rank FROM product_part_numbers WHERE number_norm = ?");
      params.push(this.partNorm);
      // partNorm is [A-Z0-9]+ so it carries no LIKE wildcards.
      selects.push("SELECT product_id AS id, (-500.0)::float8 AS rank FROM product_part_numbers WHERE number_norm LIKE ?");
      params.push(`${this.partNorm}%`);
    }
    if (!selects.length) return null;
    const cte =
      `WITH ${tq}raw AS MATERIALIZED (${selects.join(" UNION ALL ")}),` +
      " m AS (SELECT id, MIN(rank) AS rank FROM raw GROUP BY id) ";
    return [cte, params];
  }

  /** For facets: a parent category shows its children; a leaf shows its siblings. */
  private async categoryScope(): Promise<number | null> {
    if (!this.p.category) return null;
    const cat = await this.db.one("SELECT id, parent_id FROM categories WHERE slug = ? AND is_active", [this.p.category]);
    if (cat === null) return null;
    const hasChildren = await this.db.scalar("SELECT 1 FROM categories WHERE parent_id = ? LIMIT 1", [cat.id]);
    return Number(hasChildren || cat.parent_id === null ? cat.id : cat.parent_id);
  }

  private async where(exclude: string | null = null): Promise<[string[], unknown[]]> {
    const clauses = ["p.status = 'active'", "s.kyc_status = 'approved'"];
    const params: unknown[] = [];
    const p = this.p;
    if (p.category) {
      let scope: number | null;
      if (exclude === "category") {
        scope = await this.categoryScope();
      } else {
        const cat = await this.db.one("SELECT id FROM categories WHERE slug = ? AND is_active", [p.category]);
        scope = cat ? cat.id : -1;
      }
      if (scope !== null) {
        const ids = scope !== -1 ? await categoryDescendants(this.db, scope) : [-1];
        clauses.push(`p.category_id IN (${placeholders(ids)})`);
        params.push(...ids);
      }
    }
    if (p.brands.length && exclude !== "brand") {
      clauses.push(`b.slug IN (${placeholders(p.brands)})`);
      params.push(...p.brands);
    }
    if (this.variant && p.fit === "only") {
      clauses.push(
        "(p.is_universal OR EXISTS (SELECT 1 FROM product_fitments f WHERE f.product_id = p.id AND f.variant_id = ?))",
      );
      params.push(this.variant.id);
    } else if (this.detectedModel) {
      clauses.push(
        "(p.is_universal OR EXISTS (SELECT 1 FROM product_fitments f JOIN variants v" +
          " ON v.id = f.variant_id WHERE f.product_id = p.id AND v.model_id = ?))",
      );
      params.push(this.detectedModel.id);
    }
    if (p.minPaise !== null && p.minPaise !== undefined) {
      clauses.push("p.price_paise >= ?");
      params.push(p.minPaise);
    }
    if (p.maxPaise !== null && p.maxPaise !== undefined) {
      clauses.push("p.price_paise <= ?");
      params.push(p.maxPaise);
    }
    if (p.inStock) clauses.push("p.stock > 0");
    if (p.condition) {
      clauses.push("p.condition = ?");
      params.push(p.condition);
    }
    return [clauses, params];
  }

  private async from(mode: Mode, exclude: string | null = null): Promise<[string, string, unknown[]]> {
    const [clauses, params] = await this.where(exclude);
    if (this.tokens.length || this.partNorm) {
      const cte = this.matchesCte(mode);
      if (cte === null) throw new Error("search: match CTE missing");
      const [prefix, cteParams] = cte;
      return [prefix, ` JOIN m ON m.id = p.id WHERE ${clauses.join(" AND ")}`, [...cteParams, ...params]];
    }
    return ["", ` WHERE ${clauses.join(" AND ")}`, params];
  }

  private order(): string {
    const sort = SORTS.has(this.p.sort) ? this.p.sort : "relevance";
    const hasRank = Boolean(this.tokens.length || this.partNorm);
    const orders: Record<string, string> = {
      price_asc: "p.price_paise ASC, p.id DESC",
      price_desc: "p.price_paise DESC, p.id DESC",
      newest: "p.created_at DESC, p.id DESC",
      rating: "p.rating_avg DESC, p.rating_count DESC, p.id DESC",
      relevance: hasRank ? "m.rank ASC, p.sold_count DESC, p.id DESC" : "p.sold_count DESC, p.rating_avg DESC, p.id DESC",
    };
    return orders[sort];
  }

  // -- execution -----------------------------------------------------------------------------

  async run() {
    await this.init();
    let mode: Mode = "and";
    let result = await this.page(mode);
    if (result.total === 0 && this.tokens.length > 1 && !this.partNorm) {
      this.relaxed = true;
      mode = "or";
      result = await this.page(mode);
    }
    return {
      ...result,
      facets: await this.facets(mode),
      relaxed: this.relaxed,
      vehicle: this.variant,
      detected_model: this.detectedModel,
    };
  }

  private async page(mode: Mode) {
    const [cte, where, params] = await this.from(mode);
    const total = Number((await this.db.scalar(`${cte}SELECT COUNT(*)${BASE_FROM}${where}`, params as Params)) ?? 0);
    const perPage = Math.min(Math.max(this.p.perPage, 1), 60);
    const page = Math.max(this.p.page, 1);
    const rows = await this.db.all(`${cte}${PRODUCT_CARD_SELECT}${where} ORDER BY ${this.order()} LIMIT ? OFFSET ?`, [
      ...params,
      perPage,
      (page - 1) * perPage,
    ]);
    const variantId = this.variant ? this.variant.id : null;
    let items: ReturnType<typeof cardOut>[];
    if (variantId) {
      const fitting = await fitmentMap(
        this.db,
        rows.map((r) => r.id),
        variantId,
      );
      items = rows.map((r) => cardOut(r, Boolean(r.is_universal) || fitting.has(r.id)));
    } else {
      items = rows.map((r) => cardOut(r));
    }
    return {
      items,
      total,
      page,
      per_page: perPage,
      pages: Math.max(1, Math.ceil(total / perPage)),
    };
  }

  private async facets(mode: Mode) {
    let [cte, where, params] = await this.from(mode, "brand");
    const brands = await this.db.all(
      `${cte}SELECT b.slug, b.name, b.is_oem, COUNT(*) AS count${BASE_FROM}${where}` +
        " GROUP BY b.id ORDER BY count DESC, b.name LIMIT 30",
      params,
    );
    [cte, where, params] = await this.from(mode, "category");
    const categories = await this.db.all(
      `${cte}SELECT c.slug, c.name, COUNT(*) AS count${BASE_FROM}${where}` +
        " GROUP BY c.id ORDER BY count DESC, c.name LIMIT 30",
      params,
    );
    [cte, where, params] = await this.from(mode);
    const price = (await this.db.one(
      `${cte}SELECT MIN(p.price_paise) AS min, MAX(p.price_paise) AS max${BASE_FROM}${where}`,
      params,
    )) ?? { min: null, max: null };
    return {
      brands: brands.map((b) => ({ slug: b.slug, name: b.name, is_oem: Boolean(b.is_oem), count: b.count })),
      categories: categories.map((c) => ({ slug: c.slug, name: c.name, count: c.count })),
      price: { min: price.min, max: price.max },
    };
  }
}
