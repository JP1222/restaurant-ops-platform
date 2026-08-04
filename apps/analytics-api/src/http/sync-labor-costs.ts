import type { IncomingMessage, ServerResponse } from "node:http";

import type { AppConfig } from "../config.js";
import type { DbPool } from "../db.js";
import { fetchLaborCosts } from "../inventory/client.js";
import { ingestLaborCosts } from "../inventory/ingest-labor-costs.js";
import { refreshMaterializedViews } from "../refresh/mv-refresh.js";
import { isAdminAuthorized } from "./admin.js";
import { respondJson } from "./health.js";

/**
 * POST /admin/api/sync-labor-costs — pull labor cost from inventory-api and upsert
 * `mart.dim_labor_cost` (ADR-0033, Phase 4b). Triggered on demand by the Backoffice
 * labor-cost editor, symmetric to sync-plate-costs after a recipe edit. analytics
 * reads an external write-source over HTTP and writes only its own mart (Iron Laws
 * 1 + 5).
 *
 * After ingest it refreshes the dependency-ordered MV batch so `prime_cost_daily_mv`
 * reflects the new labor leg immediately — the Cost dashboard's Labor / Prime cards
 * light up on the operator's next load instead of waiting for the periodic
 * mart-refresh-worker cycle. The refresh is advisory-locked + idempotent, so it is
 * safe to run on this explicit, rare operator action.
 */
export async function handleAdminSyncLaborCosts(
  req: IncomingMessage,
  res: ServerResponse,
  pool: DbPool,
  config: AppConfig
) {
  if (!isAdminAuthorized(req, config)) {
    return respondJson(res, 401, { error: "unauthorized" });
  }
  try {
    const { snapshots } = await fetchLaborCosts(config);
    const result = await ingestLaborCosts(pool, snapshots, config.storeTimezone);
    const refreshed = await refreshMaterializedViews(pool);
    return respondJson(res, 200, { ...result, refreshed });
  } catch (error) {
    return respondJson(res, 502, {
      error: "labor_cost_sync_failed",
      message: error instanceof Error ? error.message : "labor cost sync failed"
    });
  }
}
