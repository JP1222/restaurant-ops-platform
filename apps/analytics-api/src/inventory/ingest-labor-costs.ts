import type { LaborCostSnapshot } from "@rop/contracts";

import { withTransaction, type DbPool } from "../db.js";
import { toStoreLocalEffectiveDate } from "./ingest-plate-costs.js";

export interface LaborCostIngestResult {
  received: number;
  written: number;
}

// Default store timezone, matching config.ts. Used when a caller doesn't pass one
// (e.g. legacy tests) so the conversion never silently falls back to UTC.
const DEFAULT_STORE_TIMEZONE = "America/Chicago";

/**
 * Upsert labor-cost snapshots into `mart.dim_labor_cost` (ADR-0033, Phase 4b),
 * effective-dated by `(merchant_id, effective_from)`.
 *
 * Unlike plate cost — which re-emits the CURRENT cost on every sync (effective_from =
 * now()) and so needs change-detection to avoid a new dimension row every day —
 * labor snapshots carry the operator's EXPLICIT historical effective_from dates, so
 * each row upserts directly on its natural key (idempotent: re-syncing the same set
 * is a no-op beyond `ingested_at`).
 *
 * `effective_from` is normalized to the STORE-LOCAL date (same `toStoreLocalEffectiveDate`
 * helper plate cost uses, #474) so it lines up with `business_date` in
 * `prime_cost_daily_mv`. A bare `YYYY-MM-DD` (the operator's picked calendar date)
 * passes through unchanged.
 */
export async function ingestLaborCosts(
  pool: DbPool,
  snapshots: LaborCostSnapshot[],
  storeTimezone: string = DEFAULT_STORE_TIMEZONE
): Promise<LaborCostIngestResult> {
  return withTransaction(pool, async (client) => {
    let written = 0;
    for (const snapshot of snapshots) {
      const effectiveDate = toStoreLocalEffectiveDate(snapshot.effective_from, storeTimezone);
      await client.query(
        `INSERT INTO mart.dim_labor_cost (merchant_id, effective_from, daily_labor_cost_cents, currency, note)
         VALUES ($1, $2::date, $3, $4, $5)
         ON CONFLICT (merchant_id, effective_from)
         DO UPDATE SET daily_labor_cost_cents = EXCLUDED.daily_labor_cost_cents,
                       currency = EXCLUDED.currency,
                       note = EXCLUDED.note,
                       ingested_at = now()`,
        [
          snapshot.merchant_id,
          effectiveDate,
          snapshot.daily_labor_cost_cents,
          snapshot.currency,
          snapshot.note ?? null
        ]
      );
      written += 1;
    }
    return { received: snapshots.length, written };
  });
}
