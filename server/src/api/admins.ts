// Admin accounts, managed by super admins (Admin portal -> Admins).
//
// Rules:
// * Only a super admin may list, create, block, reset or promote admins.
// * A new admin, or one whose password was reset, must choose their own password before using the
//   admin area (must_change_password; see authorize() in http.ts).
// * Nobody changes their own admin account here (use Account -> password), and the marketplace
//   always keeps at least one active super admin.
// * Blocking or resetting signs the admin out everywhere. Every change goes to the audit log.

import { z } from "zod";
import { type Ctx, ApiError, api, forbidden, notFound, pathInt } from "../http.js";
import { hashPassword, passwordProblems } from "../security/passwords.js";
import { destroyUserSessions } from "../security/sessions.js";
import { Email, Phone, Text, optional } from "../util.js";

const adminOut = (r: Record<string, any>) => ({
  id: r.id,
  email: r.email,
  full_name: r.full_name,
  phone: r.phone,
  status: r.status,
  is_super_admin: Boolean(r.is_super_admin),
  must_change_password: Boolean(r.must_change_password),
  created_at: r.created_at,
  created_by: r.created_by_email ?? null,
  last_seen: r.last_seen,
});

const ADMIN_SELECT = `SELECT u.id, u.email, u.full_name, u.phone, u.status, u.is_super_admin, u.must_change_password,
       u.created_at, c.email AS created_by_email,
       (SELECT MAX(last_seen_at) FROM sessions s WHERE s.user_id = u.id) AS last_seen
  FROM users u LEFT JOIN users c ON c.id = u.created_by
  WHERE u.role = 'admin'`;

api.route("GET", "/api/admin/admins", { auth: "super_admin" }, async (ctx) => {
  const rows = await ctx.db.all(`${ADMIN_SELECT} ORDER BY u.is_super_admin DESC, u.status, u.full_name`);
  return { items: rows.map(adminOut) };
});

function checkPassword(password: string, email: string, name: string, field = "password") {
  const problems = passwordProblems(password, { email, name });
  if (problems.length) throw new ApiError(422, "weak_password", problems[0]!, { fields: { [field]: problems.join(" ") } });
}

const CreateIn = z.object({
  full_name: Text(2, 80),
  email: Email,
  phone: optional(Phone),
  password: z.string().max(256),
  super_admin: z.boolean().default(false),
});

api.route("POST", "/api/admin/admins", { auth: "super_admin", body: CreateIn, rate: "write", status: 201 }, async (ctx) => {
  const b = ctx.body;
  if (await ctx.db.scalar("SELECT 1 FROM users WHERE email = ?", [b.email])) {
    throw new ApiError(409, "email_taken", "An account with this email already exists.", {
      fields: { email: "This email already has an account. Use a different email for the admin login." },
    });
  }
  checkPassword(b.password, b.email, b.full_name);
  const id = await ctx.db.insert(
    `INSERT INTO users (email, password_hash, full_name, phone, role, is_super_admin, must_change_password, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'admin', ?, true, now(), now())`,
    [b.email, await hashPassword(b.password), b.full_name, b.phone, b.super_admin],
  );
  await ctx.audit("admin.created", "user", id, { email: b.email, super_admin: b.super_admin });
  return adminOut((await ctx.db.one(`${ADMIN_SELECT} AND u.id = ?`, [id]))!);
});

/**
 * Load the target admin with the super-admin rows locked, so two super admins acting at once can
 * never leave the marketplace without one. Refuses self-service and non-admin targets.
 */
async function lockedTarget(ctx: Ctx) {
  const me = ctx.requireUser();
  const targetId = pathInt(ctx, "user_id");
  if (targetId === me.id) throw forbidden("You can't change your own admin account here.");
  const supers = await ctx.db.all(
    "SELECT id FROM users WHERE role = 'admin' AND is_super_admin AND status = 'active' ORDER BY id FOR UPDATE",
  );
  // Someone may have blocked or demoted the acting super admin a moment ago.
  if (!supers.some((r) => r.id === me.id)) throw forbidden("Only a super admin can manage admin accounts.");
  const target = await ctx.db.one("SELECT id, email, full_name, role, status, is_super_admin FROM users WHERE id = ? FOR UPDATE", [targetId]);
  if (!target || target.role !== "admin") throw notFound("Admin");
  const otherActiveSupers = supers.filter((r) => r.id !== target.id).length;
  return { target, otherActiveSupers };
}

const LAST_SUPER = "The marketplace must keep at least one active super admin.";

const StatusIn = z.object({ status: z.enum(["active", "suspended"]) });

api.route("POST", "/api/admin/admins/{user_id:int}/status", { auth: "super_admin", body: StatusIn, rate: "write" }, async (ctx) => {
  const { target, otherActiveSupers } = await lockedTarget(ctx);
  const status = ctx.body.status;
  if (status === "suspended" && target.is_super_admin && otherActiveSupers === 0) {
    throw new ApiError(409, "last_super_admin", LAST_SUPER);
  }
  await ctx.db.execute("UPDATE users SET status = ?, updated_at = now() WHERE id = ?", [status, target.id]);
  if (status === "suspended") await destroyUserSessions(ctx.db, target.id);
  await ctx.audit(status === "suspended" ? "admin.blocked" : "admin.unblocked", "user", target.id);
  return adminOut((await ctx.db.one(`${ADMIN_SELECT} AND u.id = ?`, [target.id]))!);
});

const RoleIn = z.object({ super_admin: z.boolean() });

api.route("POST", "/api/admin/admins/{user_id:int}/role", { auth: "super_admin", body: RoleIn, rate: "write" }, async (ctx) => {
  const { target, otherActiveSupers } = await lockedTarget(ctx);
  const superAdmin = ctx.body.super_admin;
  if (!superAdmin && target.is_super_admin && target.status === "active" && otherActiveSupers === 0) {
    throw new ApiError(409, "last_super_admin", LAST_SUPER);
  }
  await ctx.db.execute("UPDATE users SET is_super_admin = ?, updated_at = now() WHERE id = ?", [superAdmin, target.id]);
  await ctx.audit(superAdmin ? "admin.made_super_admin" : "admin.made_admin", "user", target.id);
  return adminOut((await ctx.db.one(`${ADMIN_SELECT} AND u.id = ?`, [target.id]))!);
});

const ResetIn = z.object({ password: z.string().max(256) });

api.route("POST", "/api/admin/admins/{user_id:int}/password", { auth: "super_admin", body: ResetIn, rate: "write" }, async (ctx) => {
  const { target } = await lockedTarget(ctx);
  checkPassword(ctx.body.password, target.email, target.full_name);
  await ctx.db.execute("UPDATE users SET password_hash = ?, must_change_password = true, updated_at = now() WHERE id = ?", [
    await hashPassword(ctx.body.password),
    target.id,
  ]);
  await destroyUserSessions(ctx.db, target.id);
  await ctx.audit("admin.password_reset", "user", target.id);
  return adminOut((await ctx.db.one(`${ADMIN_SELECT} AND u.id = ?`, [target.id]))!);
});
