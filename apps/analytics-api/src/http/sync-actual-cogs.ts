import type { IncomingMessage, ServerResponse } from "node:http";

import type { AppConfig } from "../config.js";
import type { DbPool } from "../db.js";
import { fetchActualCogs } from "../inventory/client.js";
import { ingestActualCogs } from "../inventory/ingest-actual-cogs.js";
import { refreshMaterializedViews } from "../refresh/mv-refresh.js";
import { isAdminAuthorized } from "./admin.js";
import { respondJson } from "./health.js";

/**
 * POST /admin/api/sync-actual-cogs — pull count-based actual COGS from inventory-api and
 * upsert `mart.dim_actual_cogs` (ADR-0031, yield-variance lens), symmetric to
 * sync-labor-costs / sync-plate-costs. analytics reads an external write-source over HTTP
 * and writes only its own mart (Iron Laws 1 + 5).
 *
 * After ingest it refreshes the dependency-ordered MV batch so `cost_variance_daily_mv`
 * reflects the new windows immediately — the Cost dashboard's Yield-variance card lights
 * up on the operator's next load instead of waiting for the periodic mart-refresh-worker
 * cycle. The refresh is advisory-locked + idempotent, safe on this explicit operator
 * action.
 */
export async function handleAdminSyncActualCogs(
  req: IncomingMessage,
  res: ServerResponse,
  pool: DbPool,
  config: AppConfig
) {
  if (!isAdminAuthorized(req, config)) {
    return respondJson(res, 401, { error: "unauthorized" });
  }
  try {
    const { snapshots } = await fetchActualCogs(config);
    const result = await ingestActualCogs(pool, snapshots);
    const refreshed = await refreshMaterializedViews(pool);
    return respondJson(res, 200, { ...result, refreshed });
  } catch (error) {
    return respondJson(res, 502, {
      error: "actual_cogs_sync_failed",
      message: error instanceof Error ? error.message : "actual cogs sync failed"
    });
  }
}
