import type { IncomingMessage, ServerResponse } from "node:http";

import type { AppConfig } from "../config.js";
import type { DbPool } from "../db.js";
import { fetchPlateCosts } from "../inventory/client.js";
import { ingestPlateCosts } from "../inventory/ingest-plate-costs.js";
import { isAdminAuthorized } from "./admin.js";
import { respondJson } from "./health.js";

/**
 * POST /admin/api/sync-plate-costs — pull plate costs from inventory-api and
 * upsert `mart.dim_item_cost` (ADR-0031, Phase 1). Triggered on demand (ops /
 * cron / backoffice after recipe edits); a scheduled job is a follow-up.
 * analytics reads an external source over HTTP and writes only its own mart
 * (Iron Laws 1 + 5).
 */
export async function handleAdminSyncPlateCosts(
  req: IncomingMessage,
  res: ServerResponse,
  pool: DbPool,
  config: AppConfig,
) {
  if (!isAdminAuthorized(req, config)) {
    return respondJson(res, 401, { error: "unauthorized" });
  }
  try {
    const { snapshots } = await fetchPlateCosts(config);
    // dim_item_cost is brand-level (no merchant scope), so the store-local
    // effective date is resolved against the configured store timezone — the
    // same zone business_date is computed in (#474).
    const result = await ingestPlateCosts(pool, snapshots, config.storeTimezone);
    return respondJson(res, 200, result);
  } catch (error) {
    return respondJson(res, 502, {
      error: "plate_cost_sync_failed",
      message: error instanceof Error ? error.message : "plate cost sync failed",
    });
  }
}
