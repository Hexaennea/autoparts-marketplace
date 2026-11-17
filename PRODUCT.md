# Product


## Platform

web

## Stack

Delegated, recommendation accepted (2026-11-10): React 19 + TypeScript single-page web app bundled with esbuild; Node.js API (Express + TypeScript + zod) on PostgreSQL 17 (backend ported from the original Python/SQLite build on 2026-11-17). One origin serves the web app and `/api`. Replaces the earlier Shopify + marketplace-app plan (2026-11-06).

## Users

- **Buyers:** Indian car owners and the mechanics / small garages who buy on their behalf. Their job: find the exact part that fits one specific car (make, model, year, variant) without knowing the part number, or cross-check a part number they already have.
- **Sellers:** spare-parts shops, distributors and authorised-dealer parts counters. Their job: list stock once with correct fitment data, get orders, pack and ship them, and see what they will be paid.
- **Platform admins:** the operating team. Their job: approve sellers (KYC), moderate listings, keep the vehicle and category master data clean, watch orders and settle seller payouts.

## Product Purpose

A multi-seller marketplace for car spare parts, in the spirit of eBay / Amazon / OLX but built only for auto parts, like boodmo. Success: a buyer picks their car once and only sees parts that fit it; a seller can list a part with fitment in minutes; every order is traceable from payment to payout.

## Positioning

Fitment is the core data, not an afterthought. Sellers attach parts to platform-owned vehicle variants (make → model → year range → variant), so search can answer "does this fit my car?" with a yes or no instead of a hopeful title match. Part numbers (OEM and aftermarket cross-references) are searchable directly.

## Operating Context

- Buyers browse on phones and desktops, often standing in a garage or comparing quotes from a local shop.
- Prices in Indian rupees, GST-inclusive. Cash on delivery is expected alongside online payment.
- Sellers ship orders themselves with their own courier and enter tracking numbers.
- Platform takes a commission per order (configurable; default 8%). India e-commerce operator obligations (GST TCS, GSTR-8) apply; the platform records what is needed to report them.

## Capabilities and Constraints

- V1 catalogue: **cars only, new parts only** (OEM-genuine and branded aftermarket). Used parts and two-wheelers are out of scope for v1.
- Payments: cash on delivery + online payment through a gateway interface; v1 ships a clearly-labelled test-mode gateway, Razorpay is the intended production provider.
- Three portals: buyer storefront, seller portal, admin portal.
- Undecided: launch city, final commission rate, final brand name and domain, registration-number vehicle lookup provider.

## Brand Commitments

- Working name **PartPilot** (placeholder, set in one config value; final name undecided).

## Evidence on Hand

- No real seller, product, customer or review data yet. All catalogue, seller and order data in the build is synthetic demo data and must be labelled as such and replaced before launch.
- No logo or brand assets yet.
- No product photography; demo product images are authored illustrations, not photos.

## Product Principles

1. Fitment certainty first: never imply a part fits a car unless fitment data says so.
2. Part numbers are first-class: searchable, copyable, shown on every listing.
3. Server is the source of truth for price, stock and permissions; the client never decides money.
4. Every seller and admin action that changes money, stock or status is recorded and traceable.
5. Familiar marketplace patterns over novelty; speed and clarity over decoration.

## Accessibility & Inclusion

WCAG 2.1 AA as the floor: keyboard reachable, visible focus, 4.5:1 text contrast, labelled form controls. Works on low-end Android phones and slow connections (small bundles, no heavy media).
