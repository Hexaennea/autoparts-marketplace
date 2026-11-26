// Push notifications to the mobile apps through Firebase Cloud Messaging (HTTP v1 API).
//
// The outbox worker claims due rows from push_outbox (FOR UPDATE SKIP LOCKED plus a short lease),
// sends each one, and records the outcome:
//   sent      delivered to Firebase
//   pending   temporary failure: retried after 1 minute, then 5 minutes
//   failed    gave up after MAX_ATTEMPTS, or the message itself was rejected
//   skipped   push is not configured on this server (FCM_SERVICE_ACCOUNT unset)
// A token Firebase reports as no longer registered (app uninstalled) deletes its device, which
// removes its queued rows too. Several server instances can run the worker at the same time.
//
// Configuration: FCM_SERVICE_ACCOUNT = the Firebase service-account key JSON (Firebase console ->
// Project settings -> Service accounts -> Generate new private key), stored as a secret; or, for local
// development, FCM_SERVICE_ACCOUNT_FILE = the path to that downloaded .json file.

import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Database, Db } from "../db.js";

export interface PushMessage {
  token: string;
  title: string;
  body: string;
  link: string | null;
  notificationId: number;
}

/** "ok", "invalid_token" (device gone for good), or a temporary/permanent error to record. */
export type PushResult = { ok: true } | { ok: false; invalidToken?: boolean; retry: boolean; error: string };

export interface PushSender {
  send(message: PushMessage): Promise<PushResult>;
}

export const MAX_ATTEMPTS = 3;
const BACKOFF_SECONDS = [60, 300]; // after attempt 1, after attempt 2
const BATCH = 200;
const CONCURRENCY = 20;

// ---- Firebase sender ----------------------------------------------------------------------------

interface ServiceAccount {
  project_id: string;
  client_email: string;
  private_key: string;
}

function readServiceAccount(): ServiceAccount | null {
  // On Cloud Run the JSON comes from Secret Manager; on a laptop it can be a path to the key file.
  const file = process.env.FCM_SERVICE_ACCOUNT_FILE?.trim();
  const raw = file ? readFileSync(file, "utf8") : process.env.FCM_SERVICE_ACCOUNT?.trim();
  if (!raw) return null;
  const parsed = JSON.parse(raw) as Partial<ServiceAccount>;
  if (!parsed.project_id || !parsed.client_email || !parsed.private_key) {
    throw new Error("FCM_SERVICE_ACCOUNT must be the Firebase service-account JSON key");
  }
  return parsed as ServiceAccount;
}

const b64url = (data: string | Buffer) => Buffer.from(data).toString("base64url");

export class FcmSender implements PushSender {
  private token: { value: string; expires: number } | null = null;

  constructor(private readonly account: ServiceAccount) {}

  /** OAuth access token from a self-signed JWT (no Google SDK needed); cached until near expiry. */
  private async accessToken(): Promise<string> {
    if (this.token && this.token.expires > Date.now() + 60_000) return this.token.value;
    const now = Math.floor(Date.now() / 1000);
    const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const claims = b64url(
      JSON.stringify({
        iss: this.account.client_email,
        scope: "https://www.googleapis.com/auth/firebase.messaging",
        aud: "https://oauth2.googleapis.com/token",
        iat: now,
        exp: now + 3600,
      }),
    );
    const signature = createSign("RSA-SHA256").update(`${header}.${claims}`).sign(this.account.private_key);
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: `${header}.${claims}.${b64url(signature)}`,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`Google token request failed (${res.status})`);
    const body = (await res.json()) as { access_token: string; expires_in: number };
    this.token = { value: body.access_token, expires: Date.now() + body.expires_in * 1000 };
    return body.access_token;
  }

  async send(m: PushMessage): Promise<PushResult> {
    let access: string;
    try {
      access = await this.accessToken();
    } catch (err) {
      return { ok: false, retry: true, error: (err as Error).message };
    }
    const data: Record<string, string> = { notification_id: String(m.notificationId) };
    if (m.link) data.link = m.link;
    let res: Response;
    try {
      res = await fetch(`https://fcm.googleapis.com/v1/projects/${this.account.project_id}/messages:send`, {
        method: "POST",
        headers: { authorization: `Bearer ${access}`, "content-type": "application/json" },
        body: JSON.stringify({
          message: {
            token: m.token,
            notification: { title: m.title, body: m.body },
            data,
            // Android app: the "orders" channel (sound, heads-up) created by the app (frontend lib/push.ts).
            android: { priority: "high", notification: { channel_id: "orders", sound: "default" } },
            apns: { payload: { aps: { sound: "default" } } },
            // Browsers: deliver promptly; the service worker opens data.link when clicked.
            webpush: { headers: { Urgency: "high" }, notification: { icon: "/favicon.svg" } },
          },
        }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      return { ok: false, retry: true, error: `network: ${(err as Error).message}` };
    }
    if (res.ok) return { ok: true };
    const text = (await res.text().catch(() => "")).slice(0, 300);
    if (res.status === 401) this.token = null;
    // UNREGISTERED (404) / invalid token: the app was removed or the token rotated.
    const invalidToken = res.status === 404 || /UNREGISTERED|registration-token-not-registered|INVALID_ARGUMENT.*token/i.test(text);
    const retry = !invalidToken && (res.status === 401 || res.status === 429 || res.status >= 500);
    return { ok: false, invalidToken, retry, error: `FCM ${res.status}: ${text}` };
  }
}

let defaultSender: PushSender | null | undefined;

/** The configured Firebase sender, or null when push is not set up on this server. */
export function configuredSender(): PushSender | null {
  if (defaultSender === undefined) {
    const account = readServiceAccount();
    defaultSender = account ? new FcmSender(account) : null;
  }
  return defaultSender;
}

// ---- outbox worker ----------------------------------------------------------------------------

/**
 * Send every due push (in batches until none are left). Returns how many rows were processed.
 * `sender` null means push is not configured: due rows are marked skipped so they don't pile up.
 */
export async function processPushOutbox(database: Database, sender: PushSender | null = configuredSender()): Promise<number> {
  let total = 0;
  for (;;) {
    const claimed = await claim(database.reader());
    if (!claimed.length) return total;
    total += claimed.length;
    if (sender === null) {
      await database.reader().execute(
        `UPDATE push_outbox SET status = 'skipped', locked_until = NULL, last_error = 'push not configured'
         WHERE id = ANY(?::bigint[])`,
        [claimed.map((r) => r.id)],
      );
      continue;
    }
    for (let i = 0; i < claimed.length; i += CONCURRENCY) {
      await Promise.all(claimed.slice(i, i + CONCURRENCY).map((row) => deliver(database.reader(), sender, row)));
    }
  }
}

interface Claimed {
  id: number;
  attempts: number;
  device_id: number;
  notification_id: number;
  token: string;
  title: string;
  body: string;
  link: string | null;
}

/** Lease a batch of due rows. SKIP LOCKED + locked_until keep instances from sharing a row. */
async function claim(db: Db): Promise<Claimed[]> {
  return db.all<Claimed>(
    `WITH due AS (
       SELECT id FROM push_outbox
       WHERE status = 'pending' AND next_attempt_at <= now() AND (locked_until IS NULL OR locked_until < now())
       ORDER BY next_attempt_at, id LIMIT ${BATCH}
       FOR UPDATE SKIP LOCKED)
     UPDATE push_outbox o SET locked_until = now() + interval '2 minutes', attempts = o.attempts + 1
     FROM due, push_devices d, notifications n
     WHERE o.id = due.id AND d.id = o.device_id AND n.id = o.notification_id
     RETURNING o.id, o.attempts, o.device_id, o.notification_id, d.token, n.title, n.body, n.link`,
  );
}

async function deliver(db: Db, sender: PushSender, row: Claimed): Promise<void> {
  let result: PushResult;
  try {
    result = await sender.send({ token: row.token, title: row.title, body: row.body, link: row.link, notificationId: row.notification_id });
  } catch (err) {
    result = { ok: false, retry: true, error: (err as Error).message };
  }
  if (result.ok) {
    await db.execute("UPDATE push_outbox SET status = 'sent', sent_at = now(), locked_until = NULL, last_error = NULL WHERE id = ?", [row.id]);
    return;
  }
  if (result.invalidToken) {
    // Cascades to this device's other queued rows.
    await db.execute("DELETE FROM push_devices WHERE id = ?", [row.device_id]);
    return;
  }
  const giveUp = !result.retry || row.attempts >= MAX_ATTEMPTS;
  const wait = BACKOFF_SECONDS[Math.min(row.attempts, BACKOFF_SECONDS.length) - 1] ?? 300;
  await db.execute(
    `UPDATE push_outbox SET status = ?, last_error = ?, locked_until = NULL,
         next_attempt_at = now() + make_interval(secs => ?::double precision) WHERE id = ?`,
    [giveUp ? "failed" : "pending", result.error.slice(0, 500), wait, row.id],
  );
}

/** Housekeeping for the janitor: old notifications, finished queue rows, long-silent devices. */
export async function purgeNotifications(db: Db): Promise<void> {
  await db.execute("DELETE FROM notifications WHERE created_at < now() - interval '90 days'");
  await db.execute("DELETE FROM push_outbox WHERE status <> 'pending' AND updated_at < now() - interval '7 days'");
  // Firebase treats tokens unused for 270 days as expired.
  await db.execute("DELETE FROM push_devices WHERE last_seen_at < now() - interval '270 days'");
}
