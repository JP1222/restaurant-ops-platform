import type { PlateCostSnapshot } from "@rop/contracts";
import { DateTime } from "luxon";

import { withTransaction, type DbPool } from "../db.js";

export interface PlateCostIngestResult {
  received: number;
  written: number;
}

// Default store timezone, matching config.ts / config.sync_targets. Used when a
// caller doesn't pass one (e.g. legacy tests) so the conversion never silently
// falls back to UTC.
const DEFAULT_STORE_TIMEZONE = "America/Chicago";

/**
 * Resolve a plate-cost snapshot's `effective_from` to the STORE-LOCAL calendar
 * date, the same convention `mart.fact_*.business_date` uses
 * (`DateTime.fromJSDate(utc).setZone(tz).toISODate()` in src/lib/time.ts).
 *
 * inventory-api emits `effective_from` as a UTC instant (`new Date().toISOString()`).
 * Storing its UTC date directly (`'...Z'::date`) is the bug behind #474: for a
 * cost recorded just after UTC midnight the UTC date is a day AHEAD of the
 * store-local business date, so the cost_daily_mv LATERAL JOIN
 * (`effective_from <= business_date`) drops that cost for the store-local
 * "yesterday" and silently understates COGS. Converting to the store-local date
 * here makes `effective_from` directly comparable to `business_date`.
 *
 * A bare date string (no time/zone, e.g. a backfilled `'2026-06-02'`) is already
 * a calendar date and is passed through unchanged — interpreting it as a UTC
 * instant would wrongly shift it back a day.
 */
export function toStoreLocalEffectiveDate(value: string, storeTimezone: string): string {
  const bareDate = /^\d{4}-\d{2}-\d{2}$/.exec(value.trim());
  if (bareDate) {
    return bareDate[0];
  }
  const instant = DateTime.fromISO(value, { zone: "utc" });
  if (!instant.isValid) {
    throw new Error(`invalid plate-cost effective_from: ${value}`);
  }
  const local = instant.setZone(storeTimezone).toISODate();
  if (!local) {
    throw new Error(`could not resolve store-local date for effective_from: ${value}`);
  }
  return local;
}

/**
 * Upsert plate-cost snapshots into `mart.dim_item_cost` as SCD-2-lite: a new
 * effective-dated row is inserted ONLY when an item's plate cost differs from
 * its latest known value, so repeated ingests don't bloat the dimension when
 * nothing changed. `effective_from` is normalized to the STORE-LOCAL date (see
 * `toStoreLocalEffectiveDate`), so a same-store-day re-ingest updates that day's
 * row (ON CONFLICT) rather than duplicating it, and the cost lines up with
 * `business_date` in the cost mart (#474).
 */
export async function ingestPlateCosts(
  pool: DbPool,
  snapshots: PlateCostSnapshot[],
  storeTimezone: string = DEFAULT_STORE_TIMEZONE,
): Promise<PlateCostIngestResult> {
  return withTransaction(pool, async (client) => {
    const latest = await client.query<{ clover_item_id: string; plate_cost_cents: string }>(
      `SELECT DISTINCT ON (clover_item_id) clover_item_id, plate_cost_cents
       FROM mart.dim_item_cost
       ORDER BY clover_item_id, effective_from DESC`,
    );
    const latestByItem = new Map(
      latest.rows.map((row) => [row.clover_item_id, Number(row.plate_cost_cents)]),
    );

    let written = 0;
    for (const snapshot of snapshots) {
      const previous = latestByItem.get(snapshot.clover_item_id);
      if (previous !== undefined && Math.abs(previous - snapshot.plate_cost_cents) < 1e-4) {
        continue; // unchanged — don't open a redundant effective-dated row
      }
      const effectiveDate = toStoreLocalEffectiveDate(snapshot.effective_from, storeTimezone);
      await client.query(
        `INSERT INTO mart.dim_item_cost (clover_item_id, effective_from, plate_cost_cents, currency)
         VALUES ($1, $2::date, $3, $4)
         ON CONFLICT (clover_item_id, effective_from)
         DO UPDATE SET plate_cost_cents = EXCLUDED.plate_cost_cents,
                       currency = EXCLUDED.currency,
                       ingested_at = now()`,
        [snapshot.clover_item_id, effectiveDate, snapshot.plate_cost_cents, snapshot.currency],
      );
      written += 1;
    }
    return { received: snapshots.length, written };
  });
}
