# Analytics & AI-Integration Roadmap

> Orientation doc for anyone (human or AI) picking up the analytics + AI work.
> Decisions live in [ADR-0030](decisions/0030-semantic-metric-registry-as-ai-grounding.md)
> (metric registry / AI grounding), [ADR-0031](decisions/0031-profitability-analytics-cost-dimension.md)
> (profitability / cost dimension), and [ADR-0032](decisions/0032-forecasting-compute-surface.md)
> (forecasting surface). Detailed feature specs live in [docs/design/analytics/](design/analytics/).
> This file is the narrative + sequence + acceptance criteria that ties them together.
>
> Grounded in a 2026-06-02 deep-research (restaurant analytics benchmark + LLM-analytics
> architecture) + a three-stream codebase audit. Industry numbers decay — re-verify the NRA
> benchmark and any vendor capability before relying on it past 2026.

## TL;DR — the north star

Make **`analytics-api` the single governed analytics fact layer**. Cost, margin, labor, forecasts, and the metric/semantic layer all converge there; the other services emit **raw facts** (inventory → plate cost, crm → loyalty events), not analytical conclusions. "AI deep integration" then means the AI connects to **one governed metric layer**, not to a sprawl of services plus free-form SQL.

Two truths the audit established, so we don't relitigate them:

- **The engine底子 is strong.** Proper `raw → mart(fact/dim) → MV` dimensional model; incremental pipeline with dirty-window tracking + 3-source priority (webhook > REST > export) + Export reconciliation; a real AI assistant (DeepSeek, 11 typed tools, sandboxed SQL, kill switch, audit log); a nascent semantic layer (`meta.metric_definitions`).
- **The gaps are almost all on the cost & prediction side.** No COGS / margin / prime cost; "menu engineering" plots revenue not margin (a correctness bug); no labor analytics; no forecasting; threshold-rule insights rather than statistical; and the AI has no numeric-hallucination guardrail.

## The benchmark we anchor to

The only methodology-disclosed number in the research corpus (NRA *2025 Restaurant Operations Data Abstract*, median, n>900, FY2024). Example Kitchen is **limited-service** (counter-service parlor), so:

| KPI | Target band (limited-service median) |
|---|---|
| Food + non-alc beverage cost % of sales | **32.4%** |
| Prime cost (food % + labor %) | **~65%** |

Vendor forecasting/accuracy stats (Lineup.ai "35% more accurate", 5-Out "98%") were **deliberately excluded** — no disclosed methodology. We never display a vendor accuracy figure; forecast quality is our own backtest only.

## The three decisions (locked 2026-06-02)

The owner stated "not afraid of big changes" and delegated A + B; C was chosen explicitly.

| # | Decision | Choice | ADR |
|---|---|---|---|
| **A** | Where does the COGS / margin join live? | Cost becomes an **analytics dimension** (`mart.dim_item_cost`). inventory-api exposes **plate cost**; analytics computes margin. inventory owns "what it costs", analytics owns "profitability". | [0031](decisions/0031-profitability-analytics-cost-dimension.md) |
| **B** | What implements the semantic layer? | **Self-built lightweight metric registry** (promote `meta.metric_definitions` + a `resolveMetric()` executor). Not dbt / not Cube — the `get_metric()` interface keeps a later swap cheap. | [0030](decisions/0030-semantic-metric-registry-as-ai-grounding.md) |
| **C** | How is forecasting built? | **Self-built lightweight** (daypart baseline + simple time series; own backtest). New compute surface, off the read-only OLAP path. | [0032](decisions/0032-forecasting-compute-surface.md) |

## Sequence (by phase)

Ordered by **dependency unlock**, not by effort. Each phase is one or more PRs. "Boundary" flags whether it crosses an Iron Law (and therefore needs the ADR + a machine-checked carve-out, per [ADR-0012](decisions/0012-architecture-as-guardrails.md)).

| Phase | What | Unlocks | Boundary | Acceptance |
|---|---|---|---|---|
| **0a** | These ADRs + this roadmap + the design docs | The guardrail itself | docs | ADRs merged; `pnpm docs:check` green |
| **0b-1** | Metric registry: `meta.metric_definitions` → executable columns + `composeMetricSql`/`resolveMetric` | One source of truth for KPI口径; the contract 0031/0032 plug into | analytics-internal | ✅ registry loads; `resolveMetric` matches a direct query (PR #364) |
| **0b-2** | `POST /admin/api/metric` — `resolveMetric` over HTTP (the grounded read path) | The backend `get_metric` calls; **no handler rewrite** | analytics-internal | endpoint resolves a named metric; `parseMetricRequest` validated |
| **0b-3** | `get_metric` tool + BFF `/api/ai/metric` route + tiered-routing system prompt (backoffice) | AI resolves KPIs via the registry, not free SQL | web/`lib/ai` | KPIs answerable via `get_metric`; `run_sql_query` demoted to exploration-only |
| **0b-3b** | ✅ Numeric guardrail backend (PR #377) + metric-selection `list_metrics` (PR #379) + eval harness (golden set + pure scorer + offline runner) | Hallucination-resistant, measurable AI → **ADR-0030 Accepted** | web/`lib/ai` | guardrail flags unsourced figures; `list_metrics` catalog; scorer unit-tested. Remaining: the `⚠ unverified figures` badge UI = design Part 3 |
| **1** | `PlateCostSnapshot` contract + inventory `GET /api/recipes/plate-costs` + analytics ingest → `mart.dim_item_cost` | Cost data in the sales query space | **cross-service** (0031) | a known item's plate cost appears in `dim_item_cost`, effective-dated |
| **2** | Margin / food-cost % metrics registered; **fix menu engineering (margin axis)**; cost & prime-cost dashboard (labor card stubbed) | Correct menu engineering; food cost % vs NRA band | analytics + web | a low-margin/high-revenue item moves from Star → Plowhorse; food cost % card renders with the 32.4% band |
| **3** | AI `get_metric()` grounding + tiered routing + numeric guardrail | Hallucination-resistant AI answers on KPIs | web/`lib/ai` | every dashboard KPI answerable via `get_metric`; an unsourced number in a reply is flagged |
| **4** | Clover timecards ingest → labor % → **prime cost** | The headline restaurant KPI completes | analytics | prime cost = food % + labor %, vs the ~65% band |
| **5** | Statistical depth (percentiles, statistical anomaly) + void/comp/discount loss view + guest RFM cohorts | Depth + loss prevention + retention | analytics + web (crm via HTTP) | median/p90 ticket; void anomaly by employee×reason; RFM quintiles |
| **6** | Self-built forecast surface + forecast view; then labor-budget & prep/par downstreams | Demand forecasting (the missing AI headline) | new compute surface (0032) | a 7-day forecast renders with a backtest MAPE card |
| **7** | Cross-store roll-up (multi-merchant query scope + consolidated KPIs) | "All stores" reporting | analytics (reuse [0018](decisions/0018-multi-location-architecture.md)) | a metric resolves across `merchant_id IN (…)`; waits for a real store #2 |

## Status snapshot (as of 2026-06-15)

The sequence table above is the *original* plan (2026-06-02). Reconciling it with what
has since shipped:

- ✅ **Phases 0a–3 — shipped.** Metric registry + `resolveMetric` + `POST /admin/api/metric`
  + `get_metric` + numeric guardrail ([ADR-0030](decisions/0030-semantic-metric-registry-as-ai-grounding.md)
  Accepted); cost dimension `mart.dim_item_cost`, `cost_daily_mv`, the margin metrics, and the
  menu-engineering margin-axis fix ([ADR-0031](decisions/0031-profitability-analytics-cost-dimension.md));
  the `/today`, `/trends`, `/costs`, `/compare`, `/dayparts`, `/menu` backoffice surfaces.
- ✅ **Phase 4 — compute path shipped, awaits live data.** `mart.dim_labor_cost` +
  `prime_cost_daily_mv` + the labor/prime-cost metrics + the `/costs` cards exist; the labor and
  prime cards stay in an honest "not connected" state until live labor data is ingested.
- ✅ **Phase 6 — forecast shipped (on-demand).** `src/forecast/run.ts` + `mart.forecast_*` +
  `/forecast` page with a backtest card ([ADR-0032](decisions/0032-forecasting-compute-surface.md)).
  **Open follow-up:** no scheduled refresh — it only recomputes when an operator clicks "Generate".
- 🚧 **Phase 5 — not started (the real depth gap).** No percentile/statistical-anomaly metrics,
  no void/comp/discount loss view, and **no guest RFM / loyalty analytics** despite `crm-api`
  holding the loyalty ledger. This is the largest remaining *feature* gap.
- ⬜ **Phase 7 — deferred** until a real store #2 exists (unchanged).

**Active follow-up backlog** (smaller items the phase table doesn't track):

1. **Scheduled `forecast_refresh` + `data_quality_check` jobs** — both compute paths exist but only
   run on manual trigger; add scheduler rules so they run nightly/daily.
2. **Cost-coverage nudge** — food-cost % and the menu quadrant are gated on plate-cost coverage;
   surface the coverage gap + a deep link to the recipe editor so operators can close it.
3. **Honest Hub labels** — the `/hub` landing page hard-codes KDS / customer-display / webhook
   status; wire them or relabel as static (never fake a "live" tone).

## Invariants — the guardrails against drift

If a future change violates one of these, stop and write a new ADR — don't quietly cross it.

1. **analytics-api stays read-only OLAP** (Iron Law 5). It ingests external sources into its own mart; it never writes another service's DB. The forecaster ([ADR-0032](decisions/0032-forecasting-compute-surface.md)) writes only its own `forecast_*` table.
2. **No cross-app DB import** (Iron Law 1). Cost and loyalty data reach analytics over **HTTP contracts** in `packages/contracts`, never via `db-inventory` / `db-crm`.
3. **inventory owns cost, analytics owns profitability.** Plate cost has one source of truth (inventory). The two COGS lenses (actual-depletion vs theoretical-from-sales) are reconciled as **yield variance**, never duplicated into two conflicting "official" numbers.
4. **The metric registry is the authoritative AI path.** Authoritative numbers resolve through `get_metric`; `run_sql_query` is exploration-only and stays sandboxed. Deeper AI integration tightens this, it does not loosen it.
5. **No vendor accuracy figures, ever.** Forecast quality is our own backtest; cost benchmarks cite the NRA with its methodology.
6. **Costs are effective-dated; margins are point-in-time correct.** Never default an unknown plate cost to 0 — that mislabels items as Stars.
7. **Don't rewrite the rich dashboard handlers onto `resolveMetric`.** `dashboard.ts` handlers return multi-metric payloads (a daily row = 7 metrics; totals span today/7d/30d) that the single-metric composer can't byte-reproduce. The registry is the口径 source + the AI path (`get_metric`), exposed via `/admin/api/metric` — *additive*, alongside the handlers. Consolidation is possible only if `resolveMetric` gains a multi-metric mode; until then, leave the handlers be.

## Explicitly deferred (by design, not omission)

- **Cross-store consolidation** (Phase 7) waits for a real second store — the model is ready (`merchant_id` on every row), the data isn't.
- **Modifier-level COGS** follows [ADR-0028](decisions/0028-sales-driven-inventory-depletion.md) Phase 4; item-level plate cost ships first.
- **Multi-location RBAC** (per-store staff scoping) follows [ADR-0029](decisions/0029-federated-rbac-and-auth-lifecycle.md) enforcement; not an analytics blocker.
- **Adopting dbt / Cube** is a revisit-if-we-outgrow-it option, not a current step (the `get_metric()` interface keeps the door open).
