import type { DbPool } from "../db.js";
import type { JobRunMetrics, SyncJob } from "./job-repository.js";

export type SyncWindowStatus = "pending" | "running" | "completed" | "warning" | "failed" | "blocked";

export type SyncWindowFailurePolicy = {
  blocked?: boolean;
  errorClass?: string;
  maxFailures?: number;
  retryAfter?: Date | null;
};

export type SyncWindowState = {
  status: SyncWindowStatus;
  retryAfter: Date | null;
  blockedAt: Date | null;
  failureCount: number;
  lastError: string | null;
  completedAt: Date | null;
  updatedAt: Date | null;
};

export class SyncWindowRepository {
  constructor(private readonly pool: DbPool) {}

  async markJobRunning(job: SyncJob) {
    if (!job.windowStart || !job.windowEnd) {
      return;
    }
    await this.pool.query(
      `
        INSERT INTO audit.sync_windows (
          merchant_id, window_type, window_start, window_end, status, stage_status,
          job_id, started_at, updated_at
        )
        VALUES ($1, $2, $3, $4, 'running', jsonb_build_object('job_running', now()), $5, now(), now())
        ON CONFLICT (merchant_id, window_type, window_start, window_end) DO UPDATE SET
          status = 'running',
          stage_status = audit.sync_windows.stage_status || jsonb_build_object('job_running', now()),
          job_id = EXCLUDED.job_id,
          retry_after = null,
          blocked_at = null,
          started_at = COALESCE(audit.sync_windows.started_at, now()),
          updated_at = now()
      `,
      [job.merchantId, job.jobType, job.windowStart, job.windowEnd, job.id]
    );
  }

  async markJobCompleted(job: SyncJob, metrics: JobRunMetrics = {}) {
    if (!job.windowStart || !job.windowEnd) {
      return;
    }
    const status: SyncWindowStatus = metrics.warning ? "warning" : "completed";
    await this.pool.query(
      `
        INSERT INTO audit.sync_windows (
          merchant_id, window_type, window_start, window_end, status, stage_status,
          job_id, rows_read, rows_written, dirty_window_count, completed_at, updated_at
        )
        VALUES (
          $1, $2, $3, $4, $5,
          jsonb_build_object('job_completed', now(), 'metrics', $9::jsonb),
          $6, $7, $8, $10, now(), now()
        )
        ON CONFLICT (merchant_id, window_type, window_start, window_end) DO UPDATE SET
          status = EXCLUDED.status,
          stage_status = audit.sync_windows.stage_status || jsonb_build_object('job_completed', now(), 'metrics', $9::jsonb),
          rows_read = GREATEST(audit.sync_windows.rows_read, EXCLUDED.rows_read),
          rows_written = GREATEST(audit.sync_windows.rows_written, EXCLUDED.rows_written),
          dirty_window_count = GREATEST(audit.sync_windows.dirty_window_count, EXCLUDED.dirty_window_count),
          failure_count = 0,
          retry_after = null,
          blocked_at = null,
          last_error = null,
          completed_at = now(),
          updated_at = now()
      `,
      [
        job.merchantId,
        job.jobType,
        job.windowStart,
        job.windowEnd,
        status,
        job.id,
        metrics.rowsRead ?? 0,
        metrics.rowsWritten ?? 0,
        JSON.stringify(metrics.metadata ?? {}),
        metrics.dirtyWindowCount ?? 0
      ]
    );
  }

  async markJobFailed(job: SyncJob, error: unknown, policy: SyncWindowFailurePolicy = {}) {
    if (!job.windowStart || !job.windowEnd) {
      return;
    }
    const forceBlocked = policy.blocked === true;
    const maxFailures = policy.maxFailures ?? 2_147_483_647;
    const retryAfter = policy.retryAfter ?? null;
    const errorClass = policy.errorClass ?? "unknown";
    await this.pool.query(
      `
        INSERT INTO audit.sync_windows (
          merchant_id, window_type, window_start, window_end, status, stage_status,
          job_id, last_error, blocked_at, retry_after, failure_count, completed_at, updated_at
        )
        VALUES (
          $1, $2, $3, $4,
          CASE WHEN $7::boolean OR 1 >= $8::integer THEN 'blocked' ELSE 'failed' END,
          jsonb_build_object('job_failed', now(), 'errorClass', $10::text, 'failureCount', 1),
          $5,
          $6,
          CASE WHEN $7::boolean OR 1 >= $8::integer THEN now() ELSE null END,
          CASE WHEN $7::boolean OR 1 >= $8::integer THEN null ELSE $9::timestamptz END,
          1,
          now(),
          now()
        )
        ON CONFLICT (merchant_id, window_type, window_start, window_end) DO UPDATE SET
          status = CASE
            WHEN $7::boolean OR audit.sync_windows.failure_count + 1 >= $8::integer THEN 'blocked'
            ELSE 'failed'
          END,
          stage_status = audit.sync_windows.stage_status || jsonb_build_object(
            'job_failed',
            now(),
            'errorClass',
            $10::text,
            'failureCount',
            audit.sync_windows.failure_count + 1
          ),
          job_id = EXCLUDED.job_id,
          last_error = EXCLUDED.last_error,
          failure_count = audit.sync_windows.failure_count + 1,
          blocked_at = CASE
            WHEN $7::boolean OR audit.sync_windows.failure_count + 1 >= $8::integer
              THEN COALESCE(audit.sync_windows.blocked_at, now())
            ELSE null
          END,
          retry_after = CASE
            WHEN $7::boolean OR audit.sync_windows.failure_count + 1 >= $8::integer THEN null
            ELSE $9::timestamptz
          END,
          completed_at = now(),
          updated_at = now()
      `,
      [
        job.merchantId,
        job.jobType,
        job.windowStart,
        job.windowEnd,
        job.id,
        error instanceof Error ? error.message : String(error),
        forceBlocked,
        maxFailures,
        retryAfter,
        errorClass
      ]
    );
  }

  async markStage(input: {
    merchantId: string;
    windowType: string;
    windowStart: Date;
    windowEnd: Date;
    stage: string;
    status?: SyncWindowStatus;
    rawExportId?: string;
    reconciliationId?: string;
    metrics?: Record<string, unknown>;
  }) {
    await this.pool.query(
      `
        INSERT INTO audit.sync_windows (
          merchant_id, window_type, window_start, window_end, status, stage_status,
          raw_export_ids, reconciliation_ids, updated_at
        )
        VALUES (
          $1, $2, $3, $4, $5,
          jsonb_build_object($6::text, now(), 'metrics', $9::jsonb),
          CASE WHEN $7::uuid IS NULL THEN '{}'::uuid[] ELSE ARRAY[$7::uuid] END,
          CASE WHEN $8::uuid IS NULL THEN '{}'::uuid[] ELSE ARRAY[$8::uuid] END,
          now()
        )
        ON CONFLICT (merchant_id, window_type, window_start, window_end) DO UPDATE SET
          status = EXCLUDED.status,
          stage_status = audit.sync_windows.stage_status || jsonb_build_object($6::text, now(), 'metrics', $9::jsonb),
          raw_export_ids = (
            SELECT ARRAY(SELECT DISTINCT value FROM unnest(audit.sync_windows.raw_export_ids || EXCLUDED.raw_export_ids) AS value)
          ),
          reconciliation_ids = (
            SELECT ARRAY(SELECT DISTINCT value FROM unnest(audit.sync_windows.reconciliation_ids || EXCLUDED.reconciliation_ids) AS value)
          ),
          retry_after = CASE
            WHEN EXCLUDED.status IN ('pending', 'running', 'completed', 'warning') THEN null
            ELSE audit.sync_windows.retry_after
          END,
          blocked_at = CASE
            WHEN EXCLUDED.status IN ('pending', 'running', 'completed', 'warning') THEN null
            ELSE audit.sync_windows.blocked_at
          END,
          last_error = CASE
            WHEN EXCLUDED.status IN ('completed', 'warning') THEN null
            ELSE audit.sync_windows.last_error
          END,
          updated_at = now()
      `,
      [
        input.merchantId,
        input.windowType,
        input.windowStart,
        input.windowEnd,
        input.status ?? "running",
        input.stage,
        input.rawExportId ?? null,
        input.reconciliationId ?? null,
        JSON.stringify(input.metrics ?? {})
      ]
    );
  }

  async markMartRefreshed(input: {
    merchantId: string;
    windowStart: Date;
    windowEnd: Date;
    metrics?: Record<string, unknown>;
  }) {
    await this.pool.query(
      `
        UPDATE audit.sync_windows
        SET stage_status = stage_status || jsonb_build_object('mart_refreshed', now(), 'mart_refresh_metrics', $4::jsonb),
            updated_at = now()
        WHERE merchant_id = $1
          AND window_start < $3
          AND window_end > $2
          AND status IN ('running', 'completed', 'warning')
      `,
      [input.merchantId, input.windowStart, input.windowEnd, JSON.stringify(input.metrics ?? {})]
    );
  }

  // Operator requeue (Phase 2): reset terminal historical windows so the
  // autonomous scheduler reprocesses them. Only failed/blocked rows are reset to
  // 'pending' (never completed/warning), with failure_count/blocked_at/retry_after
  // cleared for a fresh retry budget. The scheduler still enqueues one window at a
  // time within the export window, so this never bypasses the rate-limit guards.
  // Returns the number of windows reset.
  async requeueHistoricalWindows(input: {
    merchantId: string;
    statuses: SyncWindowStatus[];
    windowStart?: Date | null;
    windowEnd?: Date | null;
  }): Promise<number> {
    const result = await this.pool.query(
      `
        UPDATE audit.sync_windows
        SET status = 'pending',
            retry_after = null,
            blocked_at = null,
            failure_count = 0,
            last_error = null,
            updated_at = now()
        WHERE merchant_id = $1
          AND window_type = 'historical_export_backfill'
          AND status = ANY($2::text[])
          AND ($3::timestamptz IS NULL OR window_start >= $3)
          AND ($4::timestamptz IS NULL OR window_end <= $4)
      `,
      [input.merchantId, input.statuses, input.windowStart ?? null, input.windowEnd ?? null]
    );
    return result.rowCount ?? 0;
  }

  async historicalBackfillWindowState(input: {
    merchantId: string;
    windowStart: Date;
    windowEnd: Date;
  }): Promise<SyncWindowState | null> {
    const result = await this.pool.query<SyncWindowRow>(
      `
        SELECT status, retry_after, blocked_at, failure_count, last_error, completed_at, updated_at
        FROM audit.sync_windows
        WHERE merchant_id = $1
          AND window_type = 'historical_export_backfill'
          AND window_start = $2
          AND window_end <= $3
        ORDER BY
          CASE
            WHEN status IN ('completed', 'warning') THEN 0
            WHEN status = 'blocked' THEN 1
            WHEN status = 'running' THEN 2
            WHEN status = 'pending' THEN 3
            WHEN status = 'failed' THEN 4
            ELSE 5
          END,
          window_end DESC
        LIMIT 1
      `,
      [input.merchantId, input.windowStart, input.windowEnd]
    );
    return result.rows[0] ? mapSyncWindowState(result.rows[0]) : null;
  }
}

type SyncWindowRow = {
  status: string;
  retry_after: Date | null;
  blocked_at: Date | null;
  failure_count: number | string | null;
  last_error: string | null;
  completed_at: Date | null;
  updated_at: Date | null;
};

function mapSyncWindowState(row: SyncWindowRow): SyncWindowState {
  return {
    status: row.status as SyncWindowStatus,
    retryAfter: row.retry_after,
    blockedAt: row.blocked_at,
    failureCount: Number(row.failure_count ?? 0),
    lastError: row.last_error,
    completedAt: row.completed_at,
    updatedAt: row.updated_at
  };
}
