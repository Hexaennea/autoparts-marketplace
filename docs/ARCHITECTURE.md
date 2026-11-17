# Architecture

## 1 · Shape of the system

One deployable unit. The Node.js (Express, TypeScript) API serves `/api/*`, re-encoded product photos at `/media/*`, hashed web assets at `/assets/*`, and the single-page app for every other path. Same origin → no CORS, cookies stay `SameSite=Lax`, CSP stays `'self'`.

```
Browser ──HTTPS──▶ reverse proxy (TLS, gzip) ──▶ Node.js ─▶ Express
                                                         ├─ RequestContext (request id, access log)
                                                         ├─ SecurityHeaders (CSP, HSTS, nosniff…)
                                                         ├─ BodyLimit (hard byte cap)
                                                         └─ routes ─▶ api.route wrapper ─▶ handler (async) ─▶ PostgreSQL
```

## 2 · The endpoint pipeline (`server/src/http.ts`)

Every endpoint is an async function declared with `api.route(...)`. The wrapper runs, in order:

1. **Origin check** on writes (rejects `Sec-Fetch-Site: cross-site` and foreign `Origin`)
2. **Body read** with a size cap (JSON 256 KB, uploads 5 MB, CSV 1 MB)
3. **Rate limit** by IP for the route's bucket
4. With one DB connection (a dedicated transaction for writes):
   - **Session** lookup (hashed token, idle + absolute expiry)
   - **CSRF**: header must equal cookie *and* the session's token
   - **Role** check (`public · user · buyer · seller · admin`)
   - **Validation** (zod) — only after auth, so strangers learn nothing about payload shape
   - **Handler**, inside one PostgreSQL transaction for every write; any error rolls back (stock, money and status changes use conditional updates or row locks)
5. Uniform JSON: `{"data": …}` or `{"error": {code, message, fields?, request_id?}}`

Ownership (a seller's listing, a buyer's order) is enforced inside handlers with `WHERE … AND seller_id = ?` and returns **404**, never 403, so IDs can't be probed.

## 3 · Data model

```
makes ─< models ─< variants ─< product_fitments >─ products >─ sellers ── users
                                                   │  ├─< product_part_numbers   (normalised, for lookup)
categories (2 levels) ─────────────────────────────┤  ├─< product_specs
brands (OEM flag) ─────────────────────────────────┘  └─< media (re-encoded WebP)

users ─< orders ─< fulfilments (one per seller) ─< order_items      (price/title snapshots)
                      │            └─< fulfilment_events            (timeline)
                      └─ payout_id ─▶ payouts
orders ─< payments          users ─< sessions · addresses · garage_vehicles · cart_items · wishlist_items · reviews
audit_log · settings · product_search (tsvector + trigram indexes)
```

- **Money** is integer paise, GST-inclusive. Commission, TCS and per-line GST are snapshotted onto the order.
- **Variants** are the unit of fitment: one buyable configuration (trim + engine + fuel + gearbox) over a year range, with a stable `code` used in CSV imports.
- **Fulfilments** split a multi-seller order: each seller sees and ships only their part.

## 4 · Search (`services/search.py`)

| Signal | How |
|---|---|
| Words | PostgreSQL full-text (weighted tsvector) over title, brand, category, part numbers, description; prefix matching and light plural stemming; ts_rank_cd ranking with title, brand and part numbers weighted highest |
| Part numbers | normalised (`04465-0K090` = `044650k090`); exact match ranks first, then prefix |
| Car | chosen variant → only parts with that fitment (or universal); a model named in the query ("swift brake pads") → any variant of that model |
| Facets | brand and category counts computed without their own filter; parent categories facet into children |
| Fallback | if every word must match and nothing does, retry with any-word and say so |

## 5 · Order lifecycle (`services/commerce.py`)

```
pending_payment ──pay──▶ placed ──pack──▶ packed ──ship──▶ shipped ──deliver──▶ delivered ──request_return──▶ return_requested
      │                    │                 │                                     ▲                          │        │
      └──cancel_buyer──────┴─▶ cancelled ◀───┘ (cancel_seller)                     └──────reject_return───────┘   accept_return ─▶ returned
```

- Each transition names who may perform it; updates use `WHERE status = <expected>` so concurrent clicks can't double-apply.
- **Checkout** prices the cart on the server, then reserves stock with `UPDATE … SET stock = stock - ? WHERE stock >= ?` inside one transaction — overselling is impossible. An idempotency key per checkout makes double-submits return the same order.
- **Cancel / return** restocks and records refunds for prepaid orders.
- **Payouts**: a delivered fulfilment becomes payable after the return window; settling links it to a payout row so it can never be paid twice.

## 6 · Payments

`create_payment_intent` / `settle_payment` define the provider seam. The built-in **test gateway** lets the browser simulate success or failure and is disabled when `PARTPILOT_PAYMENTS_TEST_MODE=false`. The production adapter (Razorpay) must confirm payments only through a signed webhook or a server-to-server fetch — see the launch checklist.

## 7 · Frontend

- React 19 + TypeScript (strict), bundled by esbuild; seller and admin portals are code-split chunks.
- Tiny History-API router, a cache-first `useQuery` hook, and four contexts: session, my car, cart, toasts.
- Guests keep a local cart priced by `POST /api/cart/preview`; it merges into the account cart on sign-in.
- Design tokens in `styles/tokens.css`; components in `ui/`; no inline scripts, so the CSP needs no exceptions.

## 8 · Scaling path

| Today | When it grows |
|---|---|
| PostgreSQL full-text search | Typesense / OpenSearch when the catalogue grows very large |
| In-process rate limiter | Redis-backed limiter (same interface) |
| Local disk for photos | S3-compatible object storage + CDN |
| Synchronous email-free flows | Queue (order emails/SMS, courier webhooks, payout files) |
