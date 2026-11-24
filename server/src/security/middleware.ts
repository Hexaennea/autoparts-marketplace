// Express middleware: request IDs + access log, security headers, cookie parsing.

import { randomBytes } from "node:crypto";
import { parse as parseCookie } from "cookie";
import type { NextFunction, Request, Response } from "express";

function contentSecurityPolicy(imageOrigin: string | null): string {
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    `img-src 'self' data: blob:${imageOrigin ? ` ${imageOrigin}` : ""}`,
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "upgrade-insecure-requests",
  ].join("; ");
}

/** `imageOrigin`: where product photos are served from when it isn't this app (e.g. Supabase Storage). */
export function securityHeaders(hsts: boolean, imageOrigin: string | null = null) {
  const CSP = contentSecurityPolicy(imageOrigin);
  return (req: Request, res: Response, next: NextFunction) => {
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("x-frame-options", "DENY");
    res.setHeader("referrer-policy", "strict-origin-when-cross-origin");
    res.setHeader("permissions-policy", "camera=(), microphone=(), geolocation=(), payment=(self)");
    res.setHeader("cross-origin-opener-policy", "same-origin");
    res.setHeader("cross-origin-resource-policy", "same-origin");
    res.setHeader("content-security-policy", CSP);
    if (hsts) res.setHeader("strict-transport-security", "max-age=63072000; includeSubDomains");
    if (req.path.startsWith("/api/")) res.setHeader("cache-control", "no-store");
    next();
  };
}

/** Assigns a request ID (echoed as X-Request-ID) and writes one access-log line per request. */
export function requestContext(log: boolean) {
  return (req: Request, res: Response, next: NextFunction) => {
    const requestId = randomBytes(8).toString("hex");
    res.locals.requestId = requestId;
    res.setHeader("x-request-id", requestId);
    const started = performance.now();
    if (log) {
      res.on("finish", () => {
        const ms = (performance.now() - started).toFixed(1);
        console.log(`${new Date().toISOString()} INFO access ${req.method} ${req.path} ${res.statusCode} ${ms}ms rid=${requestId}`);
      });
    }
    next();
  };
}

export function cookies() {
  return (req: Request, _res: Response, next: NextFunction) => {
    (req as any).parsedCookies = req.headers.cookie ? parseCookie(req.headers.cookie) : {};
    next();
  };
}
