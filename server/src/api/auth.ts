// Authentication: session bootstrap, register, login, logout, password change.

import { z } from "zod";
import { type Db, MINUTE, addMs, utcnow } from "../db.js";
import { ApiError, type Ctx, api, badRequest } from "../http.js";
import { dummyHash, hashPassword, needsRehash, passwordProblems, verifyPassword } from "../security/passwords.js";
import { createSession, destroySession, destroyUserSessions, newCsrfToken } from "../security/sessions.js";
import { Email, Phone, Text, optional } from "../util.js";

const RegisterIn = z.object({
  full_name: Text(2, 80),
  email: Email,
  password: z.string().max(256),
  phone: optional(Phone),
});

const LoginIn = z.object({
  email: z.string().max(254),
  password: z.string().max(256),
});

const PasswordIn = z.object({
  current_password: z.string().max(256),
  new_password: z.string().max(256),
});

export async function userPayload(db: Db, userId: number) {
  const row = await db.one(
    `SELECT u.id, u.email, u.full_name, u.phone, u.role, u.created_at,
            s.id AS seller_id, s.kyc_status, s.display_name, s.kyc_note
     FROM users u LEFT JOIN sellers s ON s.user_id = u.id WHERE u.id = ?`,
    [userId],
  );
  if (!row) throw new Error(`user ${userId} missing`);
  const seller =
    row.seller_id === null
      ? null
      : { id: row.seller_id, status: row.kyc_status, display_name: row.display_name, note: row.kyc_note };
  return {
    id: row.id,
    email: row.email,
    full_name: row.full_name,
    phone: row.phone,
    role: row.role,
    created_at: row.created_at,
    seller,
  };
}

export async function startSession(ctx: Ctx, userId: number): Promise<string> {
  const { token, csrf } = await createSession(ctx.db, userId, {
    ttlHours: ctx.settings.sessionTtlHours,
    ip: ctx.ip,
    userAgent: ctx.header("user-agent") ?? null,
  });
  const maxAge = ctx.settings.sessionTtlHours * 3600;
  ctx.setCookie(ctx.settings.sessionCookie, token, { maxAge, httpOnly: true });
  ctx.setCookie(ctx.settings.csrfCookie, csrf, { maxAge, httpOnly: false });
  return csrf;
}

api.route("GET", "/api/auth/session", {}, async (ctx) => {
  const maxAge = ctx.settings.sessionTtlHours * 3600;
  if (ctx.user) {
    ctx.setCookie(ctx.settings.csrfCookie, ctx.user.csrfToken, { maxAge, httpOnly: false });
    return { user: await userPayload(ctx.db, ctx.user.id), csrf: ctx.user.csrfToken };
  }
  let csrf = ctx.cookie(ctx.settings.csrfCookie) ?? "";
  if (csrf.length < 32 || csrf.length > 100) csrf = newCsrfToken();
  ctx.setCookie(ctx.settings.csrfCookie, csrf, { maxAge, httpOnly: false });
  if (ctx.cookie(ctx.settings.sessionCookie)) ctx.clearCookies.push(ctx.settings.sessionCookie);
  return { user: null, csrf };
});

api.route("POST", "/api/auth/register", { body: RegisterIn, rate: "register", status: 201 }, async (ctx) => {
  const body = ctx.body;
  const problems = passwordProblems(body.password, { email: body.email, name: body.full_name });
  if (problems.length) {
    throw new ApiError(422, "weak_password", problems[0], { fields: { password: problems.join(" ") } });
  }
  if (await ctx.db.scalar("SELECT 1 FROM users WHERE email = ?", [body.email])) {
    throw new ApiError(409, "email_taken", "An account with this email already exists. Try signing in.", {
      fields: { email: "An account with this email already exists." },
    });
  }
  const now = utcnow();
  const userId = await ctx.db.insert(
    `INSERT INTO users (email, password_hash, full_name, phone, role, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'buyer', ?, ?)`,
    [body.email, await hashPassword(body.password), body.full_name, body.phone, now, now],
  );
  if (ctx.user) await destroySession(ctx.db, ctx.user.sessionId);
  const csrf = await startSession(ctx, userId);
  return { user: await userPayload(ctx.db, userId), csrf };
});

api.route("POST", "/api/auth/login", { body: LoginIn, rate: "login" }, async (ctx) => {
  const email = ctx.body.email.trim().toLowerCase();
  const password = ctx.body.password;
  const invalid = new ApiError(401, "invalid_credentials", "That email and password don't match.", { commit: true });
  if (ctx.settings.rateLimitEnabled && ctx.app.limiter.hit("login", `email:${email}`) !== null) {
    throw new ApiError(429, "rate_limited", "Too many sign-in attempts. Please wait a minute.");
  }
  const row = await ctx.db.one(
    "SELECT id, password_hash, status, failed_logins, locked_until FROM users WHERE email = ?",
    [email],
  );
  if (!row) {
    await verifyPassword(password, await dummyHash()); // equalise timing
    throw invalid;
  }
  const now = Date.now();
  if (row.locked_until && new Date(row.locked_until).getTime() > now) {
    await verifyPassword(password, await dummyHash());
    throw new ApiError(
      423,
      "account_locked",
      "Too many failed attempts. Your account is locked for a few minutes — try again later.",
    );
  }
  if (!(await verifyPassword(password, row.password_hash))) {
    let failures = row.failed_logins + 1;
    let locked: string | null = null;
    if (failures >= ctx.settings.loginMaxFailures) {
      locked = addMs(ctx.settings.loginLockMinutes * MINUTE);
      failures = 0;
    }
    await ctx.db.execute("UPDATE users SET failed_logins = ?, locked_until = ? WHERE id = ?", [failures, locked, row.id]);
    throw invalid;
  }
  if (row.status !== "active") {
    throw new ApiError(403, "account_suspended", "This account is suspended. Contact support for help.");
  }
  if (needsRehash(row.password_hash)) {
    await ctx.db.execute(
      "UPDATE users SET failed_logins = 0, locked_until = NULL, updated_at = ?, password_hash = ? WHERE id = ?",
      [utcnow(), await hashPassword(password), row.id],
    );
  } else {
    await ctx.db.execute("UPDATE users SET failed_logins = 0, locked_until = NULL, updated_at = ? WHERE id = ?", [
      utcnow(),
      row.id,
    ]);
  }
  // Rotate: never reuse a pre-login session (prevents session fixation).
  if (ctx.user) await destroySession(ctx.db, ctx.user.sessionId);
  const csrf = await startSession(ctx, row.id);
  return { user: await userPayload(ctx.db, row.id), csrf };
});

api.route("POST", "/api/auth/logout", { auth: "user" }, async (ctx) => {
  const user = ctx.requireUser();
  await destroySession(ctx.db, user.sessionId);
  ctx.clearCookies.push(ctx.settings.sessionCookie);
  const csrf = newCsrfToken();
  ctx.setCookie(ctx.settings.csrfCookie, csrf, { maxAge: ctx.settings.sessionTtlHours * 3600, httpOnly: false });
  return { user: null, csrf };
});

api.route("POST", "/api/auth/password", { auth: "user", body: PasswordIn, rate: "password" }, async (ctx) => {
  const user = ctx.requireUser();
  const body = ctx.body;
  const current = await ctx.db.scalar<string>("SELECT password_hash FROM users WHERE id = ?", [user.id]);
  if (!current || !(await verifyPassword(body.current_password, current))) {
    throw new ApiError(400, "invalid_password", "Your current password is incorrect.", {
      fields: { current_password: "Incorrect password." },
    });
  }
  if (body.current_password === body.new_password) {
    throw badRequest("Choose a password you haven't used here.", "bad_request", { new_password: "Must be different." });
  }
  const problems = passwordProblems(body.new_password, { email: user.email, name: user.fullName });
  if (problems.length) {
    throw new ApiError(422, "weak_password", problems[0], { fields: { new_password: problems.join(" ") } });
  }
  await ctx.db.execute("UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?", [
    await hashPassword(body.new_password),
    utcnow(),
    user.id,
  ]);
  await destroyUserSessions(ctx.db, user.id, user.sessionId);
  await ctx.audit("user.password_changed", "user", user.id);
  return { ok: true };
});
