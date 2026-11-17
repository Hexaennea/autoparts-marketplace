# ADR 0005 — Node.js + PostgreSQL backend

**Date.** 2026-11-17. **Supersedes** the backend parts of ADR 0001 (Python API) and ADR 0002 (SQLite first).

**Context.** The product owner chose React for the frontend and Node.js for the backend, and expects about 1 lakh users. The app will also ship as Android and iOS apps, and will add Razorpay Route payments and Shiprocket shipping, so it needs a database that handles concurrent writers and runs on managed hosting (Cloud SQL).

**Decision.** Rewrite the API in Node.js (Express 5, TypeScript, zod) on PostgreSQL 17, keeping the HTTP contract identical so the React app did not change.

- Same endpoint pipeline as before (origin → rate limit → session → CSRF → role → validation → handler in one transaction for writes).
- SQLite `BEGIN IMMEDIATE` serialisation replaced by conditional updates (`UPDATE ... WHERE stock >= ?`), row locks (`FOR UPDATE`) and a per-buyer advisory lock at checkout.
- FTS5 replaced by a `product_search` table with a weighted, generated `tsvector` (GIN) plus a trigram index on titles.
- Money stays integer paise (BIGINT, parsed to JS numbers); timestamps are TIMESTAMPTZ returned as ISO-8601 UTC.
- The 74-test suite was ported to `node:test`; each test runs on a fresh copy of a seeded template database.

**Consequences.** One language across frontend and backend. The app is stateless and scales horizontally, except the in-process rate limiter, which must move to Redis when more than one instance runs. Search ranking differs slightly from BM25; part-number matches still rank first.
