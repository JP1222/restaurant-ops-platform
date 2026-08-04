import type { DbPool } from "../db.js";
import type { SyncJob } from "../scheduler/job-repository.js";
import type { JobMetrics } from "./shared.js";
import { runForecast } from "../forecast/run.js";

/**
 * Scheduled demand-forecast recompute (ADR-0032). Wraps the same `runForecast`
 * compute the `POST /admin/api/forecast/run` endpoint uses, so the nightly job and
 * the manual button share one code path. Iron Law 5: reads the sales marts, writes
 * only the forecaster's own `mart.forecast_*` tables.
 */
export async function runForecastRefreshJob(pool: DbPool, job: SyncJob): Promise<JobMetrics> {
  const result = await runForecast(pool, job.merchantId);
  return {
    rowsRead: 0,
    rowsWritten: result.written,
    dirtyWindowCount: 0,
    outputTables: ["mart.forecast_daily", "mart.forecast_backtest"],
    metadata: {
      horizonDays: result.horizonDays,
      backtest: result.backtest
    }
  };
}
