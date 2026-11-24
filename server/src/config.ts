// Application settings, read once from the environment.
// Every setting has a safe development default except SECRET_KEY in production,
// which must be provided explicitly (the app refuses to start without it).

import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import type { DbSsl } from "./db.js";
import type { MediaSettings } from "./services/storage.js";

export const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const REPO_ROOT = path.resolve(SERVER_ROOT, "..");

dotenv.config({ path: path.join(SERVER_ROOT, ".env"), quiet: true } as dotenv.DotenvConfigOptions);

export interface Settings {
  appName: string;
  env: "development" | "test" | "production";
  secretKey: string;
  databaseUrl: string;
  dbPoolMax: number;
  dbSsl: DbSsl;
  uploadDir: string;
  media: MediaSettings;
  frontendDist: string;
  publicBaseUrl: string;
  port: number;

  sessionCookie: string;
  csrfCookie: string;
  sessionTtlHours: number;
  sessionIdleHours: number;
  cookieSecure: boolean;

  loginMaxFailures: number;
  loginLockMinutes: number;
  rateLimitEnabled: boolean;
  trustProxy: boolean;

  maxJsonBytes: number;
  maxUploadBytes: number;
  maxCsvBytes: number;

  defaultCommissionBps: number;
  tcsBps: number;
  shippingFeePaise: number;
  freeShippingThresholdPaise: number;
  returnWindowDays: number;

  demoMode: boolean;
  paymentsTestMode: boolean;
}

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function int(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const n = Number.parseInt(value, 10);
  if (Number.isNaN(n)) throw new Error(`Expected an integer, got "${value}"`);
  return n;
}

/** TLS for the database: PARTPILOT_DB_SSL wins; otherwise "verify" when a CA file is given,
 *  "require" for Supabase hosts, "off" for everything else (local PostgreSQL). */
function dbSslFromEnv(databaseUrl: string): DbSsl {
  const caSetting = process.env.PARTPILOT_DB_SSL_CA?.trim();
  const caFile = caSetting ? path.resolve(SERVER_ROOT, caSetting) : undefined;
  const explicit = process.env.PARTPILOT_DB_SSL?.trim().toLowerCase();
  if (explicit) {
    if (explicit !== "off" && explicit !== "require" && explicit !== "verify") {
      throw new Error(`PARTPILOT_DB_SSL must be off, require or verify (got "${explicit}")`);
    }
    return { mode: explicit, caFile };
  }
  if (caFile) return { mode: "verify", caFile };
  let host = "";
  try {
    host = new URL(databaseUrl).hostname;
  } catch {
    // Not a URL (e.g. a bare connection string); leave TLS off.
  }
  return { mode: /\.supabase\.(co|com)$/i.test(host) ? "require" : "off" };
}

/** The `role` claim of a legacy Supabase JWT key ("anon" / "service_role"), or null. */
function jwtRole(key: string): string | null {
  const payload = key.split(".")[1];
  if (!key.startsWith("eyJ") || !payload) return null;
  try {
    return (JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { role?: string }).role ?? null;
  } catch {
    return null;
  }
}

/** Supabase Storage when SUPABASE_URL and SUPABASE_SECRET_KEY are both set, else local disk. */
function mediaFromEnv(): MediaSettings {
  const url = process.env.SUPABASE_URL?.trim().replace(/\/+$/, "");
  // SUPABASE_SERVICE_ROLE_KEY is the name Supabase's own docs use; accept either, and if both are
  // set use the one that is actually a server key.
  const keyVars = ["SUPABASE_SECRET_KEY", "SUPABASE_SERVICE_ROLE_KEY"]
    .map((name) => ({ name, value: process.env[name]?.trim() ?? "" }))
    .filter((k) => k.value);
  const isPublicKey = (k: string) => k.startsWith("sb_publishable_") || jwtRole(k) === "anon";
  const serverKey = keyVars.find((k) => !isPublicKey(k.value));
  if (url && keyVars.length && !serverKey) {
    throw new Error(
      keyVars
        .map((k) => `${k.name} holds the public ${k.value.startsWith("sb_publishable_") ? "publishable key (sb_publishable_...)" : "anon key"}.`)
        .join(" ") +
        " " +
        "Use the secret key (sb_secret_...) or the service_role key from Project Settings -> API Keys.",
    );
  }
  const secretKey = serverKey?.value;
  if (!url && !secretKey) return { kind: "local" };
  if (!url || !secretKey) {
    throw new Error("Set both SUPABASE_URL and SUPABASE_SECRET_KEY / SUPABASE_SERVICE_ROLE_KEY (or neither)");
  }
  if (!/^https:\/\/[^/]+$/.test(url)) {
    throw new Error("SUPABASE_URL must look like https://abcdefgh.supabase.co (Project Settings -> API)");
  }
  return { kind: "supabase", url, secretKey, bucket: process.env.PARTPILOT_MEDIA_BUCKET?.trim() || "media" };
}

export function loadSettings(overrides: Partial<Settings> = {}): Settings {
  const env = (process.env.PARTPILOT_ENV ?? "development") as Settings["env"];
  const secret = process.env.PARTPILOT_SECRET_KEY;
  if (env === "production" && !secret) throw new Error("PARTPILOT_SECRET_KEY must be set in production");
  if (env === "production" && secret && secret.length < 32) {
    throw new Error("PARTPILOT_SECRET_KEY must be at least 32 characters");
  }
  const databaseUrl = process.env.DATABASE_URL ?? "postgres://partpilot:partpilot@localhost:5432/partpilot";
  const settings: Settings = {
    appName: process.env.PARTPILOT_APP_NAME ?? "PartPilot",
    env,
    secretKey: secret ?? randomBytes(48).toString("base64url"),
    databaseUrl,
    dbPoolMax: int(process.env.PARTPILOT_DB_POOL_MAX, 20),
    dbSsl: dbSslFromEnv(databaseUrl),
    uploadDir: process.env.PARTPILOT_UPLOAD_DIR ?? path.join(REPO_ROOT, "var", "uploads"),
    media: mediaFromEnv(),
    frontendDist: process.env.PARTPILOT_FRONTEND_DIST ?? path.join(REPO_ROOT, "frontend", "dist"),
    publicBaseUrl: process.env.PARTPILOT_PUBLIC_URL ?? "http://localhost:8000",
    port: int(process.env.PORT, 8000),

    sessionCookie: "pp_session",
    csrfCookie: "pp_csrf",
    sessionTtlHours: 24 * 7,
    sessionIdleHours: 24 * 2,
    cookieSecure: bool(process.env.PARTPILOT_COOKIE_SECURE, env === "production"),

    loginMaxFailures: 5,
    loginLockMinutes: 15,
    rateLimitEnabled: bool(process.env.PARTPILOT_RATE_LIMIT, true),
    trustProxy: bool(process.env.PARTPILOT_TRUST_PROXY, false),

    maxJsonBytes: 256 * 1024,
    maxUploadBytes: int(process.env.PARTPILOT_MAX_UPLOAD_MB, 5) * 1024 * 1024,
    maxCsvBytes: 1024 * 1024,

    defaultCommissionBps: int(process.env.PARTPILOT_COMMISSION_BPS, 800),
    tcsBps: 100,
    shippingFeePaise: 7900,
    freeShippingThresholdPaise: 99900,
    returnWindowDays: 7,

    demoMode: bool(process.env.PARTPILOT_DEMO_MODE, env !== "production"),
    paymentsTestMode: bool(process.env.PARTPILOT_PAYMENTS_TEST_MODE, env !== "production"),
  };
  return { ...settings, ...overrides };
}

export const isProduction = (s: Settings) => s.env === "production";
export const isTest = (s: Settings) => s.env === "test";
