// Pure helpers: identifiers, Indian business-identifier validation, money math, and the
// zod field types that mirror the validation rules of the original API.

import { z } from "zod";

export const INDIAN_STATES = [
  "Andaman and Nicobar Islands",
  "Andhra Pradesh",
  "Arunachal Pradesh",
  "Assam",
  "Bihar",
  "Chandigarh",
  "Chhattisgarh",
  "Dadra and Nagar Haveli and Daman and Diu",
  "Delhi",
  "Goa",
  "Gujarat",
  "Haryana",
  "Himachal Pradesh",
  "Jammu and Kashmir",
  "Jharkhand",
  "Karnataka",
  "Kerala",
  "Ladakh",
  "Lakshadweep",
  "Madhya Pradesh",
  "Maharashtra",
  "Manipur",
  "Meghalaya",
  "Mizoram",
  "Nagaland",
  "Odisha",
  "Puducherry",
  "Punjab",
  "Rajasthan",
  "Sikkim",
  "Tamil Nadu",
  "Telangana",
  "Tripura",
  "Uttar Pradesh",
  "Uttarakhand",
  "West Bengal",
] as const;

export function slugify(value: string, maxLen = 80): string {
  const ascii = value
    .normalize("NFKD")
    .replace(/[^\x00-\x7f]/g, "")
    .toLowerCase();
  const slug = ascii.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug.slice(0, maxLen).replace(/-+$/, "") || "item";
}

/** '04465-0K090' and '044650k090' both become '044650K090'. */
export function normalizePartNumber(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export function splitPartNumbers(value: string | null | undefined): string[] {
  const seen = new Map<string, string>();
  for (const raw of (value ?? "").split(/[,;\n]+/)) {
    const cleaned = raw.split(/\s+/).filter(Boolean).join(" ").trim();
    if (cleaned && normalizePartNumber(cleaned).length >= 3) {
      const key = normalizePartNumber(cleaned);
      if (!seen.has(key)) seen.set(key, cleaned.slice(0, 40));
    }
  }
  return [...seen.values()].slice(0, 20);
}

/** Python-compatible round-half-to-even for money math. */
export function roundHalfEven(x: number): number {
  const r = Math.round(x);
  if (Math.abs(x % 1) === 0.5 && r % 2 !== 0) return r - 1;
  return r;
}

/** GST portion inside a GST-inclusive amount, rounded to the nearest paisa. */
export function gstIncluded(amountPaise: number, rateBps: number): number {
  if (rateBps <= 0) return 0;
  return roundHalfEven((amountPaise * rateBps) / (10_000 + rateBps));
}

export function bpsOf(amountPaise: number, bps: number): number {
  return roundHalfEven((amountPaise * bps) / 10_000);
}

// ---- validators -------------------------------------------------------------------------------

const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
const IFSC_RE = /^[A-Z]{4}0[A-Z0-9]{6}$/;
const PINCODE_RE = /^[1-9][0-9]{5}$/;
const PHONE_RE = /^[6-9][0-9]{9}$/;
const EMAIL_RE =
  /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9-]{1,63})+$/;
const GSTIN_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";

export function gstinChecksumOk(gstin: string): boolean {
  let total = 0;
  for (let i = 0; i < 14; i++) {
    const value = GSTIN_CHARS.indexOf(gstin[i]) * (i % 2 ? 2 : 1);
    total += Math.floor(value / 36) + (value % 36);
  }
  return GSTIN_CHARS[(36 - (total % 36)) % 36] === gstin[14];
}

export class ValueError extends Error {}

export function cleanText(v: string): string {
  // Collapse whitespace and strip control characters (keeps newlines out of single-line fields).
  return v
    .replace(/\p{C}/gu, "")
    .split(/\s+/)
    .filter(Boolean)
    .join(" ");
}

export function cleanMultiline(v: string): string {
  const kept = [...v.replace(/\r\n/g, "\n")].filter((ch) => ch === "\n" || ch === "\t" || !/\p{C}/u.test(ch)).join("");
  const lines = kept.split("\n").map((line) => line.split(/\s+/).filter(Boolean).join(" "));
  let out = lines.join("\n").trim();
  while (out.includes("\n\n\n")) out = out.replaceAll("\n\n\n", "\n\n");
  return out;
}

export const checks = {
  gstin(v: string): string {
    v = v.trim().toUpperCase();
    if (!GSTIN_RE.test(v) || !gstinChecksumOk(v)) throw new ValueError("Enter a valid 15-character GSTIN");
    return v;
  },
  pan(v: string): string {
    v = v.trim().toUpperCase();
    if (!PAN_RE.test(v)) throw new ValueError("Enter a valid 10-character PAN");
    return v;
  },
  ifsc(v: string): string {
    v = v.trim().toUpperCase();
    if (!IFSC_RE.test(v)) throw new ValueError("Enter a valid 11-character IFSC");
    return v;
  },
  pincode(v: string): string {
    v = v.trim();
    if (!PINCODE_RE.test(v)) throw new ValueError("Enter a valid 6-digit PIN code");
    return v;
  },
  phone(v: string): string {
    let digits = v.replace(/\D/g, "");
    if (digits.length === 12 && digits.startsWith("91")) digits = digits.slice(2);
    if (!PHONE_RE.test(digits)) throw new ValueError("Enter a valid 10-digit mobile number");
    return digits;
  },
  email(v: string): string {
    v = v.trim().toLowerCase();
    if (v.length > 254 || !EMAIL_RE.test(v)) throw new ValueError("Enter a valid email address");
    return v;
  },
  state(v: string): string {
    const found = INDIAN_STATES.find((s) => s.toLowerCase() === v.trim().toLowerCase());
    if (!found) throw new ValueError("Choose a state from the list");
    return found;
  },
};

// Pydantic-style messages so the frontend sees the same wording as before.
z.setErrorMap((issue, ctx) => {
  if (issue.code === z.ZodIssueCode.invalid_type) {
    if (issue.received === "undefined") return { message: "Field required" };
    if (issue.received === "null") return { message: "Field required" };
    if (issue.received === "nan") return { message: "Input should be a valid integer" };
    const names: Record<string, string> = {
      string: "a valid string",
      number: "a valid number",
      integer: "a valid integer",
      boolean: "a valid boolean",
      array: "a valid list",
      object: "a valid dictionary",
    };
    return { message: `Input should be ${names[issue.expected] ?? `a valid ${issue.expected}`}` };
  }
  if (issue.code === z.ZodIssueCode.too_small) {
    if (issue.type === "string") return { message: `String should have at least ${issue.minimum} characters` };
    if (issue.type === "array") return { message: `List should have at least ${issue.minimum} items` };
    if (issue.type === "number") {
      return { message: `Input should be greater than${issue.inclusive ? " or equal to" : ""} ${issue.minimum}` };
    }
  }
  if (issue.code === z.ZodIssueCode.too_big) {
    if (issue.type === "string") return { message: `String should have at most ${issue.maximum} characters` };
    if (issue.type === "array") return { message: `List should have at most ${issue.maximum} items` };
    if (issue.type === "number") {
      return { message: `Input should be less than${issue.inclusive ? " or equal to" : ""} ${issue.maximum}` };
    }
  }
  if (issue.code === z.ZodIssueCode.invalid_enum_value) {
    return { message: `Input should be ${issue.options.map((o) => `'${String(o)}'`).join(", ")}` };
  }
  if (issue.code === z.ZodIssueCode.invalid_literal) {
    return { message: `Input should be ${JSON.stringify(issue.expected)}` };
  }
  return { message: ctx.defaultError };
});

/** A string field run through a check that may throw ValueError. */
export function checked(fn: (v: string) => string) {
  return z.string().transform((v, ctx) => {
    try {
      return fn(v);
    } catch (err) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: (err as Error).message });
      return z.NEVER;
    }
  });
}

export const GSTIN = checked(checks.gstin);
export const PAN = checked(checks.pan);
export const IFSC = checked(checks.ifsc);
export const Pincode = checked(checks.pincode);
export const Phone = checked(checks.phone);
export const Email = z.string().max(254).pipe(checked(checks.email));
export const State = checked(checks.state);

export function Text(minLen = 1, maxLen = 200) {
  return checked((raw) => {
    const v = cleanText(raw);
    if (v.length < minLen) throw new ValueError(minLen === 1 ? "This field is required" : `Use at least ${minLen} characters`);
    if (v.length > maxLen) throw new ValueError(`Use at most ${maxLen} characters`);
    return v;
  });
}

export function LongText(minLen = 0, maxLen = 5000) {
  return checked((raw) => {
    const v = cleanMultiline(raw);
    if (v.length < minLen) throw new ValueError(`Use at least ${minLen} characters`);
    if (v.length > maxLen) throw new ValueError(`Use at most ${maxLen} characters`);
    return v;
  });
}

/** Strict integer (accepts numeric strings like pydantic's lax mode, e.g. query params). */
// Chainable (Int.min(1).max(100)). Non-numeric input coerces to NaN → "Input should be a valid integer".
export const Int = z.coerce.number({ invalid_type_error: "Input should be a valid integer" }).int("Input should be a valid integer");

/** Optional value that treats null as "not provided". */
export function optional<T extends z.ZodTypeAny>(schema: T) {
  return schema.nullish().transform((v) => (v === undefined ? null : v)) as unknown as z.ZodType<
    z.output<T> | null,
    z.ZodTypeDef,
    z.input<T> | null | undefined
  >;
}

/** Boolean that also accepts "true"/"false"/"1"/"0" strings (query params). */
export const QueryBool = z.preprocess((v) => {
  if (typeof v === "string") return ["1", "true", "yes", "on"].includes(v.toLowerCase());
  return v;
}, z.boolean());
