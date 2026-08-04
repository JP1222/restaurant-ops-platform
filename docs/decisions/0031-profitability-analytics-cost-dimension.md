# ADR-0031: Profitability analytics via a cost dimension in analytics-api

- **Status**: Accepted (2026-06-02 decision; implemented — cost dimension `mart.dim_item_cost` + `mart.cost_daily_mv` / `mart.prime_cost_daily_mv` / `mart.cost_variance_daily_mv` via migrations 011–021; margin metrics in `meta.metric_definitions`; the menu-engineering margin-axis fix in `apps/backoffice-web/lib/menu/kasavana-smith.ts`; and the `/costs` + `/menu` surfaces. Status reconciled 2026-06-15.)
- **Date**: 2026-06-02
- **Deciders**: @example-org
- **Builds on**: [ADR-0028](0028-sales-driven-inventory-depletion.md) (the inventory-side stock/COGS ledger — this ADR is its analytics-side sibling), [ADR-0002](0002-five-iron-laws.md) (Iron Laws 1 + 5), [ADR-0018](0018-multi-location-architecture.md) (location scoping), [ADR-0030](0030-semantic-metric-registry-as-ai-grounding.md) (margin metrics register in the registry).
- **Grounded in**: the 2026-06-02 deep-research + audit. Companion designs: [menu-engineering-redesign.md](../design/analytics/menu-engineering-redesign.md), [cost-and-prime-cost.md](../design/analytics/cost-and-prime-cost.md).

## Context

The backoffice "menu engineering" page classifies items by `quantity_mean × gross_sales_mean` — **popularity × revenue** (see `MenuQuadrantSchema` in `packages/contracts`). The classic Kasavana-Smith matrix requires **popularity × contribution margin** (price − plate cost). Revenue is not margin: a high-revenue, **low-margin** item is mislabeled a **Star** when it is really a **Plowhorse**, and the owner makes the wrong menu decision off it. This is a **business-correctness defect**, not a cosmetic gap.

More broadly, analytics-api computes **revenue-only** metrics (net/gross sales, payment mix, daypart, top items). There is **zero cost data in `mart`**, so food cost %, gross margin, per-item margin, and **prime cost** cannot be computed — yet prime cost is the single most-watched restaurant KPI. Authoritative benchmark (NRA *2025 Restaurant Operations Data Abstract*, median, n>900, FY2024): **limited-service** food + non-alcohol beverage cost median **32.4%** of sales, prime-cost median **~65%** — the target band for Example Kitchen as a limited-service parlor.

Boundary constraints:

- **Iron Law 1** — no cross-app DB-client import; analytics cannot read `db-inventory`.
- **Iron Law 5** — analytics is read-only OLAP; it ingests external sources into **its own** mart, and never writes another service's DB.

[ADR-0028](0028-sales-driven-inventory-depletion.md) already establishes an **inventory-side** COGS: inventory-api derives COGS from its stock-movement ledger (`Σ depleted-delta × ingredient cost`), including waste/count drift. That number is **operational** (inventory Overview) and lives where stock lives — **not** where sales facts live, so it cannot drive sales-joined profitability analytics (per-item margin by daypart, the menu quadrant).

## Decision

**Give analytics-api a cost dimension sourced from inventory-api, and compute profitability metrics in analytics SQL — keeping "what a menu item costs" owned by inventory and "what my profitability is" owned by analytics.**

1. **inventory-api owns and exposes plate cost.** It already has the inputs: `InventoryRecipe` (`cloverItemId` join key, `lines[]`) + `InventoryItem.costCents`. It computes plate cost per menu item = `Σ(recipe line qty × ingredient costCents)` and exposes it read-only: `GET /api/recipes/plate-costs?location=<id>` → `[{ clover_item_id, plate_cost_cents, currency, effective_from }]`. It exposes **cost**, not margin.
2. **New contract in `packages/contracts` (Iron Law 2):** `PlateCostSnapshotSchema` — the cross-service shape, zod-validated.
3. **analytics-api ingests plate cost into `mart.dim_item_cost`** — an **effective-dated** dimension keyed by `(merchant_id, item_fingerprint/clover_item_id, effective_from)`. Ingested on a schedule over HTTP, **exactly like Clover ingestion**: analytics reads an external source and writes only its own mart (Iron Laws 1 + 5 honored). Effective-dating preserves historical margins when a cost changes.
4. **Profitability metrics computed in analytics SQL, registered in the metric registry ([ADR-0030](0030-semantic-metric-registry-as-ai-grounding.md)):** per-item contribution margin = `gross_sales − units×plate_cost`; food cost % = `Σ(units×plate_cost) / net_sales`; gross margin; and (once labor lands — roadmap Phase 4) prime cost = food% + labor%.
5. **Menu engineering rebuilt on the margin axis.** `MenuQuadrantSchema` gains a contribution-margin measure; the quadrant **nulls out items with no plate-cost mapping** ("cost unknown") and **never defaults cost to 0** (that would mislabel them Stars).
6. **Two COGS lenses, reconciled — not duplicated.** inventory's ledger COGS ([ADR-0028](0028-sales-driven-inventory-depletion.md)) = *actual depletion incl. waste*; analytics' sales-side COGS (this ADR) = *theoretical `Σ(units sold × plate cost)`*. They answer different questions and their **delta is itself the signal — yield variance / shrinkage** (over-portioning, spillage, comps). Single source of truth for the cost *input* (inventory owns plate cost); two legitimate, reconcilable COGS *views*.

## Consequences

- Fixes the menu-engineering correctness bug and unlocks food cost %, margin, and (with labor) prime cost — all in the **same query space as sales**, so every existing sales metric trivially gains a margin sibling.
- analytics-api gains one scheduled ingest + a read-only HTTP dependency on inventory-api; inventory-api gains one read endpoint; `packages/contracts` gains `PlateCostSnapshot`. This is **symmetric to [ADR-0028](0028-sales-driven-inventory-depletion.md)**'s analytics→inventory line-item contract — the two services now hold two independent **batch read contracts in opposite directions**. This is **not** a synchronous RPC loop: each side is an eventual-consistency pull into the puller's own DB on its own schedule.
- A new reconciliation surface (theoretical vs actual COGS); their gap must be **explained as yield variance**, not treated as a bug.
- Plate cost is only as good as the recipes; items without a recipe show "cost unknown" until the BOM editor ([ADR-0028](0028-sales-driven-inventory-depletion.md) Phase 3) is populated. Margin-analytics coverage grows as recipes are entered.

## Alternatives considered

- **inventory-api computes and exposes margin** (not just cost). Rejected: margin is `sales × (price − cost)`; inventory would have to re-derive sales-mix/daypart/menu-mix that analytics already owns → duplication + a conceptual service loop. Inventory's job is "what it costs"; profitability is an analytics concern.
- **backoffice BFF joins sales + cost in memory.** Rejected: fastest MVP, but it doesn't compose with the metric registry ([ADR-0030](0030-semantic-metric-registry-as-ai-grounding.md)) or cross-store roll-up, and re-does the join on every request — a dead end for AI grounding. (The owner explicitly accepted a larger, correct change over an MVP.)
- **analytics ingests raw ingredient costs + full recipe BOMs and computes plate cost itself.** Rejected: duplicates inventory's recipe domain and drifts from it; ingesting the already-computed plate cost keeps inventory the single source of truth for cost composition.
- **Do nothing / keep revenue-only menu engineering.** Rejected: it is actively wrong (mislabels items) and leaves the headline restaurant KPI (prime cost) uncomputable.
