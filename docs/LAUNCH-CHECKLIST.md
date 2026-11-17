# Launch checklist

What separates this build from taking real money. Grouped by owner; tick before going live.

## Business decisions still open

- [ ] Final brand name and domain (`PARTPILOT_APP_NAME`, logo in `layouts/StoreLayout.tsx` + `public/favicon.svg`)
- [ ] Launch city and seller pilot list
- [ ] Commission rate (default 8 %, editable in Admin → Settings)
- [ ] Delivery fee and free-delivery threshold (₹79 / ₹999 per seller by default)
- [ ] Return window (7 days by default; also the payout hold)

## Data

- [ ] **Remove all demo data**: start production with `python -m app.cli migrate` (never `seed`), then `create-admin`
- [ ] Load the real vehicle master (makes, models, variants with year ranges) — verify against an EPC / manufacturer source
- [ ] Load categories and brands; confirm OEM flags
- [ ] Replace demo product illustrations with real photography in seller listings

## Payments & money

- [ ] Implement the Razorpay adapter at the `create_payment_intent` / `settle_payment` seam; confirm payments **only** via signed webhook (`X-Razorpay-Signature`, HMAC-SHA256) or server-side fetch
- [ ] Set `PARTPILOT_PAYMENTS_TEST_MODE=false` (the test endpoint then returns 403)
- [ ] Wire real refunds for cancellations/returns (currently recorded, not executed)
- [ ] Payout execution (bank file or Razorpay Route) from Admin → Payouts
- [ ] Commission invoices to sellers incl. GST on commission

## Tax & compliance (India)

- [ ] GST registration as an e-commerce operator; TCS collection (1 % recorded per order) and monthly GSTR-8 export
- [ ] Buyer tax invoices issued in the seller's name (GSTIN, HSN, rate per line — already stored on order items)
- [ ] Terms of use, privacy policy (DPDP Act 2023), seller agreement, returns policy pages
- [ ] Grievance officer details published (Consumer Protection (E-Commerce) Rules 2020)

## Infrastructure

- [ ] TLS at the reverse proxy; `PARTPILOT_COOKIE_SECURE=true`, `PARTPILOT_TRUST_PROXY=true` only behind it
- [ ] `PARTPILOT_SECRET_KEY` from a secrets manager
- [ ] Persistent volume for `/data`, nightly encrypted PostgreSQL backups (Cloud SQL automated backups / pg_dump) + restore drill
- [ ] Object storage + CDN for `/media`
- [ ] Error tracking and uptime alerts on `/api/health`
- [ ] Redis rate limiter before running more than one instance
- [ ] Scheduled `python -m app.cli purge-sessions`

## Notifications (not built yet)

- [ ] Order / shipping / return emails and SMS to buyers
- [ ] New-order alerts to sellers; KYC and listing-review outcomes
- [ ] Password reset by email (current build supports change-while-signed-in only)

## Assurance

- [ ] Third-party penetration test
- [ ] Load test checkout and search at expected peak
- [ ] Accessibility audit with screen-reader users (WCAG 2.1 AA target)
