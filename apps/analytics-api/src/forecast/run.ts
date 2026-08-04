import type { DbPool } from "../db.js";
import { withTransaction } from "../db.js";
import { backtest, weekdaySeasonalForecast, type SeriesPoint } from "./model.js";

// The two demand series forecast in Stage 1. Both are columns on sales_daily_mv.
export const FORECAST_METRICS = ["net_sales_cents", "order_count"] as const;
export type ForecastMetric = (typeof FORECAST_METRICS)[number];

export interface ForecastBacktestSummary {
  metric: ForecastMetric;
  mape: number | null;
  wape: number | null;
  n: number;
}

export interface ForecastRunResult {
  merchantId: string;
  horizonDays: number;
  written: number;
  backtest: ForecastBacktestSummary[];
}

export interface ForecastRunOptions {
  horizonDays?: number;
  lookbackDays?: number;
  holdoutDays?: number;
}

const DEFAULT_HORIZON_DAYS = 14;
const DEFAULT_LOOKBACK_DAYS = 180;
const DEFAULT_BACKTEST_HOLDOUT_DAYS = 28;

interface DailyRow {
  business_date: string;
  net_sales_cents: string;
  order_count: string;
}

/**
 * Recompute and store the demand forecast for one store (ADR-0032). Reads recent
 * sales_daily_mv history (lookback relative to the store's latest data, so a store
 * whose data ends in the past still forecasts), runs the seasonal model + backtest for
 * each metric, and overwrites this merchant's forecast tables in one transaction.
 *
 * Iron Law 5: this only READS mart MVs and WRITES the forecaster's OWN tables.
 */
export async function runForecast(
  pool: DbPool,
  merchantId: string,
  options: ForecastRunOptions = {},
): Promise<ForecastRunResult> {
  const horizonDays = options.horizonDays ?? DEFAULT_HORIZON_DAYS;
  const lookbackDays = options.lookbackDays ?? DEFAULT_LOOKBACK_DAYS;
  const holdoutDays = options.holdoutDays ?? DEFAULT_BACKTEST_HOLDOUT_DAYS;

  const history = await pool.query<DailyRow>(
    `WITH bounds AS (
       SELECT max(business_date) AS max_date FROM mart.sales_daily_mv WHERE merchant_id = $1
     )
     SELECT business_date::text AS business_date, net_sales_cents, order_count
     FROM mart.sales_daily_mv, bounds
     WHERE merchant_id = $1
       AND bounds.max_date IS NOT NULL
       AND business_date > bounds.max_date - $2::int
     ORDER BY business_date ASC`,
    [merchantId, lookbackDays],
  );

  const series: Record<ForecastMetric, SeriesPoint[]> = {
    net_sales_cents: history.rows.map((r) => ({ date: r.business_date, value: Number(r.net_sales_cents) })),
    order_count: history.rows.map((r) => ({ date: r.business_date, value: Number(r.order_count) })),
  };

  const summaries: ForecastBacktestSummary[] = FORECAST_METRICS.map((metric) => {
    const result = backtest(series[metric], holdoutDays);
    return { metric, mape: result.mape, wape: result.wape, n: result.n };
  });

  let written = 0;
  await withTransaction(pool, async (client) => {
    // The model is stateless, so a fresh run supersedes the prior horizon wholesale
    // rather than leaving stale future dates behind.
    await client.query(`DELETE FROM mart.forecast_daily WHERE merchant_id = $1`, [merchantId]);

    for (const metric of FORECAST_METRICS) {
      for (const point of weekdaySeasonalForecast(series[metric], horizonDays)) {
        await client.query(
          `INSERT INTO mart.forecast_daily (merchant_id, target_date, metric, value, lo, hi)
           VALUES ($1, $2::date, $3, $4, $5, $6)`,
          [merchantId, point.target_date, metric, point.value, point.lo, point.hi],
        );
        written += 1;
      }

      const summary = summaries.find((s) => s.metric === metric)!;
      await client.query(
        `INSERT INTO mart.forecast_backtest (merchant_id, metric, mape, wape, sample_count, generated_at)
         VALUES ($1, $2, $3, $4, $5, now())
         ON CONFLICT (merchant_id, metric)
         DO UPDATE SET mape = EXCLUDED.mape, wape = EXCLUDED.wape,
                       sample_count = EXCLUDED.sample_count, generated_at = now()`,
        [merchantId, metric, summary.mape, summary.wape, summary.n],
      );
    }
  });

  return { merchantId, horizonDays, written, backtest: summaries };
}
