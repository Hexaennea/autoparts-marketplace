// Server-side sessions.
// The browser holds an opaque random token in an HttpOnly cookie; the database stores only
// its SHA-256 hash, so a database leak does not leak usable sessions. Each session carries
// its own CSRF token, which the SPA echoes in the X-CSRF-Token header on every write.

import { createHash, randomBytes } from "node:crypto";
import { type Db, HOUR, MINUTE, addMs, utcnow } from "../db.js";

export function hashToken(token: string): string {
  return createHash("sha256").update(token.replace(/[^\x00-\x7f]/g, ""), "ascii").digest("hex");
}

export function newCsrfToken(): string {
  return randomBytes(32).toString("base64url");
}

export interface SessionUser {
  sessionId: number;
  csrfToken: string;
  id: number;
  email: string;
  fullName: string;
  role: "buyer" | "seller" | "admin";
  status: string;
  sellerId: number | null;
  sellerStatus: string | null;
  isSuperAdmin: boolean;
  mustChangePassword: boolean;
}

export async function createSession(
  db: Db,
  userId: number,
  opts: { ttlHours: number; ip: string | null; userAgent: string | null },
): Promise<{ token: string; csrf: string }> {
  const token = randomBytes(32).toString("base64url");
  const csrf = newCsrfToken();
  const now = utcnow();
  await db.execute(
    `INSERT INTO sessions (token_hash, csrf_token, user_id, created_at, last_seen_at, expires_at, ip, user_agent)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [hashToken(token), csrf, userId, now, now, addMs(opts.ttlHours * HOUR, now), opts.ip, (opts.userAgent ?? "").slice(0, 300)],
  );
  return { token, csrf };
}

export async function loadSession(db: Db, token: string | undefined, idleHours: number): Promise<SessionUser | null> {
  if (!token || token.length > 200) return null;
  const row = await db.one(
    `SELECT s.id AS session_id, s.csrf_token, s.expires_at, s.last_seen_at,
            u.id, u.email, u.full_name, u.role, u.status, u.is_super_admin, u.must_change_password,
            se.id AS seller_id, se.kyc_status AS seller_status
     FROM sessions s
     JOIN users u ON u.id = s.user_id
     LEFT JOIN sellers se ON se.user_id = u.id
     WHERE s.token_hash = ?`,
    [hashToken(token)],
  );
  if (!row) return null;
  const now = Date.now();
  const expired = new Date(row.expires_at).getTime() <= now;
  const lastSeen = new Date(row.last_seen_at).getTime();
  const idle = lastSeen + idleHours * HOUR <= now;
  if (expired || idle || row.status !== "active") {
    await db.execute("DELETE FROM sessions WHERE id = ?", [row.session_id]);
    return null;
  }
  // Touch at most every 5 minutes to keep writes low.
  if (lastSeen + 5 * MINUTE <= now) {
    await db.execute("UPDATE sessions SET last_seen_at = ? WHERE id = ?", [utcnow(), row.session_id]);
  }
  return {
    sessionId: row.session_id,
    csrfToken: row.csrf_token,
    id: row.id,
    email: row.email,
    fullName: row.full_name,
    role: row.role,
    status: row.status,
    sellerId: row.seller_id,
    sellerStatus: row.seller_status,
    isSuperAdmin: Boolean(row.is_super_admin),
    mustChangePassword: Boolean(row.must_change_password),
  };
}

export async function destroySession(db: Db, sessionId: number): Promise<void> {
  await db.execute("DELETE FROM sessions WHERE id = ?", [sessionId]);
}

export async function destroyUserSessions(db: Db, userId: number, exceptSession?: number): Promise<void> {
  if (exceptSession === undefined) {
    await db.execute("DELETE FROM sessions WHERE user_id = ?", [userId]);
  } else {
    await db.execute("DELETE FROM sessions WHERE user_id = ? AND id <> ?", [userId, exceptSession]);
  }
}

export async function purgeExpired(db: Db): Promise<number> {
  return db.execute("DELETE FROM sessions WHERE expires_at <= ?", [utcnow()]);
}
