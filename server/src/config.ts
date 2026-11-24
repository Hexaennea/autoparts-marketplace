// Application settings, read once from the environment.
// Every setting has a safe development default except SECRET_KEY in production,
// which must be provided explicitly (the app refuses to start without it).

import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

export const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const REPO_ROOT = path.resolve(SERVER_ROOT, "..");

dotenv.config({ path: path.join(SERVER_ROOT, ".env"), quiet: true } as dotenv.DotenvConfigOptions);

export interface Settings {
  appName: string;
  env: "development" | "test" | "production";
  secretKey: string;
  databaseUrl: string;
  dbPoolMax: number;
  uploadDir: string;
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

export function loadSettings(overrides: Partial<Settings> = {}): Settings {
  const env = (process.env.PARTPILOT_ENV ?? "development") as Settings["env"];
  const secret = process.env.PARTPILOT_SECRET_KEY;
  if (env === "production" && !secret) throw new Error("PARTPILOT_SECRET_KEY must be set in production");
  if (env === "production" && secret && secret.length < 32) {
    throw new Error("PARTPILOT_SECRET_KEY must be at least 32 characters");
  }
  const settings: Settings = {
    appName: process.env.PARTPILOT_APP_NAME ?? "PartPilot",
    env,
    secretKey: secret ?? randomBytes(48).toString("base64url"),
    databaseUrl: process.env.DATABASE_URL ?? "postgres://partpilot:partpilot@localhost:5432/partpilot",
    dbPoolMax: int(process.env.PARTPILOT_DB_POOL_MAX, 20),
    uploadDir: process.env.PARTPILOT_UPLOAD_DIR ?? path.join(REPO_ROOT, "var", "uploads"),
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
