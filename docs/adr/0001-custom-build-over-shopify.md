# ADR 0001 — Custom platform instead of Shopify + marketplace app

**Status:** accepted · 2026-11-10

**Context.** The 6 Nov plan used Shopify with a multi-vendor app (Shipturtle) and fitment metafields. The owner now wants a full platform with its own seller and admin portals, and vehicle fitment as the core of search.

**Decision.** Build a custom web platform (React + TypeScript, Python API, SQLite → PostgreSQL).

**Consequences.**
- ✅ Fitment is first-class data (variant table + join), not app metafields; search can answer "does it fit?" exactly.
- ✅ Seller KYC, moderation, payouts, TCS and audit trail are ours to shape.
- ✅ No per-order app fees or theme limits.
- ⚠️ We own hosting, payments integration, compliance pages and on-call.
