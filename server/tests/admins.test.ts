// Super admins manage admin accounts; new admins must set their own password first.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ADMIN, BUYER, type TestEnv, setup } from "./helpers.js";

async function withEnv(fn: (env: TestEnv) => Promise<void>) {
  const env = await setup();
  try {
    await fn(env);
  } finally {
    await env.close();
  }
}

const TEMP = "Temp#Pass2026x";
const OWN = "MyOwn#Pass2026y";

async function createAdmin(env: TestEnv, email: string, superAdmin = false) {
  const owner = await env.client(ADMIN);
  const res = await owner.post("/api/admin/admins", { full_name: "Team Admin", email, password: TEMP, super_admin: superAdmin });
  assert.equal(res.status, 201, res.text);
  return res.body.data;
}

/** Sign in as a freshly created admin and pick their own password. Returns the signed-in client. */
async function activate(env: TestEnv, email: string) {
  const c = await env.client([email, TEMP]);
  const res = await c.post("/api/auth/password", { current_password: TEMP, new_password: OWN });
  assert.equal(res.status, 200, res.text);
  return env.client([email, OWN]);
}

test("the seeded owner is a super admin; the session says so", () =>
  withEnv(async (env) => {
    const owner = await env.client(ADMIN);
    const me = (await owner.get("/api/auth/session")).body.data.user;
    assert.equal(me.is_super_admin, true);
    assert.equal(me.must_change_password, false);
    const list = (await owner.get("/api/admin/admins")).body.data.items;
    assert.equal(list.length, 1);
    assert.equal(list[0].email, ADMIN[0]);
  }));

test("super admin creates an admin who must change the password before using the admin area", () =>
  withEnv(async (env) => {
    const created = await createAdmin(env, "ops1@partpilot.test");
    assert.equal(created.is_super_admin, false);
    assert.equal(created.must_change_password, true);
    assert.equal(created.created_by, ADMIN[0]);

    const fresh = await env.client(["ops1@partpilot.test", TEMP]);
    assert.equal((await fresh.get("/api/auth/session")).body.data.user.must_change_password, true);
    const blocked = await fresh.get("/api/admin/dashboard");
    assert.equal(blocked.status, 403);
    assert.equal(blocked.body.error.code, "password_change_required");

    const admin = await activate(env, "ops1@partpilot.test");
    assert.equal((await admin.get("/api/admin/dashboard")).status, 200);
    // An ordinary admin cannot manage admins.
    assert.equal((await admin.get("/api/admin/admins")).status, 403);
    assert.equal((await admin.post("/api/admin/admins", { full_name: "X Y", email: "x@partpilot.test", password: TEMP })).status, 403);

    const audit = await env.db.scalar("SELECT COUNT(*) FROM audit_log WHERE action = 'admin.created'");
    assert.equal(audit, 1);
  }));

test("create validates email, duplicates and weak passwords; buyers are refused", () =>
  withEnv(async (env) => {
    const owner = await env.client(ADMIN);
    const dup = await owner.post("/api/admin/admins", { full_name: "Dup Admin", email: BUYER[0], password: TEMP });
    assert.equal(dup.status, 409);
    assert.ok(dup.body.error.fields.email);
    const weak = await owner.post("/api/admin/admins", { full_name: "Weak Admin", email: "weak@partpilot.test", password: "12345678" });
    assert.equal(weak.status, 422);
    const bad = await owner.post("/api/admin/admins", { full_name: "Bad Admin", email: "not-an-email", password: TEMP });
    assert.equal(bad.status, 422);

    const buyer = await env.client(BUYER);
    assert.equal((await buyer.get("/api/admin/admins")).status, 403);
    assert.equal((await (await env.client()).get("/api/admin/admins")).status, 401);
  }));

test("blocking signs the admin out; unblocking lets them back", () =>
  withEnv(async (env) => {
    const { id } = await createAdmin(env, "ops2@partpilot.test");
    const admin = await activate(env, "ops2@partpilot.test");
    const owner = await env.client(ADMIN);

    assert.equal((await owner.post(`/api/admin/admins/${id}/status`, { status: "suspended" })).status, 200);
    assert.equal((await admin.get("/api/admin/dashboard")).status, 401, "signed out everywhere");
    assert.equal((await admin.post("/api/auth/login", { email: "ops2@partpilot.test", password: OWN })).status, 403);

    assert.equal((await owner.post(`/api/admin/admins/${id}/status`, { status: "active" })).status, 200);
    assert.equal((await env.client(["ops2@partpilot.test", OWN])).user?.role, "admin");
  }));

test("password reset forces a new password and signs the admin out", () =>
  withEnv(async (env) => {
    const { id } = await createAdmin(env, "ops3@partpilot.test");
    const admin = await activate(env, "ops3@partpilot.test");
    const owner = await env.client(ADMIN);
    const res = await owner.post(`/api/admin/admins/${id}/password`, { password: "Reset#Pass2026z" });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.body.data.must_change_password, true);
    assert.equal((await admin.get("/api/admin/dashboard")).status, 401);
    const again = await env.client(["ops3@partpilot.test", "Reset#Pass2026z"]);
    assert.equal((await again.get("/api/admin/dashboard")).body.error.code, "password_change_required");
  }));

test("there is always one active super admin, and nobody changes their own account here", () =>
  withEnv(async (env) => {
    const owner = await env.client(ADMIN);
    const ownerId = Number(owner.user!.id);
    assert.equal((await owner.post(`/api/admin/admins/${ownerId}/status`, { status: "suspended" })).status, 403);
    assert.equal((await owner.post(`/api/admin/admins/${ownerId}/role`, { super_admin: false })).status, 403);

    // A second super admin can be made, and can then demote or block the first one...
    const second = await createAdmin(env, "boss2@partpilot.test", true);
    assert.equal(second.is_super_admin, true);
    const boss2 = await activate(env, "boss2@partpilot.test");
    assert.equal((await boss2.get("/api/admin/admins")).status, 200);
    assert.equal((await boss2.post(`/api/admin/admins/${ownerId}/role`, { super_admin: false })).status, 200);

    // ...but the demoted owner can no longer manage admins, and boss2 is now the last super admin.
    assert.equal((await owner.get("/api/admin/admins")).status, 403);
    const boss2Id = Number(second.id);
    const demoteLast = await env.db.scalar("SELECT COUNT(*) FROM users WHERE is_super_admin AND status = 'active'");
    assert.equal(demoteLast, 1);
    assert.equal((await boss2.post(`/api/admin/admins/${ownerId}/role`, { super_admin: true })).status, 200);
    assert.equal((await owner.post(`/api/admin/admins/${boss2Id}/status`, { status: "suspended" })).status, 200);
    assert.equal(await env.db.scalar("SELECT COUNT(*) FROM users WHERE is_super_admin AND status = 'active'"), 1);

    // Only admins can be managed here.
    const buyerId = Number(await env.db.scalar("SELECT id FROM users WHERE email = ?", [BUYER[0]]));
    assert.equal((await owner.post(`/api/admin/admins/${buyerId}/status`, { status: "suspended" })).status, 404);
  }));

test("the users page still refuses to change admin accounts", () =>
  withEnv(async (env) => {
    const { id } = await createAdmin(env, "ops4@partpilot.test");
    const owner = await env.client(ADMIN);
    const res = await owner.post(`/api/admin/users/${id}/status`, { status: "suspended" });
    assert.equal(res.status, 403);
  }));
