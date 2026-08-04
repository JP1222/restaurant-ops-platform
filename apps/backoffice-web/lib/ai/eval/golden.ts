/**
 * Golden Q&A set for the AI analytics assistant (ADR-0030, Phase 0b-3b eval).
 *
 * Each case encodes what a *good* answer looks like at the routing level: which
 * tool the model should reach for, and (for get_metric) which registry metric
 * name it should request. The scorer (./score.ts) grades a transcript against
 * these; the runner (./run.ts) produces transcripts from the live model.
 *
 * Keep cases unambiguous — one clearly-correct tool/metric each — so a failure
 * means the model genuinely mis-routed, not that the question was vague. Metric
 * names must match the seeded registry (migration 010).
 */

export interface GoldenCase {
  id: string;
  question: string;
  /** The tool the model should call to answer this. */
  expectTool: "get_metric" | "list_metrics" | "run_sql_query";
  /** For get_metric cases: the registry metric name it should request. */
  expectMetric?: string;
  /** If true, the final answer must be fully grounded (no unsourced figures). */
  mustBeGrounded?: boolean;
  note?: string;
}

export const GOLDEN_CASES: GoldenCase[] = [
  {
    id: "net-sales-week",
    question: "What were our net sales over the last 7 days?",
    expectTool: "get_metric",
    expectMetric: "net_sales_cents",
    mustBeGrounded: true,
  },
  {
    id: "orders-last-week",
    question: "How many orders did we get last week?",
    expectTool: "get_metric",
    expectMetric: "order_count",
    mustBeGrounded: true,
  },
  {
    id: "avg-ticket-month",
    question: "What's our average ticket this month?",
    expectTool: "get_metric",
    expectMetric: "avg_ticket_cents",
    mustBeGrounded: true,
  },
  {
    id: "refund-rate-30d",
    question: "What's our refund rate over the last 30 days?",
    expectTool: "get_metric",
    expectMetric: "refund_rate",
    mustBeGrounded: true,
  },
  {
    id: "cash-sales-week",
    question: "How much did we take in cash over the last week?",
    expectTool: "get_metric",
    expectMetric: "cash_sales_cents",
    mustBeGrounded: true,
  },
  {
    id: "catalog-discovery",
    question: "What metrics can you pull for me?",
    expectTool: "list_metrics",
    note: "Should surface the catalog rather than guess a metric.",
  },
];
