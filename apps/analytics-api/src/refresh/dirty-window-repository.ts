import { randomUUID } from "node:crypto";
import type { DateTime } from "luxon";
import { DateTime as LuxonDateTime } from "luxon";
import type { DbPool } from "../db.js";

export type DirtyWindow = {
  id: string;
  merchantId: string;
  businessDateStart: string;
  businessDateEnd: string;
  utcStart: Date;
  utcEnd: Date;
  reason: string;
  priority: number;
};

export type ClaimedDirtyWindows = {
  claimToken: string;
  rows: DirtyWindow[];
};

export class DirtyWindowRepository {
  constructor(
    private readonly pool: DbPool,
    private readonly timezone: string
  ) {}

  async append(input: {
    merchantId: string;
    utcStart: Date;
    utcEnd: Date;
    reason: string;
    priority?: number;
  }) {
    const businessStart = businessDate(input.utcStart, this.timezone);
    const businessEnd = businessDate(new Date(input.utcEnd.getTime() - 1), this.timezone);
    await this.pool.query(
      `
        INSERT INTO audit.dirty_windows (
          merchant_id, business_date_start, business_date_end, utc_start, utc_end, reason, priority
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7)
      `,
      [
        input.merchantId,
        businessStart,
        businessEnd,
        input.utcStart,
        input.utcEnd,
        input.reason,
        input.priority ?? 100
      ]
    );
  }

  async claimPending(limit = 100): Promise<ClaimedDirtyWindows | null> {
    const claimToken = randomUUID();
    const result = await this.pool.query<DirtyWindowRow>(
      `
        UPDATE audit.dirty_windows
        SET status = 'refreshing',
            claimed_at = now(),
            claim_token = $1
        WHERE id IN (
          SELECT id
          FROM audit.dirty_windows
          WHERE status = 'pending'
          ORDER BY priority ASC, business_date_start ASC, created_at ASC
          FOR UPDATE SKIP LOCKED
          LIMIT $2
        )
        RETURNING *
      `,
      [claimToken, limit]
    );

    if (result.rows.length === 0) {
      return null;
    }

    return {
      claimToken,
      rows: result.rows.map(mapDirtyWindow)
    };
  }

  async requeueRetryableFailures(limit = 100) {
    const result = await this.pool.query(
      `
        UPDATE audit.dirty_windows
        SET status = 'pending',
            claimed_at = null,
            claim_token = null,
            error_message = null
        WHERE id IN (
          SELECT id
          FROM audit.dirty_windows
          WHERE status = 'failed'
            AND (
              error_message ILIKE '%ON CONFLICT DO UPDATE command cannot affect row a second time%'
              OR error_message ILIKE '%Mart refresh lock is busy%'
              OR error_message ILIKE '%Recovered stale running job%'
            )
          ORDER BY priority ASC, business_date_start ASC, created_at ASC
          LIMIT $1
        )
      `,
      [limit]
    );
    return result.rowCount ?? 0;
  }

  async recoverStaleRefreshing(staleAfterMinutes: number) {
    const result = await this.pool.query(
      `
        UPDATE audit.dirty_windows
        SET status = 'pending',
            claimed_at = null,
            claim_token = null,
            error_message = null
        WHERE status = 'refreshing'
          AND claimed_at < now() - ($1::text)::interval
      `,
      [`${staleAfterMinutes} minutes`]
    );
    return result.rowCount ?? 0;
  }

  async markRefreshed(claimToken: string) {
    await this.pool.query(
      `
        UPDATE audit.dirty_windows
        SET status = 'refreshed',
            refreshed_at = now()
        WHERE claim_token = $1
          AND status = 'refreshing'
      `,
      [claimToken]
    );
  }

  async markFailed(claimToken: string, error: unknown) {
    await this.pool.query(
      `
        UPDATE audit.dirty_windows
        SET status = 'failed',
            error_message = $2
        WHERE claim_token = $1
          AND status = 'refreshing'
      `,
      [claimToken, error instanceof Error ? error.message : String(error)]
    );
  }
}

export function mergeDirtyWindows(rows: DirtyWindow[]) {
  const byMerchant = new Map<string, DirtyWindow[]>();
  for (const row of rows) {
    const current = byMerchant.get(row.merchantId) ?? [];
    current.push(row);
    byMerchant.set(row.merchantId, current);
  }

  return [...byMerchant.entries()].map(([merchantId, merchantRows]) => ({
    merchantId,
    start: new Date(Math.min(...merchantRows.map((row) => row.utcStart.getTime()))),
    end: new Date(Math.max(...merchantRows.map((row) => row.utcEnd.getTime()))),
    businessDateStart: minDateString(merchantRows.map((row) => row.businessDateStart)),
    businessDateEnd: maxDateString(merchantRows.map((row) => row.businessDateEnd))
  }));
}

function businessDate(date: Date, timezone: string) {
  return LuxonDateTime.fromJSDate(date, { zone: "utc" }).setZone(timezone).toISODate() ?? "1970-01-01";
}

function minDateString(values: string[]) {
  return values.reduce((min, value) => value < min ? value : min);
}

function maxDateString(values: string[]) {
  return values.reduce((max, value) => value > max ? value : max);
}

type DirtyWindowRow = {
  id: string;
  merchant_id: string;
  business_date_start: string | DateTime;
  business_date_end: string | DateTime;
  utc_start: Date;
  utc_end: Date;
  reason: string;
  priority: number;
};

function mapDirtyWindow(row: DirtyWindowRow): DirtyWindow {
  return {
    id: row.id,
    merchantId: row.merchant_id,
    businessDateStart: String(row.business_date_start).slice(0, 10),
    businessDateEnd: String(row.business_date_end).slice(0, 10),
    utcStart: row.utc_start,
    utcEnd: row.utc_end,
    reason: row.reason,
    priority: row.priority
  };
}
