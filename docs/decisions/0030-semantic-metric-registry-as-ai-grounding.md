# ADR-0030: A governed metric registry is the AI grounding contract

- **Status**: Accepted (2026-06-02 — registry, `resolveMetric`, `get_metric`, tiered routing, numeric guardrail, `list_metrics` catalog, and the eval harness all landed across PRs #364/#367/#372/#377/#379 + the eval PR)
- **Date**: 2026-06-02
- **Deciders**: @example-org
- **Builds on**: [ADR-0011](0011-ai-tables-bounded-exception.md) (AI tables bounded exception), [ADR-0016](0016-app-setting-table.md) (`app_setting` — AI runtime config), [ADR-0017](0017-deepseek-replaces-codex.md) (DeepSeek assistant), [ADR-0012](0012-architecture-as-guardrails.md) (architecture as guardrails).
- **Grounded in**: the 2026-06-02 deep-research (restaurant analytics + LLM-analytics architecture) + codebase audit. Companion design: [docs/design/analytics/ai-grounding-and-guardrails.md](../design/analytics/ai-grounding-and-guardrails.md).

## Context

The backoffice AI assistant today (`apps/backoffice-web/lib/ai/`) is DeepSeek + 11 typed analytics tools (`lib/ai/tools.ts`) + a `run_sql_query` escape hatch that forwards to analytics-api `/admin/api/ai-sql`, sandboxed by `safe-query.ts` (SELECT/WITH only, `mart`/`meta` schemas only, 30s statement timeout, 500-row cap, every query logged to `audit.ai_query_log`). That sandbox is good **security** engineering.

Two structural gaps remain, and they are about **correctness**, not security:

- **KPI definitions are scattered.** The口径 of "net sales", "average ticket", etc. is hard-coded inside individual tool handlers and dashboard transforms — there is no single definition the dashboards, tools, and AI all share. analytics-api already ships a *nascent* semantic layer — `meta.metric_definitions` (`metric_name`, `business_definition`, `sql_expression`, `grain`) — but it is **documentation**, not an execution path.
- **The LLM can author SQL over raw marts.** `run_sql_query` lets the model write its own SQL against `mart.*`. Industry benchmarking (deep-research 2026-06-02) shows this is the failure mode that degrades accuracy and silently produces plausible-but-wrong numbers. There is no guardrail validating that the assistant's *prose* matches the numbers it fetched.

External grounding (deep-research, 2026-06-02): the dominant 2025–2026 pattern for an LLM-as-analytics-interface is a **governed semantic/metrics layer as the grounding contract** — agents ask for a metric *by name* and receive vetted SQL, instead of generating ad-hoc text-to-SQL per question. dbt's own reproducible benchmark had semantic-layer grounding beat raw text-to-SQL (`claude-sonnet-4-6` 90.0%→98.2%; `gpt-5.3-codex` 84.1%→100%), and dbt's guidance is to route **high-stakes numbers** (KPIs, reports, board) through the layer and reserve text-to-SQL for **ad-hoc exploration**. (Vendor-run benchmark — cite as directional, not a neutral law. The only methodology-solid number in the research corpus is the NRA food-cost benchmark, used in [ADR-0031](0031-profitability-analytics-cost-dimension.md).)

## Decision

**Promote `meta.metric_definitions` from documentation into an executable, governed metric registry inside analytics-api, and make it the AI's primary grounded query path.**

1. **Metric registry.** Each metric is a **dev-authored, vetted** definition: `{ name, label, measure (aggregated expression), base_view, grain, allowed_dimensions[], allowed_filters[], unit, format, definition (prose) }`. Engineers author them; the LLM never authors a metric. This table is the single source of truth for KPI口径 — the 11 typed tools' hard-coded SQL is migrated onto it so there is exactly one definition of "net sales".
2. **`resolveMetric(name, dimensions[], dateRange, filters)` executor.** Composes a **deterministic, parameterized** query from a registry entry — never free-form. It only emits `SELECT <measure> … FROM <base_view> GROUP BY <allowed dims> WHERE <date + allowed filters>`. Returns `{ rows, sql, definition }`. Execution reuses the existing `safe-query.ts` guards.
3. **`get_metric()` AI tool.** The assistant resolves KPIs by name through `resolveMetric`. The returned `sql` + `definition` are surfaced in the UI ("how was this computed?") for trust.
4. **Tiered routing.** The system prompt mandates: any number bound for a decision or report **must** come from `get_metric`; `run_sql_query` is reserved for exploratory, one-off, explicitly-non-authoritative queries and stays sandboxed (`safe-query.ts` unchanged).
5. **Numeric guardrail.** Before an assistant message is returned, a lightweight check verifies every number in the prose traces to a `get_metric`/tool result **from this turn**; unsourced numbers are flagged or trigger a re-answer. (Directional support: arXiv 2410.20024's "structured output + strict rules" thesis. Its *quantitative* claims were refuted in our adversarial verification, so the **mechanism** is adopted, the **numbers** are not cited.)
6. **Build, don't adopt.** The registry is self-built (a table + a composer). **Not** dbt MetricFlow (Apache-2.0 engine is free, but adopting dbt restructures a raw-SQL + Luxon pipeline into dbt models, and the serving/consumption APIs are paid) and **not** Cube.dev (another always-on service to run and monitor). Because the AI talks to `get_metric()` — an **interface** — a later swap to MetricFlow/Cube stays non-breaking.

## Consequences

- One source of truth for KPI口径: dashboards, tools, and AI answers resolve the same definition. A new metric is added in one place and becomes AI-answerable for free.
- The registry is the **contract that [ADR-0031](0031-profitability-analytics-cost-dimension.md) (margin / food-cost metrics) and [ADR-0032](0032-forecasting-compute-surface.md) (forecasts) plug into** — they register metrics; the AI answers about them with no new tool code.
- The LLM's *authoritative* surface narrows to vetted metrics; its free-SQL freedom is demoted to a labeled exploration mode. This is intentional: deeper AI integration means **more** governance of the authoritative path, not less.
- New maintenance burden: the registry must stay reasonably complete, or the AI falls back to text-to-SQL for unregistered questions. Mitigated by migrating existing tools onto it and by the guardrail flagging unsourced numbers.
- No change to the existing `safe-query.ts` sandbox, kill switch, rate limit, key handling (`app_setting`), or `audit.ai_query_log` — those stay as-is.

## Alternatives considered

- **Keep typed tools + free SQL (status quo).** Rejected:口径 stays scattered; no numeric guardrail; the free-SQL path is the documented accuracy-degrading failure mode for authoritative numbers.
- **Adopt dbt MetricFlow as the semantic layer.** Rejected for now: the engine is Apache-2.0/free, but adopting dbt means restructuring the pipeline into dbt models and the consumption APIs are paid — disproportionate for a single-merchant suite. Revisit if metric count or multi-tool consumption outgrows a self-built registry; the `get_metric()` interface makes the swap non-breaking.
- **Adopt Cube.dev.** Rejected for now: purpose-built headless-BI semantic layer, but another always-on service to operate (ops weight the suite minimizes). Same revisit clause.
- **Let the LLM write SQL, then verify with a second LLM pass.** Rejected as the *primary* mechanism: verification is probabilistic and costs latency/tokens; a deterministic registry is cheaper and stronger for the authoritative path. A verifier pass may still augment the *exploration* path.
