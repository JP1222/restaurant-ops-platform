import type { IncomingMessage, ServerResponse } from "node:http";

import { z } from "zod";

import { loadMetricRegistry, resolveMetric } from "../analytics/metric-registry.js";
import type { AppConfig } from "../config.js";
import type { DbPool } from "../db.js";
import type { SyncTargetsReader } from "../sync-targets/repository.js";
import { enforceTenantScope } from "../lib/tenant-auth.js";
import { isAdminAuthorized } from "./admin.js";
import { readJsonBody, respondJson } from "./health.js";

const METRIC_MAX_BODY_BYTES = 8 * 1024;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const WindowSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("days"), days: z.number().int().min(1).max(3650) }),
  z.object({
    mode: z.literal("range"),
    from: z.string().regex(ISO_DATE),
    to: z.string().regex(ISO_DATE),
  }),
]);

const MetricRequestSchema = z.object({
  name: z.string().min(1).max(120),
  window: WindowSchema,
  dimensions: z.array(z.string().min(1).max(64)).max(8).optional(),
  filters: z.record(z.string().min(1).max(64), z.string().max(200)).optional(),
});

export type MetricRequest = z.infer<typeof MetricRequestSchema>;

/** Pure: validate a parsed JSON body into a MetricRequest (throws on bad shape). */
export function parseMetricRequest(body: unknown): MetricRequest {
  return MetricRequestSchema.parse(body);
}

/**
 * GET /admin/api/metrics — the governed metric catalog (names, definitions,
 * units, and the dimensions/filters each metric allows). The backoffice AI
 * `list_metrics` tool reads this so the model can pick a valid metric name
 * before calling get_metric (ADR-0030 metric selection). Catalog is
 * merchant-independent, so no store scoping is needed.
 */
export async function handleAdminMetricsList(
  req: IncomingMessage,
  res: ServerResponse,
  pool: DbPool,
  config: AppConfig,
) {
  if (!isAdminAuthorized(req, config)) {
    return respondJson(res, 401, { error: "unauthorized" });
  }
  const registry = await loadMetricRegistry(pool);
  const metrics = [...registry.values()]
    .map((m) => ({
      name: m.name,
      label: m.label,
      unit: m.unit,
      definition: m.definition,
      dimensions: m.allowedDimensions,
      filters: m.allowedFilters,
      synonyms: m.synonyms,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return respondJson(res, 200, { metrics });
}

/**
 * POST /admin/api/metric — resolve a single named metric through the governed
 * registry (ADR-0030). This is the grounded read path the backoffice AI
 * `get_metric()` tool calls: the caller names a metric and picks allowed
 * dimensions/filters, never authoring SQL. composeMetricSql enforces the
 * allow-lists; values come back with the SQL + prose definition for trust.
 */
export async function handleAdminMetric(
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
    bodyText = await readJsonBody(req, METRIC_MAX_BODY_BYTES);
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

  let request: MetricRequest;
  try {
    request = parseMetricRequest(parsed);
  } catch (error) {
    return respondJson(res, 400, {
      error: "invalid_request",
      message: error instanceof Error ? error.message : "invalid metric request",
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
    const result = await resolveMetric(
      pool,
      registry,
      request.name,
      {
        merchantId,
        timezone,
        window: request.window,
        dimensions: request.dimensions,
        filters: request.filters,
      },
      config.sqlStatementTimeoutMs,
    );
    return respondJson(res, 200, {
      rows: result.rows,
      row_count: result.rows.length,
      sql: result.sql,
      definition: result.definition,
      unit: result.unit,
    });
  } catch (error) {
    return respondJson(res, 400, {
      error: "metric_rejected",
      message: error instanceof Error ? error.message : "metric resolution failed",
    });
  }
}
