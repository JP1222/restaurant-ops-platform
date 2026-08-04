import type { ActualCogsWindow } from "@rop/contracts";

import { withTransaction, type DbPool } from "../db.js";

export interface ActualCogsIngestResult {
  received: number;
  written: number;
}

/**
 * Upsert actual-COGS windows into `mart.dim_actual_cogs` (ADR-0031, yield-variance lens),
 * keyed by `(merchant_id, period_start, period_end)` — the two count dates that bound the
 * window. Re-syncing the same windows is idempotent (a no-op beyond `ingested_at`); a
 * window whose figures changed (e.g. a corrected count) updates in place.
 *
 * period_start / period_end are bare store-local count dates (YYYY-MM-DD), inserted
 * directly as `::date`. Unlike the plate / labor feeds — which carry instants needing
 * store-local normalization — these are already calendar dates, directly comparable to
 * `business_date` in cost_daily_mv.
 */
export async function ingestActualCogs(
  pool: DbPool,
  windows: ActualCogsWindow[]
): Promise<ActualCogsIngestResult> {
  return withTransaction(pool, async (client) => {
    let written = 0;
    for (const window of windows) {
      await client.query(
        `INSERT INTO mart.dim_actual_cogs
           (merchant_id, period_start, period_end, beginning_value_cents,
            received_value_cents, ending_value_cents, actual_cogs_cents)
         VALUES ($1, $2::date, $3::date, $4, $5, $6, $7)
         ON CONFLICT (merchant_id, period_start, period_end)
         DO UPDATE SET beginning_value_cents = EXCLUDED.beginning_value_cents,
                       received_value_cents  = EXCLUDED.received_value_cents,
                       ending_value_cents    = EXCLUDED.ending_value_cents,
                       actual_cogs_cents     = EXCLUDED.actual_cogs_cents,
                       ingested_at           = now()`,
        [
          window.merchant_id,
          window.period_start,
          window.period_end,
          window.beginning_value_cents,
          window.received_value_cents,
          window.ending_value_cents,
          window.actual_cogs_cents
        ]
      );
      written += 1;
    }
    return { received: windows.length, written };
  });
}
