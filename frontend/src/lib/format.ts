// Formatting for Indian rupees, dates and small text helpers. Pure functions (unit tested).

const inr = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2, minimumFractionDigits: 0 });
const inrWhole = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 });
const compact = new Intl.NumberFormat("en-IN", { notation: "compact", maximumFractionDigits: 1 });

/** 124900 → "₹1,249"; 124950 → "₹1,249.50" */
export function rupees(paise: number): string {
  const value = paise / 100;
  if (Number.isInteger(value)) return inrWhole.format(value);
  return inr.format(value).replace(/(\.\d)$/, "$10");
}

/** Short form for dashboards: 12345600 → "₹1.2L" */
export function rupeesShort(paise: number): string {
  const value = paise / 100;
  if (value >= 1e7) return `₹${(value / 1e7).toFixed(value >= 1e8 ? 0 : 1)}Cr`;
  if (value >= 1e5) return `₹${(value / 1e5).toFixed(value >= 1e6 ? 0 : 1)}L`;
  if (value >= 1e3) return `₹${(value / 1e3).toFixed(value >= 1e4 ? 0 : 1)}K`;
  return rupees(paise);
}

export function percentOff(price: number, mrp: number): number {
  if (!mrp || mrp <= price) return 0;
  return Math.round(((mrp - price) / mrp) * 100);
}

export function count(n: number): string {
  return n >= 10000 ? compact.format(n) : n.toLocaleString("en-IN");
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString("en-IN")} ${n === 1 ? one : many}`;
}

const dateFmt = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric" });
const dateTimeFmt = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
const dayFmt = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short" });

export function date(iso: string | null | undefined): string {
  return iso ? dateFmt.format(new Date(iso)) : "—";
}

export function dateTime(iso: string | null | undefined): string {
  return iso ? dateTimeFmt.format(new Date(iso)) : "—";
}

export function day(iso: string): string {
  return dayFmt.format(new Date(iso));
}

export function relative(iso: string, now: Date = new Date()): string {
  const seconds = Math.round((now.getTime() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days} d ago`;
  return date(iso);
}

export function gstPercent(bps: number): string {
  return `${bps / 100}%`;
}

export function initials(name: string): string {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]!.toUpperCase()).join("");
}

/** Rupee input ("1,249.50") → paise, or null when not a valid amount. */
export function parseRupees(text: string): number | null {
  const cleaned = text.replace(/[₹,\s]/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  return Math.round(Number(cleaned) * 100);
}

export function paiseToInput(paise: number): string {
  const value = paise / 100;
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

export function warranty(months: number): string {
  if (!months) return "No warranty";
  if (months % 12 === 0) return `${months / 12} year${months === 12 ? "" : "s"}`;
  return `${months} months`;
}

/** Whole-rupee display for derived figures (GST inside a total) so columns don't mix paise and rupees. */
export function rupeesRounded(paise: number): string {
  return rupees(Math.round(paise / 100) * 100);
}
