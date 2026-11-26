// Notifications (the bell) and push-device registration for the mobile apps.
//
// Every signed-in user (buyer, seller, admin) has one list; sellers get their order alerts here
// too. The unread count is a cheap indexed query, polled by the web app about once a minute.

import { z } from "zod";
import { api, pageMeta, paginate } from "../http.js";
import { notify } from "../services/notify.js";
import { Int } from "../util.js";

const MAX_DEVICES_PER_USER = 10;

const ListQuery = z.object({
  page: Int.pipe(z.number().gte(1).lte(1000)).default(1),
  per_page: Int.pipe(z.number().gte(1).lte(50)).default(20),
});

const notificationOut = (r: Record<string, any>) => ({
  id: r.id,
  kind: r.kind,
  title: r.title,
  body: r.body,
  link: r.link,
  read: r.read_at !== null,
  created_at: r.created_at,
});

api.route("GET", "/api/notifications", { auth: "user", query: ListQuery }, async (ctx) => {
  const user = ctx.requireUser();
  const { limit, offset } = paginate(ctx.query.page, ctx.query.per_page);
  const [rows, total, unread] = await Promise.all([
    ctx.db.all(
      "SELECT id, kind, title, body, link, read_at, created_at FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT ? OFFSET ?",
      [user.id, limit, offset],
    ),
    ctx.db.scalar("SELECT COUNT(*) FROM notifications WHERE user_id = ?", [user.id]),
    ctx.db.scalar("SELECT COUNT(*) FROM notifications WHERE user_id = ? AND read_at IS NULL", [user.id]),
  ]);
  return { items: rows.map(notificationOut), unread: Number(unread ?? 0), ...pageMeta(Number(total ?? 0), ctx.query.page, limit) };
});

api.route("GET", "/api/notifications/unread", { auth: "user" }, async (ctx) => {
  const count = await ctx.db.scalar("SELECT COUNT(*) FROM notifications WHERE user_id = ? AND read_at IS NULL", [
    ctx.requireUser().id,
  ]);
  return { count: Number(count ?? 0) };
});

const ReadIn = z.object({
  // Omit to mark everything read.
  ids: z.array(Int.pipe(z.number().gt(0))).max(100).optional(),
});

api.route("POST", "/api/notifications/read", { auth: "user", body: ReadIn, rate: "write" }, async (ctx) => {
  const user = ctx.requireUser();
  if (ctx.body.ids) {
    if (ctx.body.ids.length) {
      await ctx.db.execute(
        "UPDATE notifications SET read_at = now() WHERE user_id = ? AND read_at IS NULL AND id = ANY(?::bigint[])",
        [user.id, ctx.body.ids],
      );
    }
  } else {
    await ctx.db.execute("UPDATE notifications SET read_at = now() WHERE user_id = ? AND read_at IS NULL", [user.id]);
  }
  const unread = await ctx.db.scalar("SELECT COUNT(*) FROM notifications WHERE user_id = ? AND read_at IS NULL", [user.id]);
  return { unread: Number(unread ?? 0) };
});

// ---- push devices (called by the mobile apps) ---------------------------------------------------

const DeviceIn = z.object({
  token: z.string().trim().min(20).max(4096).regex(/^[A-Za-z0-9_:.\-]+$/, "Not a push token"),
  platform: z.enum(["android", "ios", "web"]),
});

/**
 * Register this phone for push. A token belongs to whoever signed in on the phone last, so a shared
 * phone never receives the previous user's alerts. Each user keeps their 10 most recent devices.
 */
api.route("POST", "/api/push/devices", { auth: "user", body: DeviceIn, rate: "write" }, async (ctx) => {
  const user = ctx.requireUser();
  await ctx.db.execute(
    `INSERT INTO push_devices (user_id, token, platform, last_seen_at) VALUES (?, ?, ?, now())
     ON CONFLICT (token) DO UPDATE SET user_id = EXCLUDED.user_id, platform = EXCLUDED.platform, last_seen_at = now()`,
    [user.id, ctx.body.token, ctx.body.platform],
  );
  await ctx.db.execute(
    `DELETE FROM push_devices WHERE user_id = ? AND id NOT IN (
       SELECT id FROM push_devices WHERE user_id = ? ORDER BY last_seen_at DESC, id DESC LIMIT ${MAX_DEVICES_PER_USER})`,
    [user.id, user.id],
  );
  return { registered: true };
});

const DeviceRemoveIn = z.object({ token: z.string().trim().min(1).max(4096) });

/** Stop pushes to this phone (the app calls this before signing out). */
api.route("POST", "/api/push/devices/remove", { auth: "user", body: DeviceRemoveIn, rate: "write" }, async (ctx) => {
  await ctx.db.execute("DELETE FROM push_devices WHERE user_id = ? AND token = ?", [ctx.requireUser().id, ctx.body.token]);
  return { removed: true };
});

/** "Send test notification": a bell entry plus a push to every device this user registered. */
api.route("POST", "/api/push/test", { auth: "user", rate: "write" }, async (ctx) => {
  const user = ctx.requireUser();
  const devices = Number(await ctx.db.scalar("SELECT COUNT(*) FROM push_devices WHERE user_id = ?", [user.id]));
  await notify(ctx.db, user.id, {
    kind: "test",
    title: "Test notification",
    body: "Push notifications are working on this device.",
    link: "/notifications",
  });
  return { devices };
});
