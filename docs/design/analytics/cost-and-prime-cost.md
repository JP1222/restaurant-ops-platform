# Cost & Prime-Cost Analytics — Design

- **Status**: Draft (2026-06-02)
- **Owner**: @example-org
- **Decision**: [ADR-0031](../../decisions/0031-profitability-analytics-cost-dimension.md) (cost dimension), with labor in roadmap Phase 4
- **Roadmap phases**: 2 (food cost % + dashboard), 4 (labor % → prime cost)
- **Touches**: `apps/analytics-api` (`mart.dim_item_cost`, cost metrics, labor mart), `apps/backoffice-web/app/(authed)/costs/`

> **Prime cost is the number a restaurant operator actually lives on**, and today the suite can't compute it. This doc defines the cost KPIs, their benchmark bands, the dashboard, and — importantly — how the two COGS numbers in the suite relate so they never become two conflicting "official" figures.

## KPI definitions (the口径, authoritative)

Registered as metrics ([ADR-0030](../../decisions/0030-semantic-metric-registry-as-ai-grounding.md)) so every surface shares one definition.

| Metric | Definition | Source |
|---|---|---|
| **Food cost %** | `Σ(units_sold × plate_cost) / net_sales` over the period | `mart.dim_item_cost ⋈ fact_order_line_items` ÷ `sales_daily_mv` |
| **Contribution margin (item)** | `gross_sales − units × plate_cost` | same |
| **Gross margin %** | `(net_sales − food_cost) / net_sales` | derived |
| **Labor cost %** | `labor_cost / net_sales` | labor mart (Phase 4) |
| **Prime cost %** | `food_cost_% + labor_cost_%` | composite metric |

All cost math is integer-cents; plate cost is **effective-dated** so a price change doesn't rewrite history.

## Benchmark bands (NRA, limited-service — Example Kitchen's segment)

The only methodology-disclosed numbers in the research (NRA *2025 Data Abstract*, median, n>900, FY2024). Render as target bands, not a single line:

| KPI | Green | Amber | Red |
|---|---|---|---|
| Food cost % | ≤ **32.4%** | 32.4–35% | > 35% |
| Prime cost % | ≤ **65%** | 65–70% | > 70% |

(Labor % has no methodology-solid public median in our corpus — show it without a benchmark band until we have one, rather than invent the "~30%" rule of thumb as if authoritative.)

## The two-COGS reconciliation (the part that prevents drift)

The suite has **two legitimate COGS lenses**. They are *not* duplicates and must be presented as a pair:

| Lens | Where | What it is | Includes |
|---|---|---|---|
| **Theoretical (sales-side)** | analytics ([ADR-0031](../../decisions/0031-profitability-analytics-cost-dimension.md)) | `Σ(units sold × plate cost)` | only what was sold |
| **Actual (depletion-side)** | inventory ([ADR-0028](../../decisions/0028-sales-driven-inventory-depletion.md)) | `Σ(stock-movement delta × ingredient cost)` | sales **+ waste + count drift** |

Their **difference is a feature**: `actual − theoretical ≈ yield variance` (over-portioning, spillage, comps, waste). Surface it as a "yield variance" tile, not as a discrepancy to hide. Single source of truth for the cost *input* (inventory owns plate cost); two reconcilable *views*.

## Dashboard (`/costs`)

- **Food Cost %** card with the 32.4% band + period trend.
- **Labor Cost %** card — Phase 2 shows an explicit "待接入 / not yet connected" empty state (never a fake number); Phase 4 fills it.
- **Prime Cost %** card with the ~65% band (lights up once labor lands).
- **Gross margin trend** (net sales − food cost) with week-over-week.
- **Yield variance** tile (actual vs theoretical COGS).
- Every number is a registered metric (resolves through `get_metric`), so the AI can answer "why did food cost % jump Tuesday?" against the same definitions.

## Labor (Phase 4)

Ingest Clover **shifts/timecards** into a `mart.labor_*` fact (employee, clock-in/out, hours, wage if available) → `labor_cost`, `sales_per_labor_hour`, `covers_per_labor_hour`, and `labor_cost_%` → completing prime cost. analytics stays read-only (it ingests Clover labor exactly like Clover sales).

## Acceptance

- Food cost % renders against the 32.4% band from real `dim_item_cost` data.
- The labor card shows an honest empty state before Phase 4 (no placeholder number).
- Yield-variance tile shows `actual − theoretical` and explains it in copy.

## Ready-to-use design prompt

```text
Build apps/backoffice-web/app/(authed)/costs/ per
docs/design/analytics/cost-and-prime-cost.md. Cards: Food Cost % (Σ(units×plate_cost)
/ net_sales) with NRA bands green≤32.4% / amber 32.4–35% / red>35%; Labor Cost %
(honest "not yet connected" empty state until Phase 4); Prime Cost % = food%+labor%
with ~65% band; Gross-margin trend; Yield-variance tile = inventory actual COGS −
analytics theoretical COGS. Every figure must resolve through a registered metric
(get_metric / resolveMetric, ADR-0030) — no口径 in the component. Do not invent a
labor benchmark band. Do not show a placeholder number when labor data is absent.
```
