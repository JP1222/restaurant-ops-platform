import type { IncomingMessage, ServerResponse } from "node:http";

import { z } from "zod";

import { computeDataTrust } from "../analytics/data-trust.js";
import type { AppConfig } from "../config.js";
import type { DbPool } from "../db.js";
import { enforceTenantScope } from "../lib/tenant-auth.js";
import { isAdminAuthorized } from "./admin.js";
import { readJsonBody, respondJson } from "./health.js";

const DATA_TRUST_MAX_BODY_BYTES = 4 * 1024;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const DataTrustRequestSchema = z.object({
  date: z.string().regex(ISO_DATE).optional(),
  lookback_days: z.number().int().min(2).max(30).optional(),
});

export type DataTrustRequest = z.infer<typeof DataTrustRequestSchema>;

/** Pure: validate a parsed JSON body into a DataTrustRequest (throws on bad shape). */
export function parseDataTrustRequest(body: unknown): DataTrustRequest {
  return DataTrustRequestSchema.parse(body);
}

/**
 * POST /admin/api/data-trust — per-day reconciliation + data-quality verdict for
 * the recent window, so the backoffice AI `get_data_trust` tool can caveat an
 * answer when the day it's explaining is under repair or still settling. Composes
 * the existing audit.reconciliation_results + audit.data_quality_checks + sync
 * freshness state (no new schema). Mirrors handleAdminMetricDrivers: auth, JSON
 * body, tenant scope, then compute.
 */
export async function handleAdminDataTrust(
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
    bodyText = await readJsonBody(req, DATA_TRUST_MAX_BODY_BYTES);
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

  let request: DataTrustRequest;
  try {
    request = parseDataTrustRequest(parsed);
  } catch (error) {
    return respondJson(res, 400, {
      error: "invalid_request",
      message: error instanceof Error ? error.message : "invalid data-trust request",
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
    const result = await computeDataTrust(pool, {
      merchantId,
      date: request.date,
      lookbackDays: request.lookback_days,
    });
    return respondJson(res, 200, result);
  } catch (error) {
    return respondJson(res, 400, {
      error: "data_trust_failed",
      message: error instanceof Error ? error.message : "data-trust resolution failed",
    });
  }
}
