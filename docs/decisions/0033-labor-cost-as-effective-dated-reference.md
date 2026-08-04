# ADR-0033: Labor cost as an effective-dated reference dimension (prime cost, Phase 4a)

- **Status**: Accepted
- **Date**: 2026-06-03
- **Deciders**: @example-org
- **Builds on**: [ADR-0031](0031-profitability-analytics-cost-dimension.md) (the food leg — `dim_item_cost` / `cost_daily_mv`; its decision point 4 anticipated "prime cost = food% + labor% once labor lands, Phase 4" — this is that), [ADR-0030](0030-semantic-metric-registry-as-ai-grounding.md) (labor/prime register as governed metrics), [ADR-0002](0002-five-iron-laws.md) (Iron Laws 1 + 5), [ADR-0018](0018-multi-location-architecture.md) (labor is location-scoped).
- **Grounded in**: the 2026-06-02 deep-research + audit (companion design [cost-and-prime-cost.md](../design/analytics/cost-and-prime-cost.md)) and the operator fact that this store runs **two long-term employees with no external payroll or scheduling system**.

## Context

[ADR-0031](0031-profitability-analytics-cost-dimension.md) landed the **food** leg of profitability (theoretical COGS, food cost %, gross margin, coverage) and explicitly deferred **prime cost** — `food cost % + labor cost %` — to "once labor lands (Phase 4)." Prime cost is the single most-watched limited-service KPI (NRA *2025* limited-service prime-cost median **~65%** of sales; labor typically **~25–35%**). The Cost & Prime Cost dashboard (ADR-0031, Phase 2) already ships a Labor card and a Prime card in honest "not connected" states, waiting for this leg.

The open question was **where labor hours + wages live**, which determines how labor is ingested. The operator's answer: there is **no external employee/scheduling system**, and the store has **two long-term employees**. That reframes the problem:

- A timecard / payroll **ingest** (Clover Shifts, Homebase, 7shifts, ADP, Gusto) would be disproportionate machinery for a two-person shop with near-constant labor — and Clover's API exposes clock-in/out hours but **not reliably wages**, so even the "native" option wouldn't be self-sufficient.
- Labor cost here is **slow-changing reference data**, not a high-frequency event stream.

Boundary constraints (unchanged from ADR-0031):

- **Iron Law 1** — no cross-app DB-client import.
- **Iron Law 5** — analytics is read-only OLAP; it ingests external sources into **its own** mart, and **Backoffice never writes to analytics' DB**. So a Backoffice "edit wages" form cannot write labor straight into mart.

## Decision

**Model labor cost as an effective-dated reference dimension in analytics mart (`mart.dim_labor_cost`), structurally identical to plate cost ([ADR-0031](0031-profitability-analytics-cost-dimension.md)'s `dim_item_cost`) — not a timecard ingest. Compute `labor_cost_pct` and `prime_cost_pct` as ordinary single-base-view registry metrics over a pre-joined `prime_cost_daily_mv`. Defer the operator editing write-path to Phase 4b.**

1. **`mart.dim_labor_cost`** — effective-dated `(merchant_id, effective_from, daily_labor_cost_cents)`. **Merchant-scoped**, unlike brand-level plate cost: staffing and pay differ per location ([ADR-0018](0018-multi-location-architecture.md)). A wage change opens a new effective-dated row; the latest `effective_from <= business_date` wins, so past prime cost stays point-in-time correct. `daily_labor_cost_cents` is the all-in wage bill **modeled per operating day** (e.g. weekly bill ÷ days open); `NUMERIC`, because a weekly figure spread across days is sub-cent (same reasoning as `plate_cost_cents`).
2. **`mart.prime_cost_daily_mv`** extends `cost_daily_mv` with the labor leg via an effective-dated `LEFT JOIN LATERAL`. The cross-source join (sales + food + labor) happens **in the MV**, so `labor_cost_pct` and `prime_cost_pct` are the **same shape** as `food_cost_pct` — one aggregate over one base view, **no metric-composer change** — and register into the AI's `get_metric` catalog ([ADR-0030](0030-semantic-metric-registry-as-ai-grounding.md)) for free.
3. **Never-$0 invariant, extended to labor.** `labor_cost_cents` is **NULL (not 0)** on any day with no effective `dim_labor_cost` row, so `sum()` is NULL and `labor_cost_pct` / `prime_cost_pct` resolve to **null** — the dashboard renders honest "not connected" rather than a flatteringly-low number. `prime_cost_pct = (cogs + labor) / sales` inherits the NULL automatically: you cannot state prime cost without labor, and the SQL enforces it.
4. **Editing write-path deferred to Phase 4b.** Because analytics is read-only OLAP and Backoffice cannot write to it (Iron Law 5), the eventual "edit your labor rate in Backoffice" needs an **originating write service** — symmetric to ADR-0031's plate-cost flow (a write-source exposes labor over HTTP; analytics ingests it on a schedule into `dim_labor_cost`). Candidates (kds-api `AppSetting` / a small labor-config endpoint vs. db-inventory) are **not** decided here. Until then, `dim_labor_cost` is seeded directly from the operator's figures, and the metric stays **null-until-seeded**.

## Consequences

- Unlocks **prime cost** — the headline limited-service KPI — with **zero new ingest machinery** and **zero composer changes**. Every prime/labor figure traces to the metric registry, so provenance and AI grounding hold exactly as for the food leg.
- Reuses the `dim_item_cost` mental model: future readers reason about labor cost the same way they reason about plate cost (effective-dated reference the SQL joins against).
- For two stable employees, a modeled **daily** labor cost is a faithful, low-overhead representation — but it is **not shift-accurate**. If labor ever needs day-of-week or actual-hours precision, `dim_labor_cost` can gain a richer grain or be backed by a real ingest **without changing the metric contract**.
- Carries an explicit, documented debt: the **editing UI is deferred** (Phase 4b), and labor stays **null (honest)** until seeded. The first real prime-cost number requires the operator's wage figures.
- **Edge case:** if labor is configured only from a date inside the requested window, `labor_cost_pct` sums labor over days with a row while net sales spans **all** operating days → labor slightly understated for that partial window. Acceptable for a single past `effective_from`; flagged for Phase 4b.

## Alternatives considered

- **Timecard / payroll ingest (Clover Shifts, Homebase, 7shifts, ADP, Gusto).** Rejected for this operator: no external system, two long-term employees, near-constant labor; Clover exposes hours but not reliably wages. A connector is disproportionate machinery and an ongoing maintenance burden for a figure that barely moves.
- **Compute `labor_pct` in the Backoffice BFF** (fetch labor from a service, divide by analytics net sales). Rejected: bypasses the metric registry → not AI-queryable, no provenance, re-joins per request — the identical dead-end ADR-0031 rejected for food cost.
- **Backoffice writes labor straight into analytics mart.** Rejected: violates Iron Law 5 (analytics is read-only; Backoffice never writes to it). The write must originate in a write-source and be ingested — deferred to Phase 4b rather than crossing the boundary now.
- **Store labor in `db-inventory` / treat it as another inventory-emitted cost** (inventory already emits plate cost to analytics, ADR-0031). Considered, not chosen here: it is one valid home for the Phase 4b write-path, but presuming it now would pre-empt that decision.
- **Do nothing / leave prime cost uncomputable.** Rejected: prime cost is the most-watched limited-service KPI, and the dashboard already ships a Prime card waiting for it.
