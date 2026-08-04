import type { IncomingMessage, ServerResponse } from "node:http";

import { z } from "zod";

import { loadMetricRegistry } from "../analytics/metric-registry.js";
import { metricStats, MIN_BASELINE_DAYS } from "../analytics/metric-stats.js";
import type { AppConfig } from "../config.js";
import type { DbPool } from "../db.js";
import type { SyncTargetsReader } from "../sync-targets/repository.js";
import { enforceTenantScope } from "../lib/tenant-auth.js";
import { isAdminAuthorized } from "./admin.js";
import { readJsonBody, respondJson } from "./health.js";

const METRIC_STATS_MAX_BODY_BYTES = 4 * 1024;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DEFAULT_DAYS = 90;

const MetricStatsRequestSchema = z.object({
  name: z.string().min(1).max(120),
  // A baseline needs at least MIN_BASELINE_DAYS history PLUS the as-of day.
  days: z
    .number()
    .int()
    .min(MIN_BASELINE_DAYS + 1)
    .max(365)
    .optional(),
  as_of: z.string().regex(ISO_DATE).optional(),
});

export type MetricStatsRequest = z.infer<typeof MetricStatsRequestSchema>;

/** Pure: validate a parsed JSON body into a MetricStatsRequest (throws on bad shape). */
export function parseMetricStatsRequest(body: unknown): MetricStatsRequest {
  return MetricStatsRequestSchema.parse(body);
}

/**
 * POST /admin/api/metric-stats — position a named registry metric's as-of day
 * against its own recent history (Phase 5). Returns percentile rank + robust
 * (median/MAD) and classic z-scores + an anomaly verdict, all over the SAME
 * resolveMetric SQL get_metric uses, so the figures stay registry-grounded. This
 * is the read the backoffice AI `get_metric_anomaly` tool calls so the model can
 * say "today is in the 96th percentile, 2.3σ above its 90-day norm" instead of
 * eyeballing a fixed threshold.
 */
export async function handleAdminMetricStats(
  req: IncomingMessage,
  res: ServerResponse,
  pool: DbPool,
  config: AppConfig,
  url: URL,
  syncTargets: SyncTargetsReader,
) {
  if (!isAdminAuthorized(req, config)) {
    return respondJson(res, 401, { error: "unauthorized" });
  }

  const contentType = req.headers["content-type"] ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    return respondJson(res, 415, { error: "unsupported_media_type" });
  }

  let bodyText: string;
  try {
    bodyText = await readJsonBody(req, METRIC_STATS_MAX_BODY_BYTES);
  } catch (error) {
    return respondJson(res, 413, {
      error: "body_too_large",
      message: error instanceof Error ? error.message : "body read failed",
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return respondJson(res, 400, { error: "invalid_json" });
  }

  let request: MetricStatsRequest;
  try {
    request = parseMetricStatsRequest(parsed);
  } catch (error) {
    return respondJson(res, 400, {
      error: "invalid_request",
      message: error instanceof Error ? error.message : "invalid metric-stats request",
    });
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

  const timezone = await syncTargets.timezoneFor(merchantId, config.storeTimezone);
  const registry = await loadMetricRegistry(pool);

  try {
    const result = await metricStats(
      pool,
      registry,
      request.name,
      {
        merchantId,
        timezone,
        days: request.days ?? DEFAULT_DAYS,
        asOf: request.as_of,
      },
      config.sqlStatementTimeoutMs,
    );
    return respondJson(res, 200, result);
  } catch (error) {
    return respondJson(res, 400, {
      error: "metric_rejected",
      message: error instanceof Error ? error.message : "metric-stats resolution failed",
    });
  }
}
