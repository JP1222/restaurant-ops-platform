# ADR-0032: A dedicated forecasting compute surface, off the read-only OLAP path

- **Status**: Accepted (2026-06-02 decision; implemented — `src/forecast/run.ts` compute surface, `mart.forecast_*` via migration 018, the `POST /admin/api/forecast/run` endpoint, and the `/forecast` backoffice page with the backtest MAPE/WAPE card. Periodic refresh is run on-demand today; a scheduled `forecast_refresh` job is the open follow-up. Status reconciled 2026-06-15.)
- **Date**: 2026-06-02
- **Deciders**: @example-org
- **Builds on**: [ADR-0002](0002-five-iron-laws.md) (Iron Law 5 — a read source is not a write source), [ADR-0030](0030-semantic-metric-registry-as-ai-grounding.md) (forecasts are served as registry metrics), [ADR-0028](0028-sales-driven-inventory-depletion.md) (prep/par consumes forecasts × recipe BOM).
- **Grounded in**: the 2026-06-02 deep-research + audit. Companion design: [forecasting.md](../design/analytics/forecasting.md).

## Context

Demand/sales forecasting is the **headline AI capability** of purpose-built restaurant analytics vendors — Lineup.ai (hourly/daily/weekly forecasts with weather/events/holidays) and 5-Out (forecast-driven labor budgets + prep/PO recommendations). All of them ingest POS data — the **same input shape the suite already has** (deep-research 2026-06-02; vendor accuracy figures were excluded as unverifiable, and must not be reproduced as benchmarks).

The suite has the history to forecast: `mart.sales_daily_mv` / `mart.sales_hourly_mv` (per-store, per-daypart, timezone-correct via Luxon). But the backoffice AI system prompt currently **forbids forecasts**, and there is no compute surface that produces them.

A single demand forecast feeds **three** downstreams — a sales-forecast view, labor budgeting (to a target labor %), and prep/par recommendations (forecast × recipe BOM). Build the model once.

Constraint: **analytics-api is read-only OLAP** (raw SQL + Luxon). Forecasting is model fitting + inference + a written-back prediction — a different workload. Hanging it inside the read pipeline would make a clean read model stateful; **Iron Law 5 protects exactly this** (a read source is not a write source).

## Decision

**Build a small, self-built forecasting surface that reads the analytics marts and writes forecasts to its own table — kept off the read-only OLAP path.**

1. **Self-built, lightweight model first** (owner Decision C, 2026-06-02). Baseline = daypart / day-of-week seasonal profile; layer simple time series (seasonal decomposition / exponential smoothing) on the `sales_hourly_mv` history. **No third-party forecasting vendor** (build-the-brain; avoids monthly cost, data egress, and low suite coupling — see the "build-the-brain, rent-the-rails" posture in [docs/design/loyalty/loyalty-system-design.md](../design/loyalty/loyalty-system-design.md)).
2. **Honest accuracy.** Forecast quality is measured by the suite's **own backtest** (MAPE/WAPE on held-out history) and surfaced as a "forecast vs actual" card. No vendor accuracy claims are ever displayed.
3. **Separate compute surface, not the read pipeline.** The forecaster runs as its own job/process that reads marts (read-only) and writes a `forecast_*` table it owns. Whether it lives as a new job class in analytics-api or a small sidecar is a roadmap implementation choice; the **invariant** is that it does not make the OLAP read path stateful.
4. **Forecasts are served as registry metrics ([ADR-0030](0030-semantic-metric-registry-as-ai-grounding.md)).** `forecast_net_sales`, `forecast_orders`, etc. are registered so dashboards and the AI `get_metric()` path read them uniformly. The AI may **discuss** forecasts (the system-prompt forbiddance is lifted) **only** via these grounded metrics — never by inventing numbers.
5. **Three downstreams, one model.** (a) sales-forecast view; (b) labor budget = forecast → target labor % → suggested hours per daypart, a **draft** (published schedules stay human-in-the-loop, matching industry practice); (c) prep/par = forecast × recipe BOM → suggested SKU par/prep, feeding inventory's 86 / recount flows.

## Consequences

- Adds the headline AI capability the suite lacks, reusing existing mart history; one model, three product surfaces.
- Keeps the OLAP read model clean: forecasting state is isolated to its own table/process; Iron Law 5 preserved.
- New responsibilities: model maintenance + a backtest harness + a retraining cadence. Forecasts are estimates with error bars, surfaced as such — never sold as exact.
- The labor and prep downstreams depend on labor data (roadmap Phase 4) and recipe BOMs ([ADR-0028](0028-sales-driven-inventory-depletion.md) Phase 3) respectively; the **sales-forecast view ships first**, independent of both.

## Alternatives considered

- **Integrate a third-party forecaster (Lineup.ai / 5-Out).** Rejected (owner Decision C): fast and accurate, but monthly cost, data egress, and low coupling to the suite; forecasting is "the brain" the suite wants to own.
- **Put forecasting inside analytics-api's read pipeline.** Rejected: it makes a read source a write/compute source (Iron Law 5) and pollutes the clean OLAP model. A separate surface that reads marts and writes its own table keeps the boundary.
- **Defer forecasting entirely until cost work lands.** Partially accepted as *sequencing* (the roadmap puts forecasting after COGS / prime-cost), but the decision + surface are recorded now so the system prompt's "no forecasts" rule and the missing compute surface are addressed **deliberately, not by accretion**.
