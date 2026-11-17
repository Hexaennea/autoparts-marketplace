# PartPilot — car parts marketplace

> Working name. Rename in one place: `PARTPILOT_APP_NAME`.

A multi-seller marketplace built only for **car spare parts**. Buyers pick their car once (make → model → year → variant) and every part says plainly whether it fits. Sellers list parts against exact vehicle variants. Admins verify sellers, review listings and settle payouts.

```
 Buyer storefront ─┐
 Seller portal ────┼──▶  one web app (React + TypeScript)  ──▶  /api  (Node.js · Express · TypeScript)  ──▶  PostgreSQL
 Admin portal ─────┘
```

---

## ✦ What's inside

| Area | Highlights |
|---|---|
| **Buyer** | Car selector + saved garage · fitment-aware search with a **FITS** stamp on every result · part-number search (OEM & cross-references, any formatting) · "swift brake pads" understands the car in the query · filters & facets · product page with compatibility table and part label · cart split by seller · checkout (COD + online) · order tracking per shipment · cancel / wrong-fit returns · verified reviews · wishlist |
| **Seller** | KYC onboarding (GSTIN checksum, PAN ↔ GSTIN match, IFSC) · dashboard · listing editor with **fitment picker** · photo upload · inline price/stock edits · CSV bulk import with row-level errors · pack → ship → deliver · packing slip with barcodes · earnings and payouts (commission + 1 % TCS shown per order) |
| **Admin** | Marketplace KPIs · seller verification · listing moderation (duplicate part-number check) · vehicle / category / brand master data · orders and shipment overrides · user suspension · payout settlement · runtime commission & shipping settings · full audit log |
| **Platform** | Server-side sessions + CSRF · role and ownership checks on every endpoint · rate limits & account lockout · strict CSP and security headers · stock reserved atomically (no overselling) · idempotent checkout · re-encoded image uploads · structured access logs with request IDs |

---

## ✦ Quick start

**Needs:** Node 22+, PostgreSQL 17 (`winget install -e --id PostgreSQL.PostgreSQL.17` on Windows).

1. Create a database and a login role for the app (once), e.g. role `partpilot` owning databases `partpilot` and `partpilot_test`. Give the role `CREATEDB` if you want to run the tests (they copy a template database per test).
2. Copy `server/.env.example` to `server/.env` and set `DATABASE_URL` / `TEST_DATABASE_URL`.

### Windows (one command)

Double-click **`start-windows.cmd`** in the project folder, or run `.\start-windows.ps1` in PowerShell.
It installs the Node packages, builds the UI, applies migrations, adds the demo data if the database is empty and opens http://localhost:8000.
Use `.\start-windows.ps1 -Reset` for a fresh demo database, or `-Port 8080` for another port.

### macOS / Linux

```bash
make install        # server + frontend (npm)
make seed           # demo database: 78 listings, 59 car variants, 4 sellers, 19 orders
make dev            # builds the UI and serves everything on http://localhost:8000
```

### Demo accounts

| Role | Email | Password |
|---|---|---|
| Shopper | `priya@partpilot.test` | `Demo@12345` |
| Seller (verified) | `lakshmi.autospares@partpilot.test` | `Demo@12345` |
| Seller (awaiting KYC) | `bengaluru.carcare@partpilot.test` | `Demo@12345` |
| Admin | `admin@partpilot.test` | `Admin@12345` |

The sign-in page has one-click buttons for these while `PARTPILOT_DEMO_MODE` is on.

> ⚠️ **All sellers, part numbers, prices, buyers, orders and reviews are synthetic demo data.** Vehicle makes/models/variants are representative of the Indian market. Replace before launch — see [`docs/LAUNCH-CHECKLIST.md`](docs/LAUNCH-CHECKLIST.md).

---

## ✦ Commands

| Command | Does |
|---|---|
| `make test-api` | 74 server tests (node:test, real PostgreSQL): auth, CSRF, RBAC/IDOR, search, checkout, concurrency, payments, fulfilment, payouts, uploads, CSV import |
| `make test-web` | Frontend unit tests (money formatting, barcode encoder) |
| `make e2e` | 9 browser journeys (buyer, seller, admin, mobile) on a freshly seeded server |
| `make lint` | TypeScript strict (server + frontend) |
| `make check` | Everything CI runs |
| `make docker` | Production image (non-root, health-checked) |

---

## ✦ Project layout

```
server/
  src/
    main.ts            entry point (HTTP server + background janitor)
    app.ts             app factory, static + SPA serving
    http.ts            endpoint wrapper: auth → CSRF → roles → rate limit → validation → transaction
    config.ts          settings from environment (server/.env)
    db.ts              PostgreSQL pool, migrations, transactions
    migrations/        versioned SQL
    security/          passwords (scrypt), sessions, rate limiter, headers middleware
    services/          catalog, search (tsvector + trigram), commerce (pricing, state machine, payments), listings, media, CSV
    api/               auth · account · catalog · cart · orders · seller · admin
    seed.ts            demo data (refuses to run in production)
    cli.ts             migrate · seed · create-admin · purge-sessions · expire-unpaid
  tests/               node:test suite
frontend/
  src/
    lib/               API client, router, data hooks, formatting, Code 128 barcode
    state/             session, my car, cart, toasts
    ui/                design-system components (core, commerce, vehicle selector, chart)
    layouts/           storefront + portal shells
    pages/store|seller|admin
    styles/            tokens.css → base → components → store / portal
  build.mjs            esbuild production build
e2e/                   Playwright journeys + screenshot script
docs/                  architecture, security, API reference, ADRs, launch checklist
```

---

## ✦ Documentation

- [Architecture](docs/ARCHITECTURE.md) — data model, request pipeline, search, order lifecycle
- [Security](docs/SECURITY.md) — threat model and every control in place
- [API reference](docs/API.md) — all 90 endpoints with auth and rate limits
- [Design system](DESIGN.md) — tokens, components and the "showroom" visual language
- [Decisions](docs/adr/) — why these choices were made
- [Launch checklist](docs/LAUNCH-CHECKLIST.md) — what to finish before real customers
