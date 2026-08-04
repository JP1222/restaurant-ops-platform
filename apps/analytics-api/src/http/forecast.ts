import type { IncomingMessage, ServerResponse } from "node:http";

import type { AppConfig } from "../config.js";
import type { DbPool } from "../db.js";
import { runForecast } from "../forecast/run.js";
import { enforceTenantScope } from "../lib/tenant-auth.js";
import { isAdminAuthorized } from "./admin.js";
import { respondJson } from "./health.js";

/**
 * POST /admin/api/forecast/run — recompute and store the demand forecast for a store
 * (ADR-0032). On-demand trigger (the "Generate" button); the scheduler also runs this
 * same compute daily via the `forecast_refresh` job. The forecaster reads the sales
 * marts and writes only its own forecast tables (Iron Law 5).
 */
export async function handleAdminForecastRun(
  req: IncomingMessage,
  res: ServerResponse,
  pool: DbPool,
  config: AppConfig,
  url: URL,
) {
  if (!isAdminAuthorized(req, config)) {
    return respondJson(res, 401, { error: "unauthorized" });
  }
  const merchantId = url.searchParams.get("merchant_id") ?? config.cloverMerchantId;
  if (!merchantId) {
    return respondJson(res, 400, { error: "merchant_id is required" });
  }

  // Multi-tenant (ADR-0818 Phase 2c): no-op when MULTITENANT_MODE=off.
  const scope = await enforceTenantScope(req, pool, config, merchantId);
  if (!scope.ok) {
    return respondJson(res, scope.status, { error: scope.error });
  }

  try {
    const result = await runForecast(pool, merchantId);
    return respondJson(res, 200, result);
  } catch (error) {
    return respondJson(res, 502, {
      error: "forecast_run_failed",
      message: error instanceof Error ? error.message : "forecast run failed",
    });
  }
}

export interface ForecastReadPoint {
  target_date: string;
  metric: string;
  value: number;
  lo: number;
  hi: number;
}

export interface ForecastReadBacktest {
  metric: string;
  mape: number | null;
  wape: number | null;
  sample_count: number;
}

export interface ForecastReadResponse {
  points: ForecastReadPoint[];
  backtest: ForecastReadBacktest[];
  /** When the stored forecast was generated, or null if none has been run yet. */
  generated_at: string | null;
}

function toNumber(value: unknown): number | null {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * GET /admin/api/forecast — read the stored forecast curve + the model's own backtest
 * for a store. Empty (points: []) until a run has populated the tables.
 */
export async function forecastRead(pool: DbPool, merchantId: string): Promise<ForecastReadResponse> {
  const [points, backtests] = await Promise.all([
    pool.query<{
      target_date: string;
      metric: string;
      value: string;
      lo: string;
      hi: string;
      generated_at: string;
    }>(
      `SELECT target_date::text AS target_date, metric, value, lo, hi, generated_at::text AS generated_at
       FROM mart.forecast_daily
       WHERE merchant_id = $1
       ORDER BY metric, target_date`,
      [merchantId],
    ),
    pool.query<{ metric: string; mape: string | null; wape: string | null; sample_count: string }>(
      `SELECT metric, mape, wape, sample_count
       FROM mart.forecast_backtest
       WHERE merchant_id = $1`,
      [merchantId],
    ),
  ]);

  return {
    points: points.rows.map((row) => ({
      target_date: row.target_date,
      metric: row.metric,
      value: Number(row.value),
      lo: Number(row.lo),
      hi: Number(row.hi),
    })),
    backtest: backtests.rows.map((row) => ({
      metric: row.metric,
      mape: toNumber(row.mape),
      wape: toNumber(row.wape),
      sample_count: Number(row.sample_count),
    })),
    generated_at: points.rows[0]?.generated_at ?? null,
  };
}
