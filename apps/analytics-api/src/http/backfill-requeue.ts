import type { IncomingMessage, ServerResponse } from "node:http";

import { BackfillRequeueRequestSchema } from "@rop/contracts";
import type { AppConfig } from "../config.js";
import type { DbPool } from "../db.js";
import { SyncWindowRepository, type SyncWindowStatus } from "../scheduler/sync-window-repository.js";
import { enforceTenantScope } from "../lib/tenant-auth.js";
import { isAdminAuthorized } from "./admin.js";
import { readJsonBody, respondJson } from "./health.js";

const MAX_BODY_BYTES = 4 * 1024;

/**
 * POST /admin/api/backfill/requeue — operator requeue of historical backfill
 * windows (P4). Resets terminal windows (failed/blocked, or blocked-only) to
 * 'pending' so the autonomous scheduler reprocesses them one-at-a-time inside the
 * Clover export window — the only sanctioned write path, replacing hand-edited
 * `UPDATE audit.sync_windows` in psql. Completed windows are never touched.
 */
export async function handleAdminBackfillRequeue(
  req: IncomingMessage,
  res: ServerResponse,
  pool: DbPool,
  config: AppConfig,
  url: URL
) {
  if (!isAdminAuthorized(req, config)) {
    return respondJson(res, 401, { error: "unauthorized" });
  }

  const contentType = req.headers["content-type"] ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    return respondJson(res, 415, { error: "unsupported_media_type" });
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

  let bodyText: string;
  try {
    bodyText = await readJsonBody(req, MAX_BODY_BYTES);
  } catch {
    return respondJson(res, 413, { error: "body_too_large" });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return respondJson(res, 400, { error: "invalid_json" });
  }

  const result = BackfillRequeueRequestSchema.safeParse(parsed);
  if (!result.success) {
    return respondJson(res, 400, { error: "invalid_body", details: result.error.flatten() });
  }

  const { action, windowStart, windowEnd } = result.data;
  const statuses: SyncWindowStatus[] =
    action === "unblock" ? ["blocked"] : ["failed", "blocked"];

  const repo = new SyncWindowRepository(pool);
  const requeuedWindows = await repo.requeueHistoricalWindows({
    merchantId,
    statuses,
    windowStart: windowStart ? new Date(windowStart) : null,
    windowEnd: windowEnd ? new Date(windowEnd) : null
  });

  return respondJson(res, 200, { ok: true, action, requeuedWindows });
}
