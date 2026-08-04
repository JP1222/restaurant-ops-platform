import type { AppConfig } from "../config.js";
import type { DbPool } from "../db.js";
import {
  upsertSquareOrders,
  upsertSquarePayments,
  upsertSquareRefunds,
} from "../ingest/square-raw-repository.js";
import { DirtyWindowRepository } from "../refresh/dirty-window-repository.js";
import type { SquareClient } from "../square/client.js";
import type { SyncJob } from "../scheduler/job-repository.js";
import { asJsonRecord, type JobMetrics } from "./shared.js";

// Square sweep — the Square sibling of runRestSweepJob (hourly-rest-sweep.ts).
// Pulls orders + payments + refunds updated/created since the window start (the
// SquareClient applies the overlap-friendly `since` filter; upserts are
// idempotent, so the eventual-consistency re-scan is harmless), lands them in
// raw.square_*, and appends a dirty window so MartRefreshWorker re-derives the
// mart for the affected business dates.
export async function runSquareSweepJob(
  pool: DbPool,
  config: AppConfig,
  square: SquareClient,
  job: SyncJob
): Promise<JobMetrics> {
  const payload = asJsonRecord(job.payload);
  const start = new Date(String(payload.start));
  const end = new Date(String(payload.end));
  const reason = job.jobType;
  const window = { start, end };

  // Square's only delivery path is polling, so the window-start `since` must
  // overlap (eventual consistency) — that's already baked into the scheduler's
  // syncOverlapHours window.
  const [orders, payments, refunds] = await Promise.all([
    square.listOrders(start),
    square.listPayments(start),
    square.listRefunds(start),
  ]);

  const orderCount = await upsertSquareOrders(pool, job.merchantId, orders, window);
  const paymentCount = await upsertSquarePayments(pool, job.merchantId, payments, window);
  const refundCount = await upsertSquareRefunds(pool, job.merchantId, refunds);

  await new DirtyWindowRepository(pool, config.storeTimezone).append({
    merchantId: job.merchantId,
    utcStart: start,
    utcEnd: end,
    reason,
  });

  // Freshness cursor (mirrors runRestSweepJob) so ops/freshness sees the Square
  // store advancing.
  await pool.query(
    `
      INSERT INTO audit.sync_cursors (merchant_id, resource, strategy, cursor_value, updated_at)
      VALUES ($1, 'orders_payments', $2, $3, now())
      ON CONFLICT (merchant_id, resource, strategy) DO UPDATE SET
        cursor_value = EXCLUDED.cursor_value,
        updated_at = now()
    `,
    [job.merchantId, reason, end]
  );

  return {
    rowsRead: orders.length + payments.length + refunds.length,
    rowsWritten: orderCount + paymentCount + refundCount,
    dirtyWindowCount: 1,
    outputTables: ["raw.square_orders", "raw.square_payments", "raw.square_refunds", "audit.dirty_windows"],
    metadata: { orderCount, paymentCount, refundCount },
  };
}
