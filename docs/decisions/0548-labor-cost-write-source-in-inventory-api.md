# ADR-0548: Labor-cost write-source is inventory-api (prime cost, Phase 4b)

- **Status**: Accepted
- **Date**: 2026-06-05
- **Deciders**: @example-org
- **Builds on**: [ADR-0033](0033-labor-cost-as-effective-dated-reference.md) (modeled labor as an effective-dated reference dimension `mart.dim_labor_cost` and **explicitly deferred the operator write-path to Phase 4b — this ADR is that decision**), [ADR-0031](0031-profitability-analytics-cost-dimension.md) (the symmetric plate-cost ingest this mirrors; it named db-inventory "one valid home" for labor), [ADR-0002](0002-five-iron-laws.md) (Iron Laws 1 + 5), [ADR-0018](0018-multi-location-architecture.md) (location scoping).

## Context

[ADR-0033](0033-labor-cost-as-effective-dated-reference.md) landed the labor leg of prime cost as a mart dimension (`mart.dim_labor_cost`), the `prime_cost_daily_mv` join, and the registered `labor_cost_pct` / `prime_cost_pct` metrics — but left labor **NULL until seeded** and recorded its decision point 4 as: *"the eventual 'edit your labor rate in Backoffice' needs an originating write service … candidates (kds-api `AppSetting` / a small labor-config endpoint vs. db-inventory) are not decided here."*

So the Cost dashboard has shipped a Labor % card and a Prime cost card in honest "not connected" states, waiting for exactly one thing: a place for the operator's wage figure to land that analytics can ingest. This ADR picks that place.

Boundary constraints (unchanged):

- **Iron Law 5** — analytics-api is read-only OLAP; Backoffice never writes its mart. The write must originate elsewhere and be **pulled** by analytics, exactly like plate cost.
- **Iron Law 1** — no cross-app DB-client import; the cross-service hop is HTTP + a `packages/contracts` DTO.

## Decision

**The labor-cost write-source is `inventory-api`, via a new effective-dated `inventory_labor_costs` table — structurally identical to how inventory-api already exposes plate cost ([ADR-0031](0031-profitability-analytics-cost-dimension.md)).**

1. **`packages/db-inventory` gains `inventory_labor_costs`** — `(location_id, effective_from)` PK, `daily_labor_cost_cents` (Float, sub-cent), `currency`, `note`. Effective-dated, so a wage change opens a new row and historical prime cost stays point-in-time correct.
2. **inventory-api exposes two routes.** `GET /api/labor-costs` is an **open read** (like `GET /api/recipes/plate-costs`) that analytics pulls with no bearer; `PUT /api/admin/labor-costs` is **bearer-only** (the existing `/api/admin` guard — a crew cook can never set labor cost). The Backoffice editor writes through the latter.
3. **`merchant_id` is stamped server-side, not supplied by the browser.** The read endpoint maps each location to the store's configured Clover merchant id — the key `mart.dim_labor_cost` joins on. This is required because the single-store dashboard **read** defaults to that same env merchant (`resolveAnalyticsMerchantId()` returns `undefined` → analytics uses `CLOVER_MERCHANT_ID`); stamping the write the same way guarantees the row lands where the read looks.
4. **analytics-api ingests it unchanged from the plate-cost shape** — `fetchLaborCosts` → `ingestLaborCosts` upserts `mart.dim_labor_cost` on `(merchant_id, effective_from)`, then refreshes `prime_cost_daily_mv` so the cards light up on the operator's next load. A new `POST /admin/api/sync-labor-costs` triggers it; the periodic mart-refresh-worker is the fallback.

## Consequences

- Completes prime cost — the headline limited-service KPI — with **zero new infrastructure**: it reuses the proven plate-cost pull pattern, the existing `/api/admin` bearer guard, the existing MV-refresh batch, and the existing metric registry. No new service, no payroll connector.
- inventory-api now holds two opposite batch read contracts with analytics (plate cost out, sales line-items in — [ADR-0028](0028-sales-driven-inventory-depletion.md)) plus this one. The mental model is uniform: inventory owns cost *inputs*, analytics owns *profitability*.
- Carries one documented multi-location debt: the read maps **every** location to the one configured merchant (single-merchant today). Per-location merchant mapping is the multi-location follow-up — the same "model ready, data isn't" posture as the rest of the suite ([ADR-0018](0018-multi-location-architecture.md)).
- Labor stays **NULL-until-seeded** ([ADR-0033](0033-labor-cost-as-effective-dated-reference.md)'s never-fabricate invariant holds): the first real prime-cost number still requires the operator entering a wage figure.

## Alternatives considered

- **kds-api `app_setting` row ([ADR-0016](0016-app-setting-table.md)).** Reuses the existing settings infra with no new table, and is location-scoped. Rejected: `app_setting` is a single current value, **not effective-dated history** — a wage change would retroactively rewrite every past day's prime cost, breaking the point-in-time correctness that is the whole reason [ADR-0033](0033-labor-cost-as-effective-dated-reference.md) chose an effective-dated dimension. Encoding an effective-dated array inside one setting JSON would reinvent the table awkwardly.
- **A dedicated tiny labor-config service / endpoint.** Rejected: disproportionate machinery for one slow-changing number when inventory-api is already an analytics write-source with the exact plate-cost pattern to copy.
- **Backoffice writes `mart.dim_labor_cost` directly.** Rejected: violates Iron Law 5 (analytics is read-only; Backoffice never writes its mart) — the same dead-end [ADR-0033](0033-labor-cost-as-effective-dated-reference.md) already ruled out.
- **Do nothing / keep labor deferred.** Rejected: the backend has been complete since [ADR-0033](0033-labor-cost-as-effective-dated-reference.md); only this write-path stood between the operator and a live prime-cost number.
