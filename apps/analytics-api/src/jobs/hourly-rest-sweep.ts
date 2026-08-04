import type { AppConfig } from "../config.js";
import type { DbPool } from "../db.js";
import { CloverClient } from "../clover/client.js";
import type { SyncJob } from "../scheduler/job-repository.js";
import { asJsonRecord, syncRestWindow } from "./shared.js";

export async function runRestSweepJob(
  pool: DbPool,
  config: AppConfig,
  clover: CloverClient,
  job: SyncJob
) {
  const payload = asJsonRecord(job.payload);
  const start = new Date(String(payload.start));
  const end = new Date(String(payload.end));
  const reason = job.jobType;
  const metrics = await syncRestWindow(pool, config, clover, job.merchantId, start, end, reason);
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
  return metrics;
}
