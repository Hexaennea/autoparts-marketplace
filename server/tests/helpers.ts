// Test harness (port of backend/tests/conftest.py).
//
// A template database is migrated and seeded once per test run; every test gets a fresh copy
// via `CREATE DATABASE ... TEMPLATE`, which takes a fraction of a second.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { after } from "node:test";
import sharp from "sharp";
import request from "supertest";
import { createApp } from "../src/app.js";
import { type Settings, loadSettings } from "../src/config.js";
import { Database, type Db, type Row } from "../src/db.js";

const { CookieAccessInfo } = createRequire(import.meta.url)("cookiejar") as { CookieAccessInfo: { All: unknown } };

export const PASSWORD = "Demo@12345";
export const ADMIN: [string, string] = ["admin@partpilot.test", "Admin@12345"];
export const SELLER_A: [string, string] = ["lakshmi.autospares@partpilot.test", PASSWORD]; // approved
export const SELLER_B: [string, string] = ["sharma.motors@partpilot.test", PASSWORD]; // approved
export const SELLER_PENDING: [string, string] = ["bengaluru.carcare@partpilot.test", PASSWORD];
export const BUYER: [string, string] = ["priya@partpilot.test", PASSWORD];
export const BUYER_2: [string, string] = ["arjun@partpilot.test", PASSWORD];

const BASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? "";
if (!BASE_URL) throw new Error("Set TEST_DATABASE_URL (see server/.env)");
const TEMPLATE = "partpilot_template";
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "pp-tests-"));
const TEMPLATE_UPLOADS = path.join(ROOT, "template-uploads");

function urlFor(dbName: string): string {
  const u = new URL(BASE_URL);
  u.pathname = `/${dbName}`;
  return u.toString();
}

const admin = new Database(urlFor("postgres"));
let templateReady: Promise<void> | null = null;
let counter = 0;
const created: string[] = [];

async function buildTemplate(): Promise<void> {
  await admin.reader().query(`DROP DATABASE IF EXISTS ${TEMPLATE} WITH (FORCE)`);
  await admin.reader().query(`CREATE DATABASE ${TEMPLATE}`);
  const database = new Database(urlFor(TEMPLATE));
  try {
    await database.migrate();
    const settings = makeSettings({ databaseUrl: urlFor(TEMPLATE), uploadDir: TEMPLATE_UPLOADS });
    const { seedMaster, seedDemo } = await import("../src/seed.js");
    await database.writer(async (db) => {
      await seedMaster(db);
      await seedDemo(db, settings);
    });
  } finally {
    await database.close();
  }
}

export function makeSettings(overrides: Partial<Settings> = {}): Settings {
  return loadSettings({
    env: "test",
    publicBaseUrl: "http://testserver",
    rateLimitEnabled: false,
    frontendDist: path.join(ROOT, "dist"),
    ...overrides,
  });
}

export interface TestEnv {
  app: Awaited<ReturnType<typeof createApp>>;
  settings: Settings;
  database: Database;
  db: Db;
  client(credentials?: [string, string]): Promise<Client>;
  close(): Promise<void>;
}

/** A fresh app + database copied from the seeded template. */
export async function setup(overrides: Partial<Settings> = {}): Promise<TestEnv> {
  templateReady ??= buildTemplate();
  await templateReady;
  const name = `pp_test_${process.pid}_${++counter}`;
  await admin.reader().query(`CREATE DATABASE ${name} TEMPLATE ${TEMPLATE}`);
  created.push(name);
  const uploadDir = path.join(ROOT, name, "uploads");
  fs.cpSync(TEMPLATE_UPLOADS, uploadDir, { recursive: true });
  const settings = makeSettings({ databaseUrl: urlFor(name), uploadDir, ...overrides });
  const database = new Database(settings.databaseUrl);
  const app = await createApp(settings, database);
  return {
    app,
    settings,
    database,
    db: database.reader(),
    async client(credentials) {
      const c = await Client.create(app.express);
      if (credentials) await c.login(...credentials);
      return c;
    },
    async close() {
      await database.close();
      await admin.reader().query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    },
  };
}

after(async () => {
  for (const name of created) await admin.reader().query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`).catch(() => undefined);
  await admin.close();
  // Best effort: on Windows, image libraries can still hold a handle for a moment.
  try {
    fs.rmSync(ROOT, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    /* leave the temp folder for the OS to clean */
  }
});

/** Behaves like the SPA: bootstraps a CSRF token and sends it on writes; keeps cookies. */
export class Client {
  csrf = "";
  user: Row | null = null;
  readonly agent: ReturnType<typeof request.agent>;

  private constructor(readonly app: Parameters<typeof request.agent>[0]) {
    this.agent = request.agent(app).set("Host", "testserver");
  }

  static async create(app: Parameters<typeof request.agent>[0]): Promise<Client> {
    const c = new Client(app);
    const res = await c.get("/api/auth/session");
    c.csrf = res.body.data.csrf;
    return c;
  }

  get(url: string) {
    return this.agent.get(url).set("Host", "testserver");
  }
  post(url: string, json: unknown = {}, headers: Record<string, string> = {}) {
    return this.agent.post(url).set("Host", "testserver").set({ "X-CSRF-Token": this.csrf, ...headers }).send(json as object);
  }
  put(url: string, json: unknown = {}) {
    return this.agent.put(url).set("Host", "testserver").set("X-CSRF-Token", this.csrf).send(json as object);
  }
  patch(url: string, json: unknown = {}) {
    return this.agent.patch(url).set("Host", "testserver").set("X-CSRF-Token", this.csrf).send(json as object);
  }
  delete(url: string) {
    return this.agent.delete(url).set("Host", "testserver").set("X-CSRF-Token", this.csrf);
  }
  upload(url: string, data: Buffer, filename: string, contentType: string) {
    return this.agent
      .post(url)
      .set("Host", "testserver")
      .set("X-CSRF-Token", this.csrf)
      .attach("file", data, { filename, contentType });
  }

  /** Raw cookie value currently held by the agent. */
  cookie(name: string): string | undefined {
    // supertest stores cookies under the bound host (127.0.0.1), so match any domain.
    const jar = (this.agent as any).jar;
    const c = jar.getCookie(name, CookieAccessInfo.All);
    return c?.value;
  }

  async login(email: string, password: string): Promise<Client> {
    const res = await this.post("/api/auth/login", { email, password });
    if (res.status !== 200) throw new Error(`login failed ${res.status} ${res.text}`);
    this.csrf = res.body.data.csrf;
    this.user = res.body.data.user;
    return this;
  }
}

export async function pngBytes(
  size: [number, number] = [640, 480],
  color = "#3355aa",
  fmt: "png" | "jpeg" = "png",
  exif = false,
): Promise<Buffer> {
  let img = sharp({ create: { width: size[0], height: size[1], channels: 3, background: color } });
  if (fmt === "jpeg") {
    img = img.jpeg();
    if (exif) img = img.withExif({ IFD0: { Make: "SecretCam" } });
  } else {
    img = img.png();
  }
  return img.toBuffer();
}

export async function productFor(db: Db, sellerEmail: string, minStock = 3): Promise<Row> {
  const row = await db.one(
    `SELECT p.* FROM products p JOIN sellers s ON s.id = p.seller_id JOIN users u ON u.id = s.user_id
     WHERE u.email = ? AND p.status = 'active' AND p.stock >= ? ORDER BY p.id LIMIT 1`,
    [sellerEmail, minStock],
  );
  if (!row) throw new Error(`no product for ${sellerEmail}`);
  return row;
}

export async function addressId(client: Client): Promise<number> {
  const rows = (await client.get("/api/me/addresses")).body.data;
  if (rows.length) return Number(rows[0].id);
  const res = await client.post("/api/me/addresses", {
    full_name: "Test Buyer",
    phone: "9876543210",
    line1: "12 Test Street",
    city: "Chennai",
    state: "Tamil Nadu",
    pincode: "600001",
  });
  if (res.status !== 201) throw new Error(res.text);
  return Number(res.body.data.id);
}

export async function checkout(client: Client, method = "cod", key = "test-key-000000000001") {
  return client.post("/api/orders", { address_id: await addressId(client), payment_method: method, idempotency_key: key });
}
