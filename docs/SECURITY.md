# Security

## What we protect

| Asset | Threat | Primary controls |
|---|---|---|
| Accounts | credential stuffing, session theft, fixation | scrypt hashes, lockout + rate limits, HttpOnly session cookie, rotation on login |
| Money | price tampering, double refunds/payouts, fake payments | server-side pricing, state machine with optimistic checks, payout linking, test gateway off in production |
| Stock | overselling under concurrency | atomic conditional decrement inside `BEGIN IMMEDIATE` |
| Other people's data | IDOR across buyers/sellers | ownership in every query, 404 on foreign IDs |
| The platform | XSS, CSRF, clickjacking, injection, malicious uploads | CSP `'self'`, CSRF tokens + origin checks, `frame-ancestors 'none'`, parameterised SQL, image re-encoding |

## Controls

**Authentication** (`security/passwords.py`, `api/auth.py`)
- scrypt (N=2¹⁴, r=8, p=1, 16-byte salt); parameters stored per hash, `needs_rehash` upgrades on login
- Password policy: 10+ chars, 3 of 4 character classes, not common, not containing name/email
- Unknown emails run a dummy hash check (equal timing); one generic error for wrong email or password
- 5 failures → 15-minute lock; login limited per IP **and** per email

**Sessions & CSRF** (`security/sessions.py`, `http.py`)
- 256-bit random token in an `HttpOnly; SameSite=Lax; Secure` cookie; only its SHA-256 is stored
- 7-day absolute and 48-hour idle expiry; new session on every login; password change signs out other sessions; suspension deletes all sessions
- Every write needs `X-CSRF-Token` = `pp_csrf` cookie = session's token (constant-time compare); cross-site `Origin` / `Sec-Fetch-Site` rejected

**Authorisation**
- Role gate per route; ownership filters in SQL; foreign IDs return 404
- Sellers must be KYC-approved to submit listings or act on orders; suspended sellers vanish from search immediately
- Admins can't be suspended through the API, and can't change their own status

**Input & output**
- Pydantic models with length limits on every field; control characters stripped; Indian identifiers validated (GSTIN checksum, PAN, IFSC, PIN, mobile)
- Only parameterised SQL. f-strings appear only for placeholder lists and fixed column names
- FTS queries are built from `[0-9A-Za-z]` tokens only, each quoted
- React escapes all output; no `dangerouslySetInnerHTML`; post-login redirects accept same-site paths only
- CSV exports neutralise formula cells (`=`, `+`, `-`, `@`)

**Uploads** (`services/media.py`)
- Content-type allow-list, size cap, decompression-bomb guard, sharp full decode + pixel limit, minimum dimensions
- Re-encoded to WebP under a random name → no user bytes, filenames or EXIF/GPS are ever served

**Transport & headers** (`security/middleware.py`)
- CSP: `default-src 'self'; script-src 'self'; style-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'`
- HSTS (production), `nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy`, `Permissions-Policy`, COOP/CORP
- API responses `Cache-Control: no-store`; hard request-body cap even without `Content-Length`

**Accountability**
- `audit_log` records actor, role, IP and details for every change to listings, sellers, orders, payouts, master data and settings
- Request ID on every response and error; access log line per request; no bodies or secrets logged

## Verified by tests

`server/tests/security.test.ts`, `auth.test.ts`, `commerce.test.ts` cover: CSRF on writes, cross-site origins, lockout, session revocation, rate limits, IDOR between sellers and between buyers, RBAC matrix, search-input fuzzing, path traversal, oversize/malformed bodies, upload sanitisation and decompression bombs, concurrent checkout of the last unit, payment replay and forgery, idempotent checkout.

## Before production

See [LAUNCH-CHECKLIST.md](LAUNCH-CHECKLIST.md) — notably: real payment adapter with signed webhooks, secrets in a vault, TLS at the proxy, backups, Redis rate limiting if more than one instance, and a third-party penetration test.

## Reporting

Security issues: email the platform owner privately. Please don't open public issues for vulnerabilities.
