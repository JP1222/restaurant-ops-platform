# ADR-0573: Count-based actual COGS + yield variance

- **Status**: Accepted
- **Date**: 2026-06-05
- **Deciders**: @example-org
- **Builds on**: [ADR-0031](0031-profitability-analytics-cost-dimension.md) (theoretical COGS + the yield-variance lens this realizes), [ADR-0028](0028-sales-driven-inventory-depletion.md) (the stock-movement ledger this reads), [ADR-0030](0030-semantic-metric-registry-as-ai-grounding.md) (metrics register in the governed registry), [ADR-0002](0002-five-iron-laws.md) (Iron Laws 1 + 5), [ADR-0548](0548-labor-cost-write-source-in-inventory-api.md) (the write-source feed pattern mirrored here).

## Context

[ADR-0031](0031-profitability-analytics-cost-dimension.md) landed **theoretical** COGS (`Σ units sold × plate cost`) and named the gap that matters — **yield variance = actual − theoretical COGS** ("shrinkage / over-portioning") — but left **actual COGS unspecified**. The Cost dashboard shipped Actual COGS and Yield variance as honest "not connected" cards with no metric behind them.

Two ways to get a real **actual** COGS:

1. **Ledger-derived** (ADR-0028): `Σ (sale + waste) depleted-delta × cost`. This is the long-term shape, but sales-depletion movements are **not populated yet**, and — critically — ledger COGS can only see **shrink** through the `count_adjust` deltas that a **physical count** writes. So actual COGS that captures over-portioning/shrink needs counts either way.
2. **Count-based** — `beginning + received − ending inventory`, the standard limited-service **weekly food-cost** method, and exactly what the backoffice already defined Actual COGS as. The ending count *is* what makes the variance real.

Boundary constraints are unchanged: Iron Law 1 (no cross-app DB client — analytics can't read `db-inventory`) and Iron Law 5 (analytics is read-only OLAP; it ingests external sources into its **own** mart).

## Decision

Compute actual COGS **count-based, per between-count window**, and ship it through the existing cost pipeline:

- **inventory-api (write-source).** `GET /api/actual-cogs-inputs` returns, per consecutive pair of closed physical counts, `actual_cogs_cents = beginning + received − ending` inventory value. Inventory value at a count is reconstructed from the **append-only stock-movement ledger** (`Σ delta` with `created_at ≤` the count's timestamp) valued at **current item cost**; received is the `receive`-reason deltas in the window. The window's **closing** count's `count_adjust` reconciliation is what captures shrink / over-portioning. `< 2` counts → no window. Open read, merchant-stamped — same shape as plate cost (ADR-0031) and labor cost (ADR-0548).
- **analytics-api (ingest + metric).** Upsert windows into `mart.dim_actual_cogs`, then `mart.cost_variance_daily_mv` joins each window to the sum of `cost_daily_mv.theoretical_cogs_cents` over the half-open `(period_start, period_end]` span and sets **`business_date = period_end`** (the closing count date). That keeps `actual_cogs_cents` and `yield_variance_cents` **ordinary single-base-view registry metrics** (ADR-0030) — the composer's standard `business_date` window resolves them with no cross-view machinery, the same trick `prime_cost_daily_mv` uses. Both are **NULL until a window exists** (honest, never a fabricated 0); variance may be negative (found stock / under-portioning).
- **backoffice (surface + trigger).** The Cost dashboard's `YieldVarianceCard` renders the real signed variance (over-theoretical → red, under → green) with the actual-vs-theoretical split, falling back to "not connected" when null. A **count write** (`POST /api/inventory/counts`) best-effort triggers the analytics pull — the count is the event that changes actual COGS, mirroring the labor-cost write path (ADR-0548).

**v1 scope decisions:** value inventory at **current item cost** (effective-dated cost history is a follow-up); period is **between-count windows with no interpolation** (sparse but honest).

## Update — follow-ups shipped

Two of the documented follow-ups below have since landed:

- **Effective-dated cost history.** `inventory_item_cost_history` (db-inventory) records the per-usage cost effective at each point in time, maintained by an append-only DB trigger on `inventory_items.cost_cents` so every cost-write path is captured with no per-call-site code. The valuation now values **each count at the cost effective at that count's timestamp** (received valued at the closing count's cost, the same basis as that window's ending inventory). A closed between-count window is therefore **immutable**: a later cost edit appends a new dated row and can no longer re-price it. Pre-feature history has no dated cost, so it falls back to the current cost (the prior behavior) — a monotonic improvement, no regression.
- **Periodic actual-COGS ingest.** `ActualCogsIngestWorker` (analytics-api) pulls count-based actual COGS from inventory-api on a cadence (default 5 min), so **crew-web floor counts** reach the mart without a manager action. Ingest-only; the mart-refresh-worker refreshes `cost_variance_daily_mv` on its own throttled cadence.

Still open: a **ledger-based perpetual** actual COGS once ADR-0028 sales-depletion is live (this count-based lens then reconciles against it rather than being replaced).

## Consequences

- **Easy:** real yield variance *now*, with no Clover sales-depletion engine to build first; the standard method operators already trust; honest nulls everywhere; the metric joins the AI `get_metric` catalog automatically (ADR-0030).
- **Hard / risks:**
  - Data is **sparse** — variance exists only on count days, attributed to the closing date. The card/metric are window-grained, not daily.
  - Valuing past counts at **current** cost re-priced history if an item's cost was edited — **resolved** by the effective-dated cost history (see Update above).
  - **Crew-web (floor) counts** post straight to inventory-api and originally didn't trigger the pull — now **resolved** by the periodic ingest (see Update above); a Backoffice count still also syncs immediately.
  - Window theoretical uses **daily** `business_date` granularity, so a mid-day count is approximate at the window edges.
- **Future:** once ADR-0028 sales-depletion is live, a **ledger-based perpetual** actual COGS that this count-based lens reconciles against rather than replaces. (Effective-dated cost history + periodic ingest have shipped — see Update above.)

## Alternatives considered

- **Ledger-based actual COGS now (ADR-0028).** Rejected for v1: sales-depletion movements aren't populated, and shrink still requires counts. It is the long-term perpetual path, deferred until the depletion engine lands.
- **Build the sales-depletion engine first.** Much larger (Clover line-item → recipe BOM → `sale` deltas, refunds, modifiers). The theoretical side already exists; depletion is the keystone for `sold_today`/perpetual COGS, not the shortest path to yield variance.
- **Interpolate window COGS across its days.** Rejected: fabricates a daily precision the counts don't have. Between-count windows keep the number honest.
- **Persist per-count line detail instead of reconstructing on-hand from the ledger.** Rejected for v1: the append-only ledger already projects on-hand at any timestamp (`Σ delta`), so a separate snapshot table is redundant.
