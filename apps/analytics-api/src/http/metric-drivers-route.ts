import type { IncomingMessage, ServerResponse } from "node:http";

import { z } from "zod";

import { computeMetricDrivers } from "../analytics/metric-drivers.js";
import type { AppConfig } from "../config.js";
import type { DbPool } from "../db.js";
import { enforceTenantScope } from "../lib/tenant-auth.js";
import { isAdminAuthorized } from "./admin.js";
import { readJsonBody, respondJson } from "./health.js";

const METRIC_DRIVERS_MAX_BODY_BYTES = 4 * 1024;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const MetricDriversRequestSchema = z.object({
  date: z.string().regex(ISO_DATE).optional(),
  top: z.number().int().min(1).max(20).optional(),
});

export type MetricDriversRequest = z.infer<typeof MetricDriversRequestSchema>;

/** Pure: validate a parsed JSON body into a MetricDriversRequest (throws on bad shape). */
export function parseMetricDriversRequest(body: unknown): MetricDriversRequest {
  return MetricDriversRequestSchema.parse(body);
}

/**
 * POST /admin/api/metric/drivers — decompose a day's net-sales change across
 * dimensions (daypart / order type / tender / item) vs the same-weekday norm,
 * ranking each dimension's members by their contribution. The read behind the
 * backoffice AI `explain_metric_change` tool, so the model can answer "why are
 * sales low today" with ranked, grounded drivers instead of a guess. Mirrors
 * handleAdminMetricStats: auth, JSON body, tenant scope, then compute.
 */
export async function handleAdminMetricDrivers(
  req: IncomingMessage,
  res: ServerResponse,
  pool: DbPool,
  config: AppConfig,
  url: URL,
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
    bodyText = await readJsonBody(req, METRIC_DRIVERS_MAX_BODY_BYTES);
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

  let request: MetricDriversRequest;
  try {
    request = parseMetricDriversRequest(parsed);
  } catch (error) {
    return respondJson(res, 400, {
      error: "invalid_request",
      message: error instanceof Error ? error.message : "invalid metric-drivers request",
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

  try {
    const result = await computeMetricDrivers(pool, {
      merchantId,
      date: request.date,
      top: request.top,
    });
    return respondJson(res, 200, result);
  } catch (error) {
    return respondJson(res, 400, {
      error: "metric_drivers_failed",
      message: error instanceof Error ? error.message : "metric-drivers resolution failed",
    });
  }
}
