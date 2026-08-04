# AI Grounding & Guardrails — Design

- **Status**: Draft (2026-06-02)
- **Owner**: @example-org
- **Decision**: [ADR-0030](../../decisions/0030-semantic-metric-registry-as-ai-grounding.md)
- **Roadmap phases**: 0b (registry), 3 (grounding + guardrail)
- **Touches**: `apps/analytics-api/src/analytics/` (registry + `resolveMetric`), `apps/backoffice-web/lib/ai/` (tools, system prompt, guardrail), `meta.metric_definitions`

> **The AI's authoritative surface is a list of vetted metrics, not the SQL language.** The model picks a metric *by name* and a few dimensions from an allow-list; the SQL is composed deterministically by us. Free SQL still exists, but only as a labeled "exploration" mode that never produces a number we'd put in a report.

## Why (the gap this closes)

Today (`lib/ai/tools.ts`) the assistant has 11 typed tools with **hard-coded SQL** + a `run_sql_query` escape hatch over raw `mart.*`. Two problems: KPI口径 is duplicated across tool handlers (no single definition), and the model can author SQL for authoritative numbers — the failure mode that degrades accuracy (deep-research 2026-06-02: routing through a semantic layer beat raw text-to-SQL, `claude-sonnet-4-6` 90.0%→98.2%). And nothing checks that the assistant's prose matches the numbers it fetched.

## 1. The metric registry

Promote `meta.metric_definitions` from documentation into the execution contract. A metric is a **dev-authored** row:

```jsonc
{
  "name": "net_sales",              // stable id the AI references
  "label": "Net Sales",
  "measure": "SUM(net_sales_cents)",// aggregate over base_view (dev-authored, never LLM-authored)
  "base_view": "mart.sales_daily_mv",
  "grain": "merchant_id, business_date",
  "allowed_dimensions": ["business_date", "weekday", "year_month", "iso_week"],
  "allowed_filters": ["merchant_id", "business_date"],
  "unit": "cents",
  "format": "currency",
  "synonyms": ["revenue", "takings", "sales after refunds"],
  "definition": "Payments minus refunds, per business date, store-local."
}
```

Two metric kinds:

- **Base metric** — one `measure` over one `base_view` (e.g. `net_sales`, `order_count`).
- **Composite metric** — a formula over other metrics on a compatible grain (e.g. `avg_ticket = net_sales / order_count`; `food_cost_pct = food_cost / net_sales`). The composer resolves each leg and combines — so a ratio is defined **once**, not re-derived in five dashboards.

## 2. `resolveMetric()` — the deterministic composer

```
resolveMetric(name, { dimensions[], dateRange, filters, merchantId }) → { rows, sql, definition, unit }
```

It builds **only** this shape — never free SQL:

```sql
SELECT <dimensions>, <measure> AS value
FROM   <base_view>
WHERE  merchant_id = $1
  AND  business_date BETWEEN $2 AND $3
  [AND <allowed_filter> = $n ...]
GROUP BY <dimensions>
ORDER BY <dimensions>
```

Rules that make it safe by construction:

- `name` must exist in the registry; otherwise reject.
- Every requested dimension ∈ `allowed_dimensions`; every filter key ∈ `allowed_filters`. Anything else → reject (no column names from the model ever reach SQL).
- The `measure` expression is dev-authored and fixed per metric — the model cannot change it.
- Execution reuses the existing `safe-query.ts` guards (statement timeout, row cap, `audit.ai_query_log`).
- Returns the composed `sql` + `definition` so the UI can show **"how was this computed?"**.

**Note — the registry is the canonical口径 source, not a handler rewrite.** The 11 backoffice tools (`lib/ai/tools.ts`) are thin BFF wrappers over analytics endpoints; the real口径 lives in `analytics-api`'s `dashboard.ts` handlers, which return **rich multi-metric payloads** (a daily sales row carries 7 metrics; totals span today/7d/30d windows) that `resolveMetric`'s single-metric composer **cannot byte-reproduce**. So 0b does **not** rewrite those handlers (the original "migrate the handlers, byte-identical" framing was infeasible — corrected 2026-06-02). Instead the registry is the canonical definition, exposed via `POST /admin/api/metric` (0b-2) and consumed by the new `get_metric` tool (0b-3); the dashboards keep their handlers. Consolidating them onto the registry later is possible only if `resolveMetric` grows a multi-metric mode — out of scope here.

## 3. Tiered routing (the high-stakes vs ad-hoc split)

System-prompt contract (`lib/ai/system-prompt.ts`):

- **`get_metric(name, dimensions, date_range, filters)`** — the grounded path. **Any number bound for a decision or report MUST come from here.**
- **`run_sql_query`** — exploration only: one-off, non-authoritative, "poke around" questions. Stays sandboxed (unchanged). The prompt states plainly: *do not use raw SQL for a number you would put in a report — use `get_metric`.*

This mirrors dbt's published guidance (route board/KPI/report numbers through the layer; reserve text-to-SQL for discovery).

## 4. Numeric guardrail

Before an assistant message is persisted/returned (`app/api/ai/chat/route.ts`), run a lightweight post-check:

1. Extract candidate numbers from the draft prose (currency, %, counts).
2. For each, confirm it traces to a `get_metric`/tool result **from this turn** (allowing for rounding/format).
3. If a number has no source → either annotate it ⚠️ ("unverified") or trigger one re-answer that forces a `get_metric` call.

This is cheap and deterministic. (Directional support only: arXiv 2410.20024's "structured output + strict rules" thesis survived verification; its *numbers* did not — so we adopt the mechanism, not its stats.)

## 5. Metric selection (RAG over definitions)

The research's honest caveat: a semantic layer fixes *computation*, but the model still has to pick the **right metric name**. Help it: embed each registry entry's `label + synonyms + definition` and retrieve the top-k candidates for the user's question, injected into context. This is RAG over **metric metadata**, not over raw business rows — small, cheap, and it directly attacks the residual error mode.

## 6. Agentic insights (replace threshold rules — carefully)

Today's insights (`lib/insights/rules.ts`) are deterministic thresholds. Upgrade path: an insight agent that **proposes** hypotheses ("refunds look high Tuesday") → **verifies** each by calling `get_metric` → reports **only** verified ones, each with its grounding number. The numeric guardrail makes this safe; without it, an "insight" is just a confident guess. Keep the rule engine as the cheap always-on tier; layer the agent on top for the narrative.

## 7. Evaluation harness (so we can tell if a change helped)

A golden set of `{ question → expected metric(s) + expected value (computed deterministically) }`. On any prompt/model change, run the set and score: did the AI call the right metric, and did its stated number match? This mirrors dbt's own benchmark method and turns "the AI feels better" into a number. Store the set under `apps/backoffice-web/lib/ai/eval/`.

## Build order (within the phases)

1. **0b-1** — extend `meta.metric_definitions`; build `composeMetricSql` + `resolveMetric`; **no AI change** (✅ PR #364).
2. **0b-2** — `POST /admin/api/metric` (resolveMetric over HTTP): the grounded read path the `get_metric` tool calls. Additive; no handler rewrite.
3. **0b-3** — add `get_metric` in `lib/ai/tools.ts`; tighten the system prompt (tiered routing); add the numeric guardrail; add metric-selection RAG; stand up the eval set. Agentic insights follow once the guardrail is trusted.

## Ready-to-use design prompt

```text
Implement the metric registry + resolveMetric() in apps/analytics-api per
docs/design/analytics/ai-grounding-and-guardrails.md §1–2. Extend
meta.metric_definitions with: measure, base_view, allowed_dimensions[],
allowed_filters[], unit, format, synonyms[]. Build resolveMetric(name, opts)
that composes ONLY the SELECT…GROUP BY shape in §2, rejecting any dimension or
filter outside the allow-lists, reusing safe-query.ts guards, and returning
{rows, sql, definition, unit}. Then expose it as POST /admin/api/metric for the
get_metric tool (0b-3) to call. Do NOT rewrite the rich dashboard handlers —
they return multi-metric payloads resolveMetric can't byte-reproduce — and do
NOT change AI behavior in these PRs.
```
