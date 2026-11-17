# ADR 0002 — SQLite for the pilot, PostgreSQL for scale

**Status:** accepted · 2026-11-10

**Decision.** Ship on SQLite (WAL, foreign keys, `BEGIN IMMEDIATE` for writes) with plain parameterised SQL and versioned migrations. Keep SQL portable except the FTS5 search index.

**Why.** Zero-ops for a 10–25 seller pilot, single-file backups, fast tests (each test copies a seeded template DB).

**Move to PostgreSQL when** write concurrency grows (many sellers updating stock), more than one app instance is needed, or search needs synonyms/fuzziness beyond FTS5.
