import {
  loadMetricRegistry,
  resolveMetric,
  type MetricWindow,
} from "../analytics/metric-registry.js";
import type { DbPool } from "../db.js";

/**
 * GET /admin/api/costs?days=N — the bundled read for the Cost & Prime Cost
 * dashboard (ADR-0031, Phase 2). This handler holds NO口径: every figure is
 * resolved through the governed metric registry (ADR-0030) via resolveMetric,
 * so food cost %, gross margin, coverage, etc. all trace to the same vetted SQL
 * the AI's get_metric uses. The handler only ORCHESTRATES (which metrics, which
 * window) and bundles the results into one response.
 *
 * Labor + prime cost (Phase 4a, ADR-0033) ARE resolved here, but they trace to
 * mart.prime_cost_daily_mv where labor_cost is NULL until configured — so the
 * registry returns a null value (honest "not connected"), the handler never
 * fabricates one. Actual COGS + yield variance (ADR-0031, count-based) are resolved
 * the same way over mart.cost_variance_daily_mv: that MV is empty until a store has
 * counted twice, so the registry returns null and the page keeps its honest "not
 * connected" state — never a fabricated 0.
 */

// Period totals (one value each). resolveMetric picks each metric's base view:
// net_sales over sales_daily_mv; food cost over cost_daily_mv; labor + prime over
// prime_cost_daily_mv; actual cogs + yield variance over cost_variance_daily_mv.
// labor_cost_pct / prime_cost_pct resolve to null until dim_labor_cost is seeded;
// actual_cogs_cents / yield_variance_cents to null until a counted window exists.
const TOTAL_METRICS = [
  "food_cost_pct",
  "gross_margin_pct",
  "cost_coverage_pct",
  "food_cost_cents",
  "net_sales_cents",
  "labor_cost_pct",
  "prime_cost_pct",
  "labor_cost_cents",
  "actual_cogs_cents",
  "yield_variance_cents",
] as const;

export interface CostMetricValue {
  value: number | null;
  unit: string;
  definition: string;
  label: string;
}

export interface CostsResponse {
  days: number;
  metrics: Record<string, CostMetricValue>;
  /** gross_margin_pct resolved per business_date, for the trend chart. */
  marginTrend: { business_date: string; value: number | null }[];
  /**
   * food_cost_pct resolved per business_date — the real daily COGS-% series the
   * Inventory overview sparkline reads (replacing the former seeded cogs_trend,
   * ADR-0573). Sparse: only days with costed sales appear; null on a day with
   * none. Ratio (0..1), same as the food_cost_pct metric.
   */
  costTrend: { business_date: string; value: number | null }[];
}

function toNumber(value: unknown): number | null {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export async function costsSummary(
  pool: DbPool,
  merchantId: string,
  timezone: string,
  days: number,
): Promise<CostsResponse> {
  const registry = await loadMetricRegistry(pool);
  const window: MetricWindow = { mode: "days", days };

  const metrics: Record<string, CostMetricValue> = {};
  await Promise.all(
    TOTAL_METRICS.map(async (name) => {
      const def = registry.get(name);
      const result = await resolveMetric(pool, registry, name, {
        merchantId,
        timezone,
        window,
      });
      metrics[name] = {
        value: toNumber(result.rows[0]?.value),
        unit: result.unit,
        definition: result.definition,
        label: def?.label ?? name,
      };
    }),
  );

  const [marginRows, costRows] = await Promise.all([
    resolveMetric(pool, registry, "gross_margin_pct", {
      merchantId,
      timezone,
      window,
      dimensions: ["business_date"],
    }),
    resolveMetric(pool, registry, "food_cost_pct", {
      merchantId,
      timezone,
      window,
      dimensions: ["business_date"],
    }),
  ]);
  const marginTrend = marginRows.rows.map((row) => ({
    business_date: String(row.business_date),
    value: toNumber(row.value),
  }));
  const costTrend = costRows.rows.map((row) => ({
    business_date: String(row.business_date),
    value: toNumber(row.value),
  }));

  return { days, metrics, marginTrend, costTrend };
}
