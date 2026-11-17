---
name: PartPilot
description: Car-parts marketplace with an automotive-showroom finish. Black chrome, white floors, hairline silver rules, a thin display face, and a full-bleed film on the home page.
colors:
  page: "#ffffff"
  shelf: "#f4f4f5"
  shelf-2: "#ebebed"
  label: "#ffffff"
  label-sunk: "#fafafa"
  art-ground: "#f3f5f7"
  ink: "#0b0b0c"
  ink-2: "#3c3c41"
  ink-3: "#66666c"
  ink-placeholder: "#77777d"
  rule: "#e6e6e8"
  rule-strong: "#cdcdd1"
  band: "#0b0b0c"
  band-hover: "#2b2b30"
  accent: "#1a6ed8"
  night: "#000000"
  night-2: "#121214"
  night-ink-2: "#a1a1a8"
  silver: "#c8cbd0"
  gold: "#c99a3d"
  ok: "#157347"
  ok-soft: "#ecf6f0"
  warn: "#9a5800"
  bad: "#b42318"
typography:
  hero:
    fontFamily: "PartPilot Serif (TeX Gyre Pagella), Palatino Linotype, Georgia, serif"
    fontSize: "clamp(2.6rem, 1.4rem + 4vw, 5rem)"
    fontWeight: 400
    lineHeight: 1.02
    letterSpacing: "-0.035em"
  h1:
    fontFamily: "PartPilot Serif (TeX Gyre Pagella), Palatino Linotype, Georgia, serif"
    fontSize: "2.125rem"
    fontWeight: 400
    lineHeight: 1.12
    letterSpacing: "-0.02em"
  h2-section:
    fontFamily: "PartPilot Serif (TeX Gyre Pagella), Palatino Linotype, Georgia, serif"
    fontSize: "clamp(1.75rem, 1.3rem + 1.2vw, 2.375rem)"
    fontWeight: 400
    lineHeight: 1.1
    letterSpacing: "-0.02em"
  body:
    fontFamily: "Inter, system-ui, sans-serif"
    fontSize: "0.9375rem"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "Inter, system-ui, sans-serif"
    fontSize: "0.6875rem"
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: "0.14em"
  wordmark:
    fontFamily: "Inter, system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 500
    letterSpacing: "0.24em"
rounded:
  xs: "2px"
  sm: "4px"
  btn: "4px"
  md: "6px"
  lg: "8px"
  xl: "12px"
spacing:
  1: "4px"
  2: "8px"
  3: "12px"
  4: "16px"
  5: "20px"
  6: "24px"
  8: "32px"
  10: "40px"
  12: "48px"
  16: "64px"
  20: "80px"
  24: "96px"
components:
  button-primary:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.label}"
    rounded: "{rounded.btn}"
    height: "44px"
    padding: "0 24px"
  button-secondary:
    backgroundColor: "{colors.label}"
    textColor: "{colors.ink}"
    rounded: "{rounded.btn}"
    height: "44px"
  button-on-night:
    backgroundColor: "{colors.label}"
    textColor: "{colors.ink}"
    rounded: "{rounded.btn}"
  input:
    backgroundColor: "{colors.label}"
    textColor: "{colors.ink}"
    rounded: "{rounded.btn}"
    height: "46px"
  header:
    backgroundColor: "{colors.night}"
    textColor: "{colors.label}"
    height: "68px"
  fit-tag-yes:
    backgroundColor: "{colors.ok-soft}"
    textColor: "{colors.ok}"
    rounded: "{rounded.sm}"
  spec-label-head:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.label}"
  portal-rail:
    backgroundColor: "{colors.night}"
    width: "256px"
---

# Design System: PartPilot

## Overview

**North star: an automotive showroom.** The page is a white floor. The chrome around it (header, footer, portal rail) is black. The part sits under even light in a pale well. Restraint carries the luxury: one action colour (black), hairline silver rules instead of boxes, a thin display face at large sizes, wide-tracked uppercase labels, and generous space.

The home page opens on a full-bleed film: a silver saloon comes apart into its parts and reassembles. The headline and a frosted-glass car picker sit on top of it.

The product is an **Operate** surface, so the storefront and both portals stay task-first. Part number and fitment remain the loudest facts on every listing.

## Colors

- **Black chrome** (`#000`, `#121214`) is used for the header, category row, footer, portal rail, toasts and the spec-label head.
- **Ink** (`#0b0b0c`) is the colour of every action: primary buttons, active filters, chart bars, selected tabs and checkboxes.
- **White floors** (`#ffffff`) are the page and card background.
- **Shelf** (`#f4f4f5`) is used for hovers, category wells and the portal work area.
- **Art ground** (`#f3f5f7`) sits behind product photos and matches their backdrop exactly.
- **Hairlines:**
  - Rule `#e6e6e8` divides content.
  - Rule strong `#cdcdd1` outlines inputs and chips.
  - A full-ink rule tops spec tables, brand rows and order totals.
- **Steel blue** (`#1a6ed8`) is used only for focus rings, the page-load bar and chart hover, so focus always stands out from the black actions.
- **Green** (`#157347` on `#ecf6f0`) means one thing: it fits your car. It is also used for delivered and paid states.
- **Gold** (`#c99a3d`) is used only for rating stars and the "needs attention" dot.

### Named Rules
**The One Action Colour Rule.** Anything you can press to move forward is black, or white when it sits on black. There are no coloured CTAs.

**The Green Means It Fits Rule.** Green never sells. It only confirms fitment or a good state.

## Typography

- **PartPilot Serif** (TeX Gyre Pagella, a Palatino-style roman; GUST Font License, self-hosted) sets every headline: the hero, page titles, section heads, product titles, dialog and empty-state titles. Regular weight only, −0.012em tracking, no synthetic bold.
- **Inter** (400/500/600) sets the interface text.
- **Inter Display Light** (300) sets numbers: prices, part numbers on labels, KPI values and review scores. The serif has no ₹ sign, so money never uses it.

The contrast between a classical serif headline and quiet sans UI text is the main source of polish.

- **Hero:** 42–80px serif.
- **Page titles:** 34px serif.
- **Section heads:** 28–38px serif.
- **Card titles:** 17px semibold.
- **Labels:** 11px semibold uppercase, +0.14em tracking. They sit above a value (spec cells, KPI labels, brand on cards, table heads), never above a heading.
- **Wordmark:** "PARTPILOT", 14px medium, +0.24em.
- **Tabular figures** for money, quantities and tables.

## Layout

- Container 1320px; gutters 24px (16px on phones); sections 80px apart.
- **Header:** black, 68px.
  - Wordmark · dark search well with a white Search button · outlined "My car" plate · account · cart.
  - Below it, a black category row with underline-on-hover links.
- **Home, top to bottom:**
  1. Film hero, 600–880px tall. The headline sits bottom-left with a glass car picker beneath it.
  2. Trust row: four columns split by hairlines.
  3. Category grid: five across.
  4. Popular parts.
  5. "Label story": copy beside the spec-label card.
  6. Brand rows.
  7. Full-bleed sell band, with the film's engine close-up behind it in greyscale.
- **Product grid:** borderless cards, a 4:3 image well and text below. Two columns on phones.
- **Portals:** a 256px black rail and a light-grey work area with white hairline cards. The rail becomes a drawer under 1000px.
- **Breakpoints:** 480 · 520 · 640 · 760 · 900 · 960 · 1000 · 1100.

## Elevation & Depth

Depth comes from hairlines and from the contrast between black and white. Shadows are rare:
- **lift-2** is used for the editor save bar and order hover.
- **lift-3** is used for dialogs, menus, search suggestions and the floating proof label.

## Shapes

| Radius | Used for |
|---|---|
| 2px | Small tags |
| 4px | Buttons, inputs, chips, badges, fit tags |
| 6px | Image wells |
| 8px | Cards, the spec label and dialogs |

Pills are kept only for the round wishlist and pause buttons and for counters.

## Motion

- **Easing:** `cubic-bezier(.22,.61,.36,1)`, at 140ms for hover and 240ms for state changes.
- **Product images:** scale to 1.05 over 600ms on hover.
- **Category row links:** draw an underline from the left.
- **The film:**
  - A 12.1s seamless loop, muted: the clip plays forwards (the car comes apart) and then backwards (it reassembles), so the loop point never jumps.
  - WebM (VP9) with an MP4 (H.264) fallback; 1600px for desktop (about 1.9MB), 960px for phones (about 0.9MB). The server answers range requests, which Safari needs.
  - It does not autoplay when the visitor prefers reduced motion; the still frame shows instead.
  - A pause/play button is always shown.

## Components

### Buttons
- **Primary:** black with white text, 44px, 4px radius.
- **Secondary and "Buy now":** white with a 1px black outline; they fill black on hover.
- **On black:** a white button with black text.

### Car picker
- A row of four cells (Make / Model / Year / Variant) with numbered step dots and uppercase labels, followed by the action.
- On the hero it becomes frosted glass: 58% black, a 20px blur, a white hairline, white text and a white button.

### Spec label (signature)
- A black head with the brand in tracked capitals.
- Hairline cells, each with a label over a value; the part number spans the row in light display at 26px.
- A footer note and a real Code 128 barcode.

### Fit tag
- A green-on-mint 4px tag with a check-circle icon, e.g. "Fits your Swift VXi".
- Variants: doesn't fit (red), universal (grey) and unknown (outlined).

### Product card
- No border.
- A 4:3 art-ground well (no padding, so photos fill it and illustrations blend into the matching grey) with a round wishlist button and a black "GENUINE" tag.
- Text below the well: tracked brand, title, part number in grey, stars, fit tag, price and a black square add button.
- A hairline "Sold by" footer.

### KPIs
- One hairline grid of cells: a label, then a light 36px value, then a note.

## Do's and Don'ts

### Do
- **Do** print the part number on every listing surface.
- **Do** show fitment as the green tag whenever a car is selected.
- **Do** keep the film muted and pausable, and respect reduced motion.
- **Do** label demo data as demo.

### Don't
- **Don't** introduce a second action colour or coloured CTAs.
- **Don't** use rounded pill buttons or heavy shadows; hairlines carry the structure.
- **Don't** add hero-metric rows, kicker labels above headings, or decorative grids.
- **Don't** use manufacturer logos as decoration. The current film shows a Mercedes-Benz star on the bonnet and grille. Before launch, confirm the rights to the footage and clear or remove the badge, because a parts seller showing it can suggest an affiliation.

## Imagery provenance

- **Home film and stills:** the client's own clip (`Harman_Explode_Home.mp4`), re-encoded without audio. It shows a recognisable carmaker's badge and grille. Confirm the rights to show it before launch, or swap in footage without a third-party badge.
- **Brake photos** (pads, shoes, disc, disc pair, DOT 4 bottle): client-supplied images on a concrete backdrop. Captions were cropped away, and the frames were extended to 4:3 with matching concrete. They carry a generator's corner mark and an invented bottle label, so they are demo stand-ins only.
- **Other part art:** the flat SVG illustrations authored for the demo (`frontend/art/*.svg`).
