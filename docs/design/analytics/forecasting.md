# Forecasting — Design

- **Status**: Draft (2026-06-02)
- **Owner**: @example-org
- **Decision**: [ADR-0032](../../decisions/0032-forecasting-compute-surface.md)
- **Roadmap phase**: 6
- **Touches**: a new forecast compute surface (own `forecast_*` table), `apps/analytics-api` marts (read), `packages/contracts` (forecast DTOs), `apps/backoffice-web/app/(authed)/forecast/`

> **One demand model, three products.** A single sales forecast feeds the forecast view, labor budgeting, and prep/par. Build the model once, off the read-only OLAP path, and serve its output as ordinary registered metrics so the AI and dashboards read it the same way they read everything else.

## Approach — self-built, lightweight first (owner Decision C)

Don't reach for a heavy ML stack on day one. Layered baseline:

1. **Seasonal profile** — average net sales / orders by `(weekday, local_hour)` from `sales_hourly_mv`. This alone is a respectable daypart forecast and is fully explainable.
2. **Level + trend** — exponential smoothing / seasonal decomposition (e.g. STL) on the daily series to capture the slow level and any trend.
3. **Known-event overrides** — a small calendar table for holidays / mall events the owner flags. (Weather can come later; start without external feeds.)

Forecast granularity: **daily and hourly (per daypart), per store**, 7–14 days out, with a prediction interval (the band the UI shows).

## Honest accuracy (non-negotiable)

- Quality is measured by **our own backtest**: hold out the last K weeks, forecast them, score **MAPE / WAPE**. Surface a permanent **"forecast vs actual"** card.
- **No vendor accuracy figure is ever displayed** (Lineup "35%", 5-Out "98%" — excluded; deep-research 2026-06-02). If we can't back a number with our own backtest, we don't show it.

## Architecture — off the read path

```
sales_hourly_mv / sales_daily_mv  ──read──►  [ forecaster job/process ]  ──write──►  forecast_* (own table)
                                                                                          │
                                              registered as metrics (ADR-0030):          ▼
                                              forecast_net_sales, forecast_orders  ──►  get_metric() / dashboards
```

The forecaster reads marts read-only and writes only its own table — **Iron Law 5 preserved** (the OLAP read model never becomes stateful). Whether it's a new job class in analytics-api or a small sidecar is an implementation choice; the invariant is the boundary, not the packaging.

## The three downstreams

1. **Sales-forecast view** (`/forecast`) — the curve + prediction band + the backtest card. Ships first; depends on nothing but sales history.
2. **Labor budget** — `forecast → target labor % → suggested hours per daypart`. A **draft** the manager edits; published schedules stay human-in-the-loop (industry norm). Depends on labor data (roadmap Phase 4).
3. **Prep / par** — `forecast × recipe BOM → suggested SKU par & prep quantities`, fed into inventory's 86 / recount flows. Depends on recipe BOMs ([ADR-0028](../../decisions/0028-sales-driven-inventory-depletion.md) Phase 3).

## Contracts (`packages/contracts`)

`ForecastPointSchema { merchant_id, business_date, local_hour?, metric, value, lo, hi }` and a `ForecastResponseSchema`. The AI may discuss forecasts only via these grounded metrics (the system-prompt "no forecasts" rule is lifted **for registered forecast metrics only**) — it never invents a forecast number.

## Acceptance

- A 7-day net-sales forecast renders with a prediction band, per store.
- A backtest card shows MAPE/WAPE on held-out weeks.
- No vendor accuracy figure anywhere; the only quality number is our backtest.
- Forecast values are reachable via `get_metric("forecast_net_sales", …)`.

## Ready-to-use design prompt

```text
Design apps/backoffice-web/app/(authed)/forecast/ + the forecast contracts per
docs/design/analytics/forecasting.md (UI + DTOs first; the compute surface follows).
Forecast = seasonal (weekday × local_hour) baseline + exponential smoothing / STL on
sales_hourly_mv, 7–14 days out, per store, with a prediction band. Show a permanent
"forecast vs actual" backtest card (MAPE/WAPE) and NEVER display a vendor accuracy
figure. Define ForecastPoint / ForecastResponse in packages/contracts. The forecaster
reads marts read-only and writes its own forecast_* table (Iron Law 5). Serve forecasts
as registered metrics (ADR-0030) so get_metric() and dashboards read them uniformly.
Then sketch the two downstreams (labor budget draft; prep/par = forecast × recipe BOM).
```
