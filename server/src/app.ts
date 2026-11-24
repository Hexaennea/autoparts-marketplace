// Application factory. main.ts starts it for real; tests call createApp(settings).

import fs from "node:fs";
import path from "node:path";
import express from "express";
import { type Settings, isProduction, loadSettings } from "./config.js";
import { Database } from "./db.js";
import { type AppState, api, errorBody } from "./http.js";
import { cookies, requestContext, securityHeaders } from "./security/middleware.js";
import { RateLimiter } from "./security/ratelimit.js";
import { sweep } from "./jobs.js";
import { configureStorage, mediaOrigin } from "./services/storage.js";
import "./api/index.js"; // registers every route on `api`

export interface App {
  express: express.Express;
  state: AppState;
}

export async function createApp(settings: Settings = loadSettings(), database?: Database): Promise<App> {
  const db = database ?? new Database(settings.databaseUrl, settings.dbPoolMax, settings.dbSsl);
  await db.migrate();
  configureStorage(settings);
  fs.mkdirSync(settings.uploadDir, { recursive: true });
  const state: AppState = { settings, database: db, limiter: new RateLimiter(settings.rateLimitEnabled) };

  const app = express();
  app.disable("x-powered-by");
  app.set("etag", false);
  if (settings.trustProxy) app.set("trust proxy", true);
  app.use(requestContext(settings.env !== "test"));
  app.use(securityHeaders(isProduction(settings), mediaOrigin(settings)));
  app.use(cookies());

  app.get("/api/health", async (_req, res) => {
    await db.reader().scalar("SELECT 1");
    res.json({ status: "ok", app: settings.appName });
  });
  app.get("/api/config", (_req, res) => {
    res.json({
      data: {
        app_name: settings.appName,
        demo_mode: settings.demoMode,
        payments_test_mode: settings.paymentsTestMode,
      },
    });
  });

  // A scheduler (e.g. Google Cloud Scheduler) can call this with "Authorization: Bearer $CRON_SECRET"
  // when instances may scale to zero and the in-process janitor timer cannot be relied on.
  // Disabled when the secret is unset.
  app.get("/api/cron/janitor", async (req, res) => {
    const secret = process.env.CRON_SECRET;
    if (!secret || req.headers.authorization !== `Bearer ${secret}`) {
      res.status(404).json(errorBody("not_found", "This API endpoint doesn't exist."));
      return;
    }
    await sweep(db);
    res.json({ status: "ok" });
  });

  const router = express.Router({ caseSensitive: true, strict: true });
  api.mount(router, state);
  app.use(router);

  app.all("/api/{*rest}", (_req, res) => {
    res.status(404).json(errorBody("not_found", "This API endpoint doesn't exist."));
  });

  app.use(
    "/media",
    express.static(settings.uploadDir, {
      index: false,
      fallthrough: false,
      setHeaders: (res) => res.setHeader("cache-control", "public, max-age=86400"),
    }),
  );

  const dist = settings.frontendDist;
  if (fs.existsSync(path.join(dist, "assets"))) {
    app.use(
      "/assets",
      express.static(path.join(dist, "assets"), {
        index: false,
        fallthrough: false,
        setHeaders: (res) => res.setHeader("cache-control", "public, max-age=31536000, immutable"),
      }),
    );
  }

  // SPA: only real files from the dist root (favicon etc.); everything else is a client-side route.
  app.get("/{*path}", (req, res) => {
    const index = path.join(dist, "index.html");
    if (!fs.existsSync(index)) {
      res.status(503).type("text/plain").send("Frontend not built. Run `npm run build` in frontend/.");
      return;
    }
    const name = req.path.replace(/^\//, "");
    if (name && !name.includes("/")) {
      const candidate = path.resolve(dist, name);
      if (path.dirname(candidate) === path.resolve(dist) && fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        res.setHeader("cache-control", "public, max-age=3600");
        res.sendFile(candidate);
        return;
      }
    }
    res.setHeader("cache-control", "no-cache");
    res.sendFile(index);
  });

  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (err?.type === "entity.too.large" || err?.status === 413) {
      res.status(413).json(errorBody("payload_too_large", "Request is too large."));
      return;
    }
    if (err?.status === 404 || err?.statusCode === 404) {
      res.status(404).json(errorBody("not_found", "Not found."));
      return;
    }
    const rid = res.locals.requestId as string | undefined;
    console.error(`unhandled error rid=${rid}`, err);
    res.status(500).json(errorBody("internal_error", "Something went wrong on our side. Please try again.", undefined, rid));
  });

  return { express: app, state };
}
