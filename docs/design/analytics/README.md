# Analytics & AI Design Docs

Detailed feature specs for the analytics + AI-integration work. These are the **"how we build it"** companions to the decisions in [docs/decisions/0030–0032](../../decisions/) and the sequence in [docs/analytics-roadmap.md](../../analytics-roadmap.md).

- **Status**: Draft (set 2026-06-02, at the start of the build)
- **Owner**: @example-org
- **Grounded in**: a 2026-06-02 deep-research workflow (restaurant analytics benchmark + LLM-analytics architecture) + a three-stream codebase audit. Re-verify industry numbers before relying on them past 2026.

> **One governed fact layer, not a sprawl.** Every analytical conclusion — margin, prime cost, forecasts — is computed in `analytics-api` and exposed through **one metric registry**. Other services emit *raw facts* (inventory → plate cost, crm → loyalty events). The AI talks to the registry, not to a dozen services. This is the single idea the whole design serves; if a doc here drifts from it, the doc is wrong.

## The convergence picture

```
 inventory-api ──plate cost (HTTP contract)──┐
 (owns recipe→cost)                          ▼
 crm-api ──loyalty events──► [ analytics-api: the governed fact layer ]
                              raw → mart(fact/dim) → MV → dim_item_cost
                                          │
                              ┌───────────┴───────────┐
                              ▼                       ▼
                    metric registry            forecast surface
                    (resolveMetric)            (own forecast_* table)
                              │                       │
                              └───────────┬───────────┘
                                          ▼
                          get_metric()  ──►  AI assistant (grounded)
                          dashboards    ──►  Today / Menu / Costs / Forecast
```

## Index

| Doc | What it specs | Companion ADR | Roadmap phase |
|---|---|---|---|
| [ai-grounding-and-guardrails.md](ai-grounding-and-guardrails.md) | Metric registry shape, `resolveMetric`, `get_metric` tool, tiered routing, numeric guardrail, RAG, agentic insights, eval harness | [0030](../../decisions/0030-semantic-metric-registry-as-ai-grounding.md) | 0b, 3 |
| [menu-engineering-redesign.md](menu-engineering-redesign.md) | The revenue→margin axis fix; the correct Kasavana-Smith model; data flow; UI | [0031](../../decisions/0031-profitability-analytics-cost-dimension.md) | 1, 2 |
| [cost-and-prime-cost.md](cost-and-prime-cost.md) | KPI definitions, NRA bands, the cost dashboard, the two-COGS reconciliation | [0031](../../decisions/0031-profitability-analytics-cost-dimension.md) | 2, 4 |
| [forecasting.md](forecasting.md) | Model approach, backtest, the three downstreams, contracts | [0032](../../decisions/0032-forecasting-compute-surface.md) | 6 |

## House conventions for these docs

- **Numbers carry provenance.** Cite the NRA benchmark with its methodology; never cite a vendor accuracy figure.
- **Specs name real files.** Point at `mart.*` tables, `packages/contracts` schemas, `lib/ai/*` modules — so an implementer lands in the right place, and a reviewer can check drift.
- **Each doc states its boundary.** If a feature crosses an Iron Law, the doc says which, and which ADR + carve-out authorizes it.
