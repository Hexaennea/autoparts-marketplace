# ADR 0004 — Fitment at the variant level

**Status:** accepted · 2026-11-10

**Decision.** Parts link to `variants` (make → model → generation → trim/engine/fuel/gearbox over a year range). Buyers choose make, model, **year**, then variant; the year narrows the variant list. Universal parts (fluids, bulbs) use a flag instead of fitment rows.

**Why.** Variant is the level at which Indian parts catalogues differ (e.g. Swift petrol vs diesel discs, AMT vs MT clutches). Year-level rows would multiply data ~10× without adding precision for most parts.

**Later.** If a part changes mid-generation, add optional `year_from`/`year_to` on `product_fitments` (column reserved by design: `note`). Registration-number lookup can map to a variant via a provider API.
