// GST tax invoice for one shipment (fulfilment), as a PDF.
//
// The seller is the supplier, so the invoice is in the seller's name, using the seller details
// copied onto the shipment when it shipped (migration 0004). Prices are GST-inclusive: the taxable
// value is backed out of each line. Same state as the delivery address -> CGST + SGST, otherwise IGST.
// Delivery charges are a composite supply with the parts, so they carry the highest GST rate on the
// invoice.

import path from "node:path";
import { fileURLToPath } from "node:url";
import PDFDocument from "pdfkit";
import type { Db, Row } from "../db.js";
import { gstIncluded } from "../util.js";

const FONTS = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fonts");

/** GST state codes (first two digits of a GSTIN). */
export const GST_STATE_CODES: Record<string, string> = {
  "Jammu and Kashmir": "01",
  "Himachal Pradesh": "02",
  Punjab: "03",
  Chandigarh: "04",
  Uttarakhand: "05",
  Haryana: "06",
  Delhi: "07",
  Rajasthan: "08",
  "Uttar Pradesh": "09",
  Bihar: "10",
  Sikkim: "11",
  "Arunachal Pradesh": "12",
  Nagaland: "13",
  Manipur: "14",
  Mizoram: "15",
  Tripura: "16",
  Meghalaya: "17",
  Assam: "18",
  "West Bengal": "19",
  Jharkhand: "20",
  Odisha: "21",
  Chhattisgarh: "22",
  "Madhya Pradesh": "23",
  Gujarat: "24",
  "Dadra and Nagar Haveli and Daman and Diu": "26",
  Maharashtra: "27",
  Karnataka: "29",
  Goa: "30",
  Lakshadweep: "31",
  Kerala: "32",
  "Tamil Nadu": "33",
  Puducherry: "34",
  "Andaman and Nicobar Islands": "35",
  Telangana: "36",
  "Andhra Pradesh": "37",
  Ladakh: "38",
};

function stateCode(state: string): string {
  const key = Object.keys(GST_STATE_CODES).find((s) => s.toLowerCase() === state.trim().toLowerCase());
  return key ? GST_STATE_CODES[key]! : "";
}

const stateLabel = (state: string) => {
  const code = stateCode(state);
  return code ? `${state} (${code})` : state;
};

export interface InvoiceLine {
  description: string;
  detail: string;
  hsn: string;
  quantity: number;
  ratePct: number;
  totalPaise: number;
  taxablePaise: number;
  taxPaise: number;
}

export interface InvoiceData {
  number: string;
  date: string;
  orderNumber: string;
  orderDate: string;
  paymentMethod: string;
  seller: Record<string, string>;
  buyer: { name: string; phone: string; lines: string[]; state: string };
  intraState: boolean;
  lines: InvoiceLine[];
  taxablePaise: number;
  taxPaise: number;
  totalPaise: number;
  appName: string;
}

/** The shipment as an invoice, or null if it has not shipped (no invoice issued yet). */
export async function loadInvoice(db: Db, f: Row, appName: string): Promise<InvoiceData | null> {
  if (!f.invoice_number) return null;
  const order = await db.one("SELECT * FROM orders WHERE id = ?", [f.order_id]);
  if (!order) throw new Error(`order ${f.order_id} missing`);
  const items = await db.all(
    `SELECT title, brand, part_number, unit_price_paise, quantity, gst_rate_bps, hsn_code, line_total_paise
     FROM order_items WHERE fulfilment_id = ? ORDER BY id`,
    [f.id],
  );
  const seller = (typeof f.invoice_seller === "string" ? JSON.parse(f.invoice_seller) : f.invoice_seller) as Record<string, string>;
  const line = (description: string, detail: string, hsn: string, quantity: number, rateBps: number, total: number): InvoiceLine => {
    const tax = gstIncluded(total, rateBps);
    return { description, detail, hsn, quantity, ratePct: rateBps / 100, totalPaise: total, taxablePaise: total - tax, taxPaise: tax };
  };
  const lines = items.map((i) =>
    line(
      i.title,
      `${i.brand} · Part no. ${i.part_number} · ${money(i.unit_price_paise)} each`,
      i.hsn_code,
      i.quantity,
      i.gst_rate_bps,
      i.line_total_paise,
    ),
  );
  if (f.shipping_paise > 0) {
    const topRate = Math.max(0, ...items.map((i) => Number(i.gst_rate_bps)));
    lines.push(line("Delivery charges", "Part of the supply of goods above", "996812", 1, topRate, f.shipping_paise));
  }
  const sum = (k: "taxablePaise" | "taxPaise" | "totalPaise") => lines.reduce((s, l) => s + l[k], 0);
  return {
    number: f.invoice_number,
    date: istDate(f.invoice_date),
    orderNumber: order.number,
    orderDate: istDate(order.created_at),
    paymentMethod: order.payment_method === "cod" ? "Cash on delivery" : "Paid online",
    seller,
    buyer: {
      name: order.ship_name,
      phone: order.ship_phone,
      lines: [
        order.ship_line1,
        order.ship_line2,
        order.ship_landmark ? `Near ${order.ship_landmark}` : null,
        `${order.ship_city} - ${order.ship_pincode}`,
      ].filter(Boolean),
      state: order.ship_state,
    },
    intraState: stateCode(seller.state ?? "") !== "" && stateCode(seller.state ?? "") === stateCode(order.ship_state),
    lines,
    taxablePaise: sum("taxablePaise"),
    taxPaise: sum("taxPaise"),
    totalPaise: sum("totalPaise"),
    appName,
  };
}

// ---- formatting -----------------------------------------------------------------------------------------------

const inr = new Intl.NumberFormat("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function money(paise: number): string {
  return `₹${inr.format(paise / 100)}`;
}

function amount(paise: number): string {
  return inr.format(paise / 100);
}

function istDate(value: unknown): string {
  // DATE columns arrive as "YYYY-MM-DD" (or a Date at UTC midnight); timestamps are shown in India time.
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [y, m, d] = value.split("-");
    return `${d}-${m}-${y}`;
  }
  const date = value instanceof Date ? value : new Date(String(value));
  return new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", day: "2-digit", month: "2-digit", year: "numeric" })
    .format(date)
    .replace(/\//g, "-");
}

const ONES = [
  "", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten", "Eleven", "Twelve",
  "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen",
];
const TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];

function belowHundred(n: number): string {
  return n < 20 ? ONES[n]! : `${TENS[Math.floor(n / 10)]}${n % 10 ? ` ${ONES[n % 10]}` : ""}`;
}

function belowThousand(n: number): string {
  const h = Math.floor(n / 100);
  const rest = n % 100;
  return [h ? `${ONES[h]} Hundred` : "", rest ? belowHundred(rest) : ""].filter(Boolean).join(" ");
}

/** 123456 -> "One Lakh Twenty Three Thousand Four Hundred Fifty Six" (Indian grouping). */
export function indianWords(n: number): string {
  if (n === 0) return "Zero";
  const parts: string[] = [];
  const crore = Math.floor(n / 10_000_000);
  const lakh = Math.floor((n % 10_000_000) / 100_000);
  const thousand = Math.floor((n % 100_000) / 1000);
  const rest = n % 1000;
  if (crore) parts.push(`${indianWords(crore)} Crore`);
  if (lakh) parts.push(`${belowHundred(lakh)} Lakh`);
  if (thousand) parts.push(`${belowHundred(thousand)} Thousand`);
  if (rest) parts.push(belowThousand(rest));
  return parts.join(" ");
}

export function rupeesInWords(paise: number): string {
  const rupees = Math.floor(paise / 100);
  const p = paise % 100;
  return `Rupees ${indianWords(rupees)}${p ? ` and ${belowHundred(p)} Paise` : ""} Only`;
}

// ---- PDF ------------------------------------------------------------------------------------------------------

/** Intra-state GST split into [CGST, SGST]; an odd paisa goes to CGST. */
export function splitTax(taxPaise: number): [number, number] {
  const sgst = Math.floor(taxPaise / 2);
  return [taxPaise - sgst, sgst];
}

const INK = "#111111";
const MUTED = "#555555";
const RULE = "#bbbbbb";

/**
 * The marketplace logo (barcode mark + tracked wordmark, as in the web app's <Logo>), right-aligned at
 * `right`, with "Sold through" above it. Drawn as vectors so it stays sharp at any zoom.
 */
function brandMark(doc: PDFKit.PDFDocument, appName: string, right: number, top: number) {
  const word = appName.toUpperCase();
  const tracking = 2.2;
  const size = 22; // mark edge in points
  const gap = 8;
  doc.font("bold").fontSize(10.5);
  const wordW = doc.widthOfString(word, { characterSpacing: tracking });
  const markX = right - wordW - gap - size;
  const markY = top + 11;

  const caption = "SOLD THROUGH";
  doc.font("regular").fontSize(6.5).fillColor(MUTED);
  const captionW = doc.widthOfString(caption, { characterSpacing: 1 });
  doc.text(caption, right - captionW, top, { lineBreak: false, characterSpacing: 1 });

  doc.save();
  doc.translate(markX, markY).scale(size / 32);
  doc.roundedRect(0.5, 0.5, 31, 31, 4).lineWidth(1.2).strokeColor(INK).strokeOpacity(0.55).stroke();
  doc.fillColor(INK).fillOpacity(1);
  for (const [x, w] of [[8, 2], [12, 1], [15, 3], [20, 1], [23, 1.5]] as const) doc.rect(x, 8, w, 16).fill();
  doc.restore();

  doc.font("bold").fontSize(10.5).fillColor(INK)
    .text(word, right - wordW, markY + 5.5, { lineBreak: false, characterSpacing: tracking });
}

export function invoicePdf(inv: InvoiceData): Promise<Buffer> {
  const doc = new PDFDocument({
    size: "A4",
    margin: 40,
    info: { Title: `Tax invoice ${inv.number}`, Author: inv.seller.business_name ?? "", Creator: inv.appName },
  });
  doc.registerFont("regular", path.join(FONTS, "Inter-Regular.woff"));
  doc.registerFont("bold", path.join(FONTS, "Inter-SemiBold.woff"));
  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  const left = 40;
  const width = doc.page.width - 80;
  const right = left + width;
  const s = inv.seller;

  // Header
  doc.font("bold").fontSize(16).fillColor(INK).text("Tax Invoice", left, 40);
  doc.font("regular").fontSize(8).fillColor(MUTED).text("Original for recipient", left, 60);
  brandMark(doc, inv.appName, right, 40);

  // Seller and invoice details
  let y = 84;
  doc.moveTo(left, y).lineTo(right, y).strokeColor(RULE).lineWidth(0.5).stroke();
  y += 10;
  const colW = width / 2 - 10;
  const sellerLines = [
    s.address_line,
    `${s.city} - ${s.pincode}`,
    `State: ${stateLabel(s.state ?? "")}`,
    `GSTIN: ${s.gstin}`,
    s.phone ? `Phone: ${s.phone}` : "",
  ].filter(Boolean);
  doc.font("regular").fontSize(7.5).fillColor(MUTED).text("SOLD BY", left, y);
  doc.font("bold").fontSize(10).fillColor(INK).text(s.business_name ?? "", left, y + 11, { width: colW });
  doc.font("regular").fontSize(8.5).text(sellerLines.join("\n"), left, doc.y + 2, { width: colW, lineGap: 1.5 });
  const sellerBottom = doc.y;

  const detailX = left + width / 2 + 10;
  const details: [string, string][] = [
    ["Invoice number", inv.number],
    ["Invoice date", inv.date],
    ["Order number", inv.orderNumber],
    ["Order date", inv.orderDate],
    ["Place of supply", stateLabel(inv.buyer.state)],
    ["Reverse charge", "No"],
    ["Payment", inv.paymentMethod],
  ];
  let dy = y;
  for (const [k, v] of details) {
    doc.font("regular").fontSize(8.5).fillColor(MUTED).text(k, detailX, dy, { width: 90 });
    doc.font("bold").fillColor(INK).text(v, detailX + 92, dy, { width: colW - 92 });
    dy = doc.y + 2;
  }
  y = Math.max(sellerBottom, dy) + 10;

  // Buyer
  doc.moveTo(left, y).lineTo(right, y).strokeColor(RULE).stroke();
  y += 10;
  doc.font("regular").fontSize(7.5).fillColor(MUTED).text("BILL TO / SHIP TO", left, y);
  doc.font("bold").fontSize(10).fillColor(INK).text(inv.buyer.name, left, y + 11, { width });
  doc
    .font("regular")
    .fontSize(8.5)
    .text([...inv.buyer.lines, `State: ${stateLabel(inv.buyer.state)}`, `Phone: ${inv.buyer.phone}`].join("\n"), left, doc.y + 2, {
      width,
      lineGap: 1.5,
    });
  y = doc.y + 14;

  // Line items
  type Col = { title: string; w: number; align: "left" | "right" | "center" };
  const taxCols: Col[] = inv.intraState
    ? [
        { title: "CGST", w: 58, align: "right" },
        { title: "SGST", w: 58, align: "right" },
      ]
    : [{ title: "IGST", w: 116, align: "right" }];
  const cols: Col[] = [
    { title: "#", w: 18, align: "left" },
    { title: "Description", w: 0, align: "left" },
    { title: "HSN/SAC", w: 48, align: "left" },
    { title: "Qty", w: 26, align: "right" },
    { title: "Taxable value", w: 66, align: "right" },
    { title: "GST %", w: 34, align: "right" },
    ...taxCols,
    { title: "Total", w: 66, align: "right" },
  ];
  cols[1]!.w = width - cols.reduce((sum, c) => sum + c.w, 0);
  const xs: number[] = [];
  let cx = left;
  for (const c of cols) {
    xs.push(cx);
    cx += c.w;
  }
  const pad = 3;
  const cell = (i: number, text: string, top: number, opts: { font?: string; size?: number; color?: string } = {}) => {
    const c = cols[i]!;
    doc
      .font(opts.font ?? "regular")
      .fontSize(opts.size ?? 8.5)
      .fillColor(opts.color ?? INK)
      .text(text, xs[i]! + pad, top, { width: c.w - pad * 2, align: c.align });
    return doc.y;
  };

  const header = () => {
    doc.rect(left, y, width, 18).fillColor("#f1f1f1").fill();
    cols.forEach((c, i) => cell(i, c.title, y + 5, { font: "bold", size: 7.5 }));
    y += 18;
  };
  header();

  inv.lines.forEach((l, idx) => {
    const [cgst, sgst] = splitTax(l.taxPaise);
    const taxValues = inv.intraState
      ? [`${amount(cgst)}\n${l.ratePct / 2}%`, `${amount(sgst)}\n${l.ratePct / 2}%`]
      : [`${amount(l.taxPaise)}\n${l.ratePct}%`];
    // Measure the row first so it can move to a new page whole.
    doc.font("bold").fontSize(8.5);
    const descH =
      doc.heightOfString(l.description, { width: cols[1]!.w - pad * 2 }) +
      doc.font("regular").fontSize(7.5).heightOfString(l.detail, { width: cols[1]!.w - pad * 2 });
    const rowH = Math.max(descH, 22) + 10;
    if (y + rowH > doc.page.height - 160) {
      doc.addPage();
      y = 40;
      header();
    }
    const top = y + 5;
    cell(0, String(idx + 1), top);
    cell(1, l.description, top, { font: "bold" });
    cell(1, l.detail, doc.y + 1, { size: 7.5, color: MUTED });
    cell(2, l.hsn, top);
    cell(3, String(l.quantity), top);
    cell(4, amount(l.taxablePaise), top);
    cell(5, `${l.ratePct}%`, top);
    taxValues.forEach((t, i) => cell(6 + i, t, top));
    cell(6 + taxValues.length, amount(l.totalPaise), top, { font: "bold" });
    y += rowH;
    doc.moveTo(left, y).lineTo(right, y).strokeColor(RULE).lineWidth(0.5).stroke();
  });

  // Totals
  y += 10;
  // Sum the per-line halves so the totals match the rows to the paisa.
  const cgstTotal = inv.lines.reduce((sum, l) => sum + splitTax(l.taxPaise)[0], 0);
  const totals: [string, string][] = [
    ["Taxable value", money(inv.taxablePaise)],
    ...(inv.intraState
      ? ([
          ["CGST", money(cgstTotal)],
          ["SGST", money(inv.taxPaise - cgstTotal)],
        ] as [string, string][])
      : ([["IGST", money(inv.taxPaise)]] as [string, string][])),
  ];
  const labelX = right - 230;
  for (const [k, v] of totals) {
    doc.font("regular").fontSize(9).fillColor(MUTED).text(k, labelX, y, { width: 120 });
    doc.fillColor(INK).text(v, labelX + 120, y, { width: 110, align: "right" });
    y = doc.y + 3;
  }
  doc.moveTo(labelX, y).lineTo(right, y).strokeColor(INK).lineWidth(0.8).stroke();
  y += 5;
  doc.font("bold").fontSize(11).fillColor(INK).text("Invoice total", labelX, y, { width: 120 });
  doc.text(money(inv.totalPaise), labelX + 120, y, { width: 110, align: "right" });
  y = doc.y + 8;
  doc.font("regular").fontSize(8.5).fillColor(MUTED).text("Amount in words", left, y, { width });
  doc.font("bold").fillColor(INK).text(rupeesInWords(inv.totalPaise), left, doc.y + 1, { width });
  doc
    .font("regular")
    .fontSize(8)
    .fillColor(MUTED)
    .text("All prices include GST. Tax shown is the GST contained in each amount.", left, doc.y + 4, { width });

  // Signature and footer
  y = Math.max(doc.y + 24, doc.page.height - 150);
  doc.font("regular").fontSize(8.5).fillColor(INK).text(`For ${s.business_name ?? ""}`, right - 220, y, { width: 220, align: "right" });
  doc.fillColor(MUTED).text("Authorised signatory", right - 220, y + 34, { width: 220, align: "right" });
  const footY = doc.page.height - 70;
  doc.moveTo(left, footY).lineTo(right, footY).strokeColor(RULE).lineWidth(0.5).stroke();
  doc
    .font("regular")
    .fontSize(7.5)
    .fillColor(MUTED)
    .text(
      `This is a computer-generated invoice issued by the seller named above. ${inv.appName} is the marketplace ` +
        "through which the order was placed and is not the seller of these goods.",
      left,
      footY + 6,
      { width },
    );

  doc.end();
  return done;
}

/** Safe file name for the download, e.g. Invoice-S12-2627-00001.pdf */
export function invoiceFileName(number: string): string {
  return `Invoice-${number.replace(/[^A-Za-z0-9-]/g, "-")}.pdf`;
}
