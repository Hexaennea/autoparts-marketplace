// Bulk listing import from CSV, plus safe CSV export helpers.
//
// Rows are validated one by one and every problem is reported with its row number. Nothing is
// written unless the whole file is valid (all-or-nothing), so a seller never ends up with half an import.
// Existing SKUs are updated in place, which makes the same file usable for price/stock syncs.

import { parse } from "csv-parse/sync";
import type { Db } from "../db.js";
import { type ListingData, saveListing } from "./listings.js";

export const COLUMNS = [
  "sku",
  "title",
  "category",
  "brand",
  "part_number",
  "oem_numbers",
  "condition",
  "price",
  "mrp",
  "stock",
  "gst_rate",
  "hsn_code",
  "warranty_months",
  "weight_grams",
  "universal",
  "vehicle_codes",
  "description",
];
export const REQUIRED = new Set(["sku", "title", "category", "brand", "part_number", "price", "mrp", "stock"]);
export const MAX_ROWS = 500;
const SKU_RE = /^[A-Za-z0-9._-]{2,40}$/;

export interface ImportError {
  row: number;
  field: string;
  message: string;
}
export type ParsedRow = [number, ListingData, number | null];

/** Neutralise spreadsheet formula injection in exported cells. */
export function csvSafe(value: unknown): string {
  const text = pyStr(value);
  return ["=", "+", "-", "@", "\t", "\r"].includes(text.slice(0, 1)) ? `'${text}` : text;
}

function pyStr(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "boolean") return value ? "True" : "False";
  return String(value);
}

/** Python csv.writer (excel dialect, QUOTE_MINIMAL, \r\n line endings). */
function csvField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

function csvRow(values: string[]): string {
  if (values.length === 1 && values[0] === "") return '""\r\n';
  return `${values.map(csvField).join(",")}\r\n`;
}

export function toCsv(header: string[], rows: unknown[][]): string {
  let out = csvRow(header.map(pyStr));
  for (const row of rows) out += csvRow(row.map(csvSafe));
  return out;
}

/** Length in code points (Python len()). */
function pyLen(value: string): number {
  return [...value].length;
}

function collapse(value: string): string {
  return value.split(/\s+/).filter(Boolean).join(" ");
}

class ValueError extends Error {}

const DECIMAL_RE = /^([+-]?)(\d+(?:_\d+)*)?(?:\.(\d+(?:_\d+)*)?)?(?:[eE]([+-]?\d+(?:_\d+)*))?$/;
const MAX_PAISE = 100_000_000n; // ₹10,00,000

/** Rupees string → integer paise, exact decimal math with half-even rounding (like Decimal.quantize). */
function paise(value: string): number {
  const cleaned = value.replaceAll(",", "").replaceAll("₹", "").trim();
  const m = DECIMAL_RE.exec(cleaned);
  if (!m || (m[2] === undefined && m[3] === undefined)) throw new ValueError();
  const negative = m[1] === "-";
  const intPart = (m[2] ?? "").replaceAll("_", "");
  const fracPart = (m[3] ?? "").replaceAll("_", "");
  const exp = Number((m[4] ?? "0").replaceAll("_", ""));
  const digits = (intPart + fracPart).replace(/^0+/, "");
  if (!digits || negative) throw new ValueError(); // amount <= 0
  // value = digits * 10^(shift) paise
  const shift = exp + 2 - fracPart.length;
  if (digits.length + shift > 12) throw new ValueError(); // far above the maximum
  let whole: bigint;
  let rest = "";
  if (shift >= 0) {
    whole = BigInt(digits) * 10n ** BigInt(shift);
  } else {
    const cut = digits.length + shift;
    whole = cut > 0 ? BigInt(digits.slice(0, cut)) : 0n;
    rest = cut > 0 ? digits.slice(cut) : "0".repeat(-cut) + digits;
  }
  const restNonZero = /[1-9]/.test(rest);
  if (whole > MAX_PAISE || (whole === MAX_PAISE && restNonZero)) throw new ValueError();
  if (restNonZero) {
    const half = `5${"0".repeat(rest.length - 1)}`;
    if (rest > half || (rest === half && whole % 2n === 1n)) whole += 1n;
  }
  return Number(whole);
}

const INT_RE = /^[+-]?\d+(?:_\d+)*$/;

function int(value: string, lo: number, hi: number, fallback: number | null = null): number {
  if (value.trim() === "" && fallback !== null) return fallback;
  const text = value.trim();
  if (!INT_RE.test(text)) throw new ValueError();
  const number = Number(text.replaceAll("_", ""));
  if (!(lo <= number && number <= hi)) throw new ValueError();
  return number;
}

export async function parseImport(db: Db, sellerId: number, raw: Buffer): Promise<[ParsedRow[], ImportError[]]> {
  let text: string;
  try {
    // fatal: reject invalid UTF-8; the BOM (utf-8-sig) is stripped by default.
    text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
  } catch {
    return [[], [{ row: 0, field: "file", message: "Save the file as UTF-8 CSV and try again." }]];
  }
  let records: string[][];
  try {
    records = parse(text, { relax_column_count: true, relax_quotes: true, skip_empty_lines: true }) as string[][];
  } catch {
    return [[], [{ row: 0, field: "file", message: "The file couldn't be read as CSV. Save it as UTF-8 CSV and try again." }]];
  }
  const headers = (records[0] ?? []).map((h) => h.trim().toLowerCase());
  const present = new Set(headers);
  const missing = [...REQUIRED].filter((c) => !present.has(c)).sort();
  if (missing.length) {
    return [[], [{ row: 1, field: "header", message: `Missing columns: ${missing.join(", ")}.` }]];
  }

  const categories = new Map<string, number>(
    (await db.all("SELECT id, slug FROM categories WHERE is_active")).map((r) => [r.slug, Number(r.id)]),
  );
  const brands = new Map<string, number>();
  const oemBrands = new Set<number>();
  for (const r of await db.all("SELECT id, slug, name, is_oem FROM brands WHERE is_active")) {
    brands.set(r.slug, Number(r.id));
    brands.set(String(r.name).toLowerCase(), Number(r.id));
    if (r.is_oem) oemBrands.add(Number(r.id));
  }
  const variantCodes = new Map<string, number>(
    (await db.all("SELECT id, code FROM variants WHERE is_active")).map((r) => [r.code, Number(r.id)]),
  );
  const existing = new Map<string, number>(
    (await db.all("SELECT id, sku FROM products WHERE seller_id = ? AND status != 'archived'", [sellerId])).map((r) => [
      r.sku,
      Number(r.id),
    ]),
  );
  const archived = new Set<string>(
    (await db.all("SELECT sku FROM products WHERE seller_id = ? AND status = 'archived'", [sellerId])).map((r) => r.sku),
  );

  const parsed: ParsedRow[] = [];
  const errors: ImportError[] = [];
  const seenSkus = new Set<string>();
  for (let i = 1; i < records.length; i++) {
    const index = i + 1;
    if (index - 1 > MAX_ROWS) {
      errors.push({ row: index, field: "file", message: `Import up to ${MAX_ROWS} rows at a time.` });
      break;
    }
    // Like csv.DictReader: missing trailing cells are empty, extra cells and blank headers are dropped,
    // a repeated header keeps its last value.
    const record = records[i];
    const row: Record<string, string> = {};
    headers.forEach((h, col) => {
      if (h) row[h] = (record[col] ?? "").trim();
    });
    if (!Object.values(row).some(Boolean)) continue;
    const get = (key: string) => row[key] ?? "";
    const fail = (field: string, message: string) => errors.push({ row: index, field, message });

    const sku = get("sku");
    if (!SKU_RE.test(sku)) fail("sku", "SKU must be 2–40 letters, numbers, dots, dashes or underscores.");
    else if (seenSkus.has(sku)) fail("sku", "This SKU appears more than once in the file.");
    else if (archived.has(sku)) fail("sku", "This SKU belongs to an archived listing. Restore it first, or use a new SKU.");
    seenSkus.add(sku);
    const title = collapse(get("title"));
    if (!(pyLen(title) >= 8 && pyLen(title) <= 150)) fail("title", "Title must be 8–150 characters.");
    const categoryId = categories.get(get("category").toLowerCase());
    if (categoryId === undefined) fail("category", "Unknown category. Use a category code from the template.");
    const brandId = brands.get(get("brand").toLowerCase());
    if (brandId === undefined) fail("brand", "Unknown brand. Use a brand from the template.");
    const partNumber = get("part_number");
    if (!(pyLen(partNumber) >= 3 && pyLen(partNumber) <= 40)) fail("part_number", "Part number must be 3–40 characters.");
    const condition = (get("condition") || "new").toLowerCase().replaceAll(" ", "_");
    if (condition !== "new" && condition !== "oem_genuine") {
      fail("condition", "Condition must be 'new' or 'oem_genuine'.");
    } else if (condition === "oem_genuine" && brandId !== undefined && !oemBrands.has(brandId)) {
      fail("condition", "Only vehicle-maker (OEM) brands can be listed as OEM genuine.");
    }
    let price = 0;
    try {
      price = paise(get("price"));
    } catch {
      fail("price", "Price must be a number in rupees, e.g. 1249 or 1249.50.");
      price = 0;
    }
    let mrp = 0;
    try {
      mrp = paise(get("mrp"));
    } catch {
      fail("mrp", "MRP must be a number in rupees.");
      mrp = 0;
    }
    if (price && mrp && mrp < price) fail("mrp", "MRP can't be lower than the price.");
    let stock = 0;
    try {
      stock = int(get("stock"), 0, 100_000);
    } catch {
      fail("stock", "Stock must be a whole number from 0 to 100000.");
      stock = 0;
    }
    let gstPercent = 18;
    try {
      gstPercent = int(get("gst_rate"), 0, 28, 18);
      if (![0, 5, 12, 18, 28].includes(gstPercent)) throw new ValueError();
    } catch {
      fail("gst_rate", "GST rate must be 0, 5, 12, 18 or 28.");
      gstPercent = 18;
    }
    const hsn = get("hsn_code") || "8708";
    if (!/^\d{4,8}$/.test(hsn)) fail("hsn_code", "HSN code must be 4–8 digits.");
    let warranty = 0;
    try {
      warranty = int(get("warranty_months"), 0, 120, 0);
    } catch {
      fail("warranty_months", "Warranty must be 0–120 months.");
      warranty = 0;
    }
    let weight = 500;
    try {
      weight = int(get("weight_grams"), 1, 100_000, 500);
    } catch {
      fail("weight_grams", "Weight must be 1–100000 grams.");
      weight = 500;
    }
    const universal = ["yes", "y", "true", "1"].includes(get("universal").toLowerCase());
    const codes = get("vehicle_codes")
      .split(/[\s;,]+/)
      .filter(Boolean);
    const unknown = codes.filter((c) => !variantCodes.has(c.toUpperCase()));
    if (unknown.length) fail("vehicle_codes", `Unknown vehicle codes: ${unknown.slice(0, 5).join(", ")}.`);
    const description = [...get("description")].slice(0, 4000).join("");
    const oemNumbers = get("oem_numbers")
      .split(/[;,]+/)
      .map((n) => n.trim())
      .filter((n) => pyLen(n) >= 3 && pyLen(n) <= 40)
      .slice(0, 20);

    if (errors.length && errors[errors.length - 1].row === index) continue;
    parsed.push([
      index,
      {
        title,
        sku,
        categoryId: categoryId as number,
        brandId: brandId as number,
        partNumber,
        condition,
        pricePaise: price,
        mrpPaise: mrp,
        stock,
        gstRateBps: gstPercent * 100,
        hsnCode: hsn,
        warrantyMonths: warranty,
        weightGrams: weight,
        description,
        isUniversal: universal,
        oemNumbers,
        specs: [],
        variantIds: codes.map((c) => variantCodes.get(c.toUpperCase()) as number),
        imageIds: null,
      },
      existing.get(sku) ?? null,
    ]);
  }
  if (!parsed.length && !errors.length) {
    errors.push({ row: 0, field: "file", message: "The file has no rows to import." });
  }
  return [parsed, errors];
}

export async function applyImport(
  db: Db,
  sellerId: number,
  parsed: ParsedRow[],
): Promise<{ created: number; updated: number }> {
  let created = 0;
  let updated = 0;
  for (const [, data, productId] of parsed) {
    await saveListing(db, sellerId, data, productId, { submit: false });
    if (productId === null) created++;
    else updated++;
  }
  return { created, updated };
}
