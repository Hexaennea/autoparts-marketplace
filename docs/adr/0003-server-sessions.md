# ADR 0003 — Server-side sessions with CSRF tokens (not JWT in localStorage)

**Status:** accepted · 2026-11-10

**Decision.** Opaque random session token in an HttpOnly, SameSite=Lax, Secure cookie; SHA-256 of it stored server-side with a per-session CSRF token that the SPA sends as `X-CSRF-Token`.

**Why.** Tokens can't be read by injected script, sessions can be revoked instantly (logout, password change, suspension), and the same-origin deployment makes cookies simple.

**Trade-off.** One DB read per request — negligible on SQLite, cacheable later.
