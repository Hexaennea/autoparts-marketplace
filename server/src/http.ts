// Small, explicit HTTP layer on top of Express.
//
// Every API endpoint is declared with api.route(...) which wires, in order:
// request-size limits → origin check → rate limit → session lookup → CSRF → role checks →
// zod validation → handler (inside one DB transaction for writes) → JSON response with a
// uniform error envelope: {"data": ...} or {"error": {"code", "message", "fields"?, "request_id"?}}.

import { timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response, Router } from "express";
import express from "express";
import multer from "multer";
import type { z } from "zod";
import type { Database, Db } from "./db.js";
import { utcnow } from "./db.js";
import type { Settings } from "./config.js";
import type { RateLimiter } from "./security/ratelimit.js";
import { type SessionUser, loadSession } from "./security/sessions.js";
import { kickOutboxIfDirty } from "./services/notify.js";

export type Auth = "public" | "user" | "buyer" | "seller" | "admin" | "super_admin";
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly opts: { fields?: Record<string, string>; commit?: boolean; headers?: Record<string, string> } = {},
  ) {
    super(message);
  }
  get fields() {
    return this.opts.fields ?? {};
  }
}

export const notFound = (what = "Resource") => new ApiError(404, "not_found", `${what} not found.`);
export const forbidden = (message = "You don't have access to this.") => new ApiError(403, "forbidden", message);
export const conflict = (message: string, code = "conflict") => new ApiError(409, code, message);
export const badRequest = (message: string, code = "bad_request", fields?: Record<string, string>) =>
  new ApiError(400, code, message, { fields });

export interface Upload {
  filename: string;
  contentType: string;
  data: Buffer;
}

/** Return this from a handler to send a non-JSON body (CSV downloads etc.). */
export class RawResponse {
  constructor(
    readonly body: string | Buffer,
    readonly contentType: string,
    readonly headers: Record<string, string> = {},
    readonly status = 200,
  ) {}
}

interface CookieSpec {
  key: string;
  value: string;
  maxAge: number | null;
  httpOnly: boolean;
}

export interface AppState {
  settings: Settings;
  database: Database;
  limiter: RateLimiter;
}

export class Ctx<B = any, Q = any> {
  cookies: CookieSpec[] = [];
  clearCookies: string[] = [];

  constructor(
    readonly req: Request,
    readonly db: Db,
    readonly app: AppState,
    readonly user: SessionUser | null,
    readonly path: Record<string, string>,
    readonly ip: string,
    readonly body: B,
    readonly query: Q,
    readonly upload: Upload | null,
    public status: number,
  ) {}

  get settings(): Settings {
    return this.app.settings;
  }

  requireUser(): SessionUser {
    if (!this.user) throw new ApiError(401, "unauthenticated", "Please sign in to continue.");
    return this.user;
  }

  sellerId(): number {
    const user = this.requireUser();
    if (user.sellerId === null) throw forbidden("This account is not registered as a seller.");
    return user.sellerId;
  }

  approvedSellerId(): number {
    const id = this.sellerId();
    if (this.user!.sellerStatus !== "approved") throw forbidden("Your seller account is awaiting approval.");
    return id;
  }

  setCookie(key: string, value: string, opts: { maxAge: number | null; httpOnly?: boolean }): void {
    this.cookies.push({ key, value, maxAge: opts.maxAge, httpOnly: opts.httpOnly ?? true });
  }

  header(name: string): string | undefined {
    const v = this.req.headers[name.toLowerCase()];
    return Array.isArray(v) ? v[0] : v;
  }

  cookie(name: string): string | undefined {
    return (this.req as any).parsedCookies?.[name];
  }

  async audit(action: string, entity: string, entityId: unknown = null, detail: Record<string, unknown> | null = null) {
    await this.db.execute(
      `INSERT INTO audit_log (actor_id, actor_role, action, entity, entity_id, detail, ip, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        this.user?.id ?? null,
        this.user?.role ?? null,
        action,
        entity,
        entityId === null || entityId === undefined ? null : String(entityId),
        detail ? JSON.stringify(detail) : null,
        this.ip,
        utcnow(),
      ],
    );
  }
}

export type Handler<B = any, Q = any> = (ctx: Ctx<B, Q>) => Promise<unknown> | unknown;

export interface RouteOptions<BS extends z.ZodTypeAny | undefined, QS extends z.ZodTypeAny | undefined> {
  auth?: Auth;
  body?: BS;
  query?: QS;
  rate?: string;
  upload?: "image" | "csv";
  status?: number;
}

type Out<S> = S extends z.ZodTypeAny ? z.output<S> : undefined;

interface Registered {
  method: string;
  path: string;
  expressPath: string;
  auth: Auth;
  rate?: string;
  body?: z.ZodTypeAny;
  query?: z.ZodTypeAny;
  upload?: "image" | "csv";
  status: number;
  handler: Handler;
}

export function errorBody(code: string, message: string, fields?: Record<string, string>, requestId?: string) {
  const error: Record<string, unknown> = { code, message };
  if (fields && Object.keys(fields).length) error.fields = fields;
  if (requestId) error.request_id = requestId;
  return { error };
}

function zodFields(error: z.ZodError): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const issue of error.issues) {
    const loc = issue.path.map(String).join(".") || "_";
    if (fields[loc] !== undefined) continue;
    const msg = issue.message;
    fields[loc] = msg.charAt(0).toUpperCase() + msg.slice(1);
  }
  return fields;
}

const ALLOWED_UPLOADS: Record<"image" | "csv", { types: Set<string>; limit: (s: Settings) => number }> = {
  image: { types: new Set(["image/jpeg", "image/png", "image/webp"]), limit: (s) => s.maxUploadBytes },
  csv: {
    types: new Set(["text/csv", "application/vnd.ms-excel", "text/plain", "application/octet-stream"]),
    limit: (s) => s.maxCsvBytes,
  },
};

export class Api {
  readonly routes: Registered[] = [];

  route<BS extends z.ZodTypeAny | undefined = undefined, QS extends z.ZodTypeAny | undefined = undefined>(
    method: string,
    path: string,
    options: RouteOptions<BS, QS>,
    handler: Handler<Out<BS>, Out<QS>>,
  ): void {
    this.routes.push({
      method: method.toUpperCase(),
      path,
      expressPath: path.replace(/\{(\w+)(?::\w+)?\}/g, ":$1"),
      auth: options.auth ?? "public",
      rate: options.rate,
      body: options.body,
      query: options.query,
      upload: options.upload,
      status: options.status ?? 200,
      handler: handler as Handler,
    });
  }

  mount(router: Router, state: AppState): void {
    // Specific paths must win over parameterised ones registered earlier
    // (e.g. /seller/products/{id}/inventory vs /seller/products/{id}/{action}).
    const sorted = [...this.routes].sort((a, b) => specificity(b.path) - specificity(a.path));
    for (const route of sorted) {
      const middlewares: express.RequestHandler[] = [];
      if (route.upload) {
        const kind = ALLOWED_UPLOADS[route.upload];
        const limit = kind.limit(state.settings);
        middlewares.push(uploadMiddleware(limit));
      } else if (route.body) {
        middlewares.push(express.raw({ type: () => true, limit: state.settings.maxJsonBytes }));
      }
      const fn = (req: Request, res: Response) => this.dispatch(req, res, route, state);
      (router as any)[route.method.toLowerCase()](route.expressPath, ...middlewares, fn);
    }
  }

  private async dispatch(req: Request, res: Response, route: Registered, state: AppState): Promise<void> {
    const { settings, database, limiter } = state;
    const requestId = res.locals.requestId as string | undefined;
    const ip = clientIp(req, settings);
    try {
      const method = route.method;
      if (!SAFE_METHODS.has(method)) checkOrigin(req, settings);

      let upload: Upload | null = null;
      if (route.upload) upload = readUpload(req, settings, route.upload);

      if (route.rate) {
        const retry = limiter.hit(route.rate, ip);
        if (retry !== null) {
          throw new ApiError(429, "rate_limited", "Too many requests. Please wait a moment and try again.", {
            headers: { "Retry-After": String(retry) },
          });
        }
      }

      const cookies = (req as any).parsedCookies as Record<string, string>;
      const sessionToken = cookies[settings.sessionCookie];
      const csrfHeader = String(req.headers["x-csrf-token"] ?? "");
      const csrfCookie = cookies[settings.csrfCookie] ?? "";

      const validate = (): { body: unknown; query: unknown } => {
        let body: unknown;
        let query: unknown;
        if (route.body) {
          let payload: unknown = {};
          const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
          if (raw.length) {
            try {
              payload = JSON.parse(raw.toString("utf8"));
            } catch {
              throw badRequest("Request body must be valid JSON.", "invalid_json");
            }
          }
          const parsed = route.body.safeParse(payload);
          if (!parsed.success) {
            throw new ApiError(422, "validation_error", "Please check the highlighted fields.", {
              fields: zodFields(parsed.error),
            });
          }
          body = parsed.data;
        }
        if (route.query) {
          const parsed = route.query.safeParse(flatQuery(req.query));
          if (!parsed.success) {
            throw new ApiError(422, "validation_error", "Please check the highlighted fields.", {
              fields: zodFields(parsed.error),
            });
          }
          query = parsed.data;
        }
        return { body, query };
      };

      let ctxRef: Ctx | null = null;
      const execute = async (db: Db) => {
        const user = await loadSession(db, sessionToken, settings.sessionIdleHours);
        if (!SAFE_METHODS.has(method)) checkCsrf(user, csrfHeader, csrfCookie);
        authorize(user, route.auth);
        // Read by the stamp_audit trigger to fill created_by / updated_by (0002_audit_columns.sql).
        // Transaction-local, so it never leaks to the next request on this pooled connection.
        if (user && !SAFE_METHODS.has(method)) {
          await db.query("SELECT set_config('app.user_id', ?, true)", [String(user.id)]);
        }
        const { body, query } = validate();
        const ctx = new Ctx(req, db, state, user, req.params as Record<string, string>, ip, body, query, upload, route.status);
        ctxRef = ctx;
        return route.handler(ctx);
      };

      let result: unknown;
      if (SAFE_METHODS.has(method)) {
        result = await execute(database.reader());
      } else {
        // Errors flagged `commit` (e.g. failed-login counters) commit the transaction, then fail.
        let deferred: ApiError | null = null;
        result = await database.writer(async (db) => {
          try {
            return await execute(db);
          } catch (err) {
            if (err instanceof ApiError && err.opts.commit) {
              deferred = err;
              return null;
            }
            throw err;
          }
        });
        kickOutboxIfDirty(); // committed: queued pushes can go out now
        if (deferred) throw deferred;
      }

      const ctx = ctxRef as Ctx | null;
      if (ctx) {
        for (const c of ctx.cookies) {
          res.cookie(c.key, c.value, {
            maxAge: c.maxAge === null ? undefined : c.maxAge * 1000,
            httpOnly: c.httpOnly,
            secure: settings.cookieSecure,
            sameSite: "lax",
            path: "/",
          });
        }
        for (const key of ctx.clearCookies) {
          res.clearCookie(key, { path: "/", secure: settings.cookieSecure, sameSite: "lax" });
        }
      }
      if (result instanceof RawResponse) {
        res.status(result.status).set(result.headers).type(result.contentType).send(result.body);
        return;
      }
      res.status(ctx?.status ?? route.status).json({ data: result ?? null });
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.opts.headers) res.set(err.opts.headers);
        res.status(err.status).json(errorBody(err.code, err.message, err.fields, requestId));
        return;
      }
      console.error(`unhandled error rid=${requestId}`, err);
      res
        .status(500)
        .json(errorBody("internal_error", "Something went wrong on our side. Please try again.", undefined, requestId));
    }
  }
}

function specificity(path: string): number {
  // More literal segments first; among equals, longer paths first.
  const segments = path.split("/").filter(Boolean);
  const literal = segments.filter((s) => !s.startsWith("{")).length;
  return literal * 100 + segments.length;
}

function flatQuery(q: Request["query"]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(q)) {
    if (Array.isArray(v)) out[k] = String(v[v.length - 1]);
    else if (v !== undefined) out[k] = String(v);
  }
  return out;
}

function uploadMiddleware(limit: number): express.RequestHandler {
  const handler = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: limit, files: 1, fields: 4 },
  }).single("file");
  return (req: Request, res: Response, next: NextFunction) => {
    const declared = Number(req.headers["content-length"] ?? 0);
    if (declared > limit + 64 * 1024) {
      res
        .status(413)
        .json(errorBody("payload_too_large", `File is too large (max ${Math.floor(limit / (1024 * 1024))} MB).`));
      return;
    }
    if (!String(req.headers["content-type"] ?? "").startsWith("multipart/form-data")) {
      (req as any).uploadError = badRequest("Upload must be multipart/form-data.", "invalid_upload");
      next();
      return;
    }
    handler(req, res, (err?: unknown) => {
      if (err) {
        const code = (err as { code?: string }).code;
        (req as any).uploadError =
          code === "LIMIT_FILE_SIZE"
            ? new ApiError(413, "payload_too_large", `File is too large (max ${Math.floor(limit / (1024 * 1024))} MB).`)
            : badRequest("Attach a file in the 'file' field.", "invalid_upload");
      }
      next();
    });
  };
}

function readUpload(req: Request, _settings: Settings, kind: "image" | "csv"): Upload {
  if ((req as any).uploadError) throw (req as any).uploadError as ApiError;
  const file = (req as any).file as Express.Multer.File | undefined;
  if (!file) throw badRequest("Attach a file in the 'file' field.", "invalid_upload");
  if (!file.buffer.length) throw badRequest("The file is empty.", "invalid_upload");
  const contentType = (file.mimetype || "application/octet-stream").split(";")[0].trim().toLowerCase();
  if (!ALLOWED_UPLOADS[kind].types.has(contentType)) throw new ApiError(415, "unsupported_type", "This file type isn't supported.");
  return { filename: (file.originalname || "upload").slice(0, 200), contentType, data: file.buffer };
}

export function clientIp(req: Request, settings: Settings): string {
  if (settings.trustProxy) {
    const forwarded = req.headers["x-forwarded-for"];
    const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(",")[0].trim();
    if (first) return first.slice(0, 64);
  }
  return req.socket.remoteAddress ?? "unknown";
}

/** Reject cross-site writes outright (defence in depth on top of CSRF tokens + SameSite). */
export function checkOrigin(req: Request, settings: Settings): void {
  if (req.headers["sec-fetch-site"] === "cross-site") throw forbidden("Cross-site requests are not allowed.");
  const origin = req.headers.origin;
  if (origin && origin !== "null") {
    let originHost = "";
    try {
      originHost = new URL(origin).host;
    } catch {
      throw forbidden("Cross-site requests are not allowed.");
    }
    const allowed = new Set([new URL(settings.publicBaseUrl).host, req.headers.host ?? ""]);
    if (!allowed.has(originHost)) throw forbidden("Cross-site requests are not allowed.");
  }
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export function checkCsrf(user: SessionUser | null, header: string, cookie: string): void {
  const fail = () => new ApiError(403, "csrf_failed", "Your session expired. Refresh the page and try again.");
  if (!header || !cookie || !safeEqual(header, cookie)) throw fail();
  if (user && !safeEqual(header, user.csrfToken)) throw fail();
}

export function authorize(user: SessionUser | null, auth: Auth): void {
  if (auth === "public") return;
  if (!user) throw new ApiError(401, "unauthenticated", "Please sign in to continue.");
  if (auth === "user") return;
  if (auth === "buyer" && user.role !== "buyer" && user.role !== "seller") {
    throw forbidden("This action is for shopper accounts.");
  }
  if (auth === "seller" && user.role !== "seller") throw forbidden("This area is for sellers.");
  if ((auth === "admin" || auth === "super_admin") && user.role !== "admin") throw forbidden("This area is for administrators.");
  if (auth === "admin" || auth === "super_admin") {
    // Someone else chose this password (new admin, or a reset): the admin area stays shut until the
    // admin sets their own with POST /api/auth/password.
    if (user.mustChangePassword) {
      throw new ApiError(403, "password_change_required", "Set a new password before using the admin area.");
    }
    if (auth === "super_admin" && !user.isSuperAdmin) throw forbidden("Only a super admin can manage admin accounts.");
  }
}

// ---- helpers shared by handlers -------------------------------------------------------------

export function pathInt(ctx: Ctx, name: string): number {
  const value = ctx.path[name];
  if (value === undefined || !/^-?\d+$/.test(value)) throw notFound();
  return Number(value);
}

export function paginate(page: number, perPage: number): { limit: number; offset: number } {
  page = Math.max(1, page);
  perPage = Math.min(Math.max(1, perPage), 100);
  return { limit: perPage, offset: (page - 1) * perPage };
}

export function pageMeta(total: number, page: number, perPage: number) {
  return { total, page, per_page: perPage, pages: Math.max(1, Math.ceil(total / perPage)) };
}

export const api = new Api();
