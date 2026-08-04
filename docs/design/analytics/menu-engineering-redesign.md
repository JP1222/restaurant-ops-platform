# Menu Engineering Redesign — Design

- **Status**: Draft (2026-06-02)
- **Owner**: @example-org
- **Decision**: [ADR-0031](../../decisions/0031-profitability-analytics-cost-dimension.md)
- **Roadmap phases**: 1 (cost dimension), 2 (the fix + dashboard)
- **Touches**: `packages/contracts` (`MenuQuadrantSchema`), `apps/analytics-api` (`mart.dim_item_cost`, margin metrics), `apps/backoffice-web/app/(authed)/menu/`, `lib/analytics-api/menu-engineering-transform.ts`

> **The current menu-engineering page is wrong, not just shallow.** Its quadrant axis is **revenue**, but menu engineering is defined on **margin**. Fixing it is the highest-value, lowest-effort win in the whole roadmap — once cost data lands, it's a transform change.

## The bug, precisely

`MenuQuadrantSchema` classifies items by `quantity_mean × gross_sales_mean` → popularity × **revenue**. The classic **Kasavana-Smith** matrix is popularity × **contribution margin** (`price − plate cost`). These disagree exactly where it matters:

| Item | Units | Revenue | Plate cost | Margin | Revenue axis says | Margin axis says |
|---|---|---|---|---|---|---|
| Signature loaded roll | high | **high** | high | **low** | ⭐ Star | 🐴 Plowhorse |
| Simple soft-serve cup | high | low | low | **high** | 🐴 Plowhorse | ⭐ Star |

The owner protects the wrong item and discounts the wrong item. This is a **business-correctness defect**.

## The correct model

- **Y axis — contribution margin** per item = `unit_price − plate_cost` (absolute cents; menu engineering uses absolute margin, not margin %).
- **X axis — popularity** = menu mix share = `item_units / total_units`, compared to an expected share. Standard threshold: an item is "high popularity" if its mix share ≥ `(1 / N) × 0.70`, where `N` = number of active items.
- **Quadrants**: Star (high margin, high pop) · Plowhorse (low margin, high pop) · Puzzle (high margin, low pop) · Dog (low margin, low pop). Margin "high/low" is split at the **menu-wide average contribution margin** (units-weighted).

## Data flow (front-to-back)

```
inventory-api  GET /api/recipes/plate-costs           ← owns recipe→cost (ADR-0031)
      │  PlateCostSnapshot[] { clover_item_id, plate_cost_cents, effective_from }
      ▼
analytics-api  ingest → mart.dim_item_cost (effective-dated)
      │  dim_item_cost ⋈ mart.fact_order_line_items (by item_fingerprint/clover_item_id)
      ▼
  margin metrics (registered per ADR-0030):
    contribution_margin_per_item, menu_mix_share, item_units
      ▼
backoffice  /api/menu/quadrants  →  menu-engineering-transform.ts  →  /menu page
```

## The "cost unknown" rule (do not skip)

If an item has **no** plate-cost mapping in `dim_item_cost`, it is rendered in a separate **"cost unknown"** bucket and **excluded** from quadrant math. **Never default an unknown cost to 0** — a 0-cost item shows infinite margin and falsely lands as a Star. As recipes are entered ([ADR-0028](../../decisions/0028-sales-driven-inventory-depletion.md) Phase 3), coverage grows and items move out of "cost unknown".

## UI

- Four-quadrant scatter (Recharts), one dot per item, dot size = units, axes labeled with the thresholds.
- Per-quadrant **action guidance**: Star → protect, hold price, keep visible · Plowhorse → raise price or cut cost · Puzzle → rename / reposition / bundle / suggest-sell · Dog → consider removing.
- A "cost unknown — N items need a recipe" callout linking to the BOM editor.
- Date-window selector (reuse existing pattern); margins read point-in-time via `dim_item_cost` effective dating.

## Contract change

`MenuQuadrantSchema` gains `contribution_margin_cents` and `plate_cost_cents` (nullable → "cost unknown"); `quadrant` is computed from margin × popularity. Keep `gross_sales_mean` for display (revenue is still useful context), but it **no longer drives the quadrant**.

## Acceptance

- A seeded high-revenue / low-margin item lands in **Plowhorse**, not Star.
- An item with no recipe shows in "cost unknown", never as a Star.
- Quadrant splits use units-weighted average margin and the `(1/N)×0.70` popularity line.

## Ready-to-use design prompt

```text
Rebuild apps/backoffice-web/app/(authed)/menu/ per
docs/design/analytics/menu-engineering-redesign.md. Replace the revenue-based
quadrant with the Kasavana-Smith model: Y = contribution margin (unit_price −
plate_cost, absolute cents, split at the units-weighted menu average), X = menu
mix share (split at (1/N)×0.70). Source margin from analytics' dim_item_cost ⋈
fact_order_line_items (ADR-0031); items with no plate-cost map go to a separate
"cost unknown" bucket and are EXCLUDED from quadrant math — never default cost
to 0. Render a four-quadrant Recharts scatter (dot size = units) with per-quadrant
action guidance and a "cost unknown — N items need a recipe" callout. Extend
MenuQuadrantSchema in packages/contracts with contribution_margin_cents and
nullable plate_cost_cents. Keep the existing menu-engineering-transform.ts pattern.
```
