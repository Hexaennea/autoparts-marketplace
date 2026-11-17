// Port of backend/tests/test_auth.py
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import request from "supertest";
import { hashPassword, needsRehash, passwordProblems, verifyPassword } from "../src/security/passwords.js";
import { ADMIN, BUYER, type Client, type TestEnv, setup } from "./helpers.js";

const { CookieAccessInfo } = createRequire(import.meta.url)("cookiejar");

/** Cookie value held by the client's agent (any domain; supertest stores them under 127.0.0.1). */
function jarCookie(client: Client, name: string): string | undefined {
  return (client.agent as any).jar.getCookie(name, CookieAccessInfo.All)?.value;
}

function register(client: Client, email = "new.user@example.com", password = "Sturdy#Pass2026") {
  return client.post("/api/auth/register", { full_name: "New User", email, password });
}

function setCookies(res: { headers: Record<string, any> }): string[] {
  const raw = res.headers["set-cookie"];
  return raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
}

async function withEnv(fn: (env: TestEnv) => Promise<void>, overrides = {}) {
  const env = await setup(overrides);
  try {
    await fn(env);
  } finally {
    await env.close();
  }
}

test("register creates session with secure cookies", () =>
  withEnv(async (env) => {
    const anon = await env.client();
    const res = await register(anon);
    assert.equal(res.status, 201, res.text);
    const body = res.body.data;
    assert.equal(body.user.email, "new.user@example.com");
    assert.equal(body.user.role, "buyer");
    const cookies = setCookies(res);
    const sessionCookie = cookies.find((c) => c.startsWith("pp_session="));
    assert.ok(sessionCookie);
    assert.ok(
      sessionCookie.includes("HttpOnly") &&
        sessionCookie.toLowerCase().includes("samesite=lax") &&
        sessionCookie.includes("Path=/"),
    );
    const csrfCookie = cookies.find((c) => c.startsWith("pp_csrf="));
    assert.ok(csrfCookie);
    assert.ok(!csrfCookie.includes("HttpOnly"));
    anon.csrf = body.csrf;
    const me = (await anon.get("/api/auth/session")).body.data;
    assert.equal(me.user.email, "new.user@example.com");
  }));

test("register rejects weak and duplicate", () =>
  withEnv(async (env) => {
    const anon = await env.client();
    const weak = await register(anon, undefined, "password");
    assert.equal(weak.status, 422);
    assert.equal(weak.body.error.code, "weak_password");
    assert.equal((await register(anon)).status, 201);
    const other = await env.client();
    const dup = await register(other, "NEW.USER@example.com");
    assert.equal(dup.status, 409);
    assert.ok(dup.body.error.fields.email);
  }));

test("register validates fields", () =>
  withEnv(async (env) => {
    const anon = await env.client();
    const res = await anon.post("/api/auth/register", { full_name: "A", email: "not-an-email", password: "x" });
    assert.equal(res.status, 422);
    const fields = res.body.error.fields;
    assert.ok("email" in fields && "full_name" in fields);
  }));

test("login logout and session rotation", () =>
  withEnv(async (env) => {
    const anon = await env.client();
    const before = jarCookie(anon, "pp_session");
    await anon.login(...BUYER);
    const token = jarCookie(anon, "pp_session");
    assert.ok(token && token !== before);
    assert.equal((await anon.get("/api/auth/session")).body.data.user.email, BUYER[0]);
    const out = await anon.post("/api/auth/logout");
    assert.equal(out.status, 200);
    anon.csrf = out.body.data.csrf;
    assert.equal((await anon.get("/api/auth/session")).body.data.user, null);
    // The old token must be dead even if replayed.
    const replay = await request(env.app.express)
      .get("/api/orders")
      .set("Host", "testserver")
      .set("Cookie", `pp_session=${token}`);
    assert.equal(replay.status, 401);
  }));

test("wrong password then lockout", () =>
  withEnv(async (env) => {
    const anon = await env.client();
    for (let i = 0; i < 4; i++) {
      const res = await anon.post("/api/auth/login", { email: BUYER[0], password: "Wrong#Password1" });
      assert.equal(res.status, 401);
      assert.equal(res.body.error.message, "That email and password don't match.");
    }
    const res = await anon.post("/api/auth/login", { email: BUYER[0], password: "Wrong#Password1" });
    assert.equal(res.status, 401);
    const locked = await anon.post("/api/auth/login", { email: BUYER[0], password: BUYER[1] });
    assert.equal(locked.status, 423);
  }));

test("unknown email gets same error", () =>
  withEnv(async (env) => {
    const anon = await env.client();
    const res = await anon.post("/api/auth/login", { email: "ghost@example.com", password: "Whatever#123" });
    assert.equal(res.status, 401);
    assert.equal(res.body.error.code, "invalid_credentials");
  }));

test("csrf required on writes", () =>
  withEnv(async (env) => {
    const buyer = await env.client(BUYER);
    const noHeader = await buyer.agent.post("/api/me/addresses").set("Host", "testserver").send({});
    assert.ok(noHeader.status === 403 && noHeader.body.error.code === "csrf_failed");
    const wrong = await buyer.agent
      .post("/api/me/addresses")
      .set("Host", "testserver")
      .set("X-CSRF-Token", "forged-token-value-123456789012345")
      .send({});
    assert.equal(wrong.status, 403);
  }));

test("cross site writes rejected", () =>
  withEnv(async (env) => {
    const buyer = await env.client(BUYER);
    let res = await buyer.post("/api/auth/logout", {}, { Origin: "https://evil.example" });
    assert.equal(res.status, 403);
    res = await buyer.post("/api/auth/logout", {}, { "Sec-Fetch-Site": "cross-site" });
    assert.equal(res.status, 403);
  }));

test("password change revokes other sessions", () =>
  withEnv(async (env) => {
    const first = await env.client(BUYER);
    const second = await env.client(BUYER);
    const res = await first.post("/api/auth/password", { current_password: BUYER[1], new_password: "Brand#New2026pass" });
    assert.equal(res.status, 200, res.text);
    assert.equal((await first.get("/api/orders")).status, 200);
    assert.equal((await second.get("/api/orders")).status, 401);
    const wrong = await first.post("/api/auth/password", { current_password: "nope", new_password: "Another#Pass2026" });
    assert.equal(wrong.status, 400);
  }));

test("suspended user is signed out and blocked", () =>
  withEnv(async (env) => {
    const admin = await env.client(ADMIN);
    const buyer = await env.client(BUYER);
    const userId = buyer.user!.id;
    assert.equal((await admin.post(`/api/admin/users/${userId}/status`, { status: "suspended" })).status, 200);
    assert.equal((await buyer.get("/api/orders")).status, 401);
    const fresh = await env.client();
    const res = await fresh.post("/api/auth/login", { email: BUYER[0], password: BUYER[1] });
    assert.equal(res.status, 403);
  }));

test("login rate limit", () =>
  withEnv(
    async (env) => {
      const client = await env.client();
      const codes: number[] = [];
      for (let i = 0; i < 12; i++) {
        codes.push((await client.post("/api/auth/login", { email: `user${i}@example.com`, password: "x" })).status);
      }
      assert.ok(codes.includes(429));
      const limited = await client.post("/api/auth/login", { email: "a@example.com", password: "x" });
      assert.ok(limited.status === 429 && "retry-after" in limited.headers);
    },
    { rateLimitEnabled: true },
  ));

test("password hashing primitives", async () => {
  const encoded = await hashPassword("Correct#Horse9");
  assert.ok(encoded.startsWith("scrypt$"));
  assert.ok(await verifyPassword("Correct#Horse9", encoded));
  assert.ok(!(await verifyPassword("correct#horse9", encoded)));
  assert.ok(!(await verifyPassword("x", "garbage")));
  assert.ok(!needsRehash(encoded));
  assert.ok(needsRehash("scrypt$1024$8$1$aa$bb"));
  assert.ok(passwordProblems("Short1!").length > 0);
  assert.ok(passwordProblems("priya.sharma2026!", { email: "priya.sharma@example.com" }).length > 0);
  assert.equal(passwordProblems("Sturdy#Pass2026").length, 0);
});
