import type { DbPool } from "../db.js";
import type { JsonRecord } from "../types.js";
import { JobTypeSchema, jobPriority, validateJobPayload, type JobType } from "./job-types.js";

export type SyncJob = {
  id: string;
  jobType: JobType;
  merchantId: string;
  status: string;
  priority: number;
  windowStart: Date | null;
  windowEnd: Date | null;
  payload: JsonRecord;
  dedupeKey: string | null;
  attemptCount: number;
  maxAttempts: number;
};

export type JobRunMetrics = {
  rowsRead?: number;
  rowsWritten?: number;
  dirtyWindowCount?: number;
  outputTables?: string[];
  metadata?: JsonRecord;
  warning?: boolean;
};

export type EnqueueJobInput = {
  jobType: JobType;
  merchantId: string;
  payload?: JsonRecord;
  dedupeKey?: string | null;
  runAfter?: Date;
  priority?: number;
  windowStart?: Date | null;
  windowEnd?: Date | null;
  maxAttempts?: number;
};

export class JobRepository {
  constructor(private readonly pool: DbPool) {}

  async enqueue(input: EnqueueJobInput) {
    JobTypeSchema.parse(input.jobType);
    validateJobPayload(input.jobType, input.payload ?? {});
    const priority = input.priority ?? jobPriority(input.jobType);
    const runAfter = input.runAfter ?? new Date();
    const maxAttempts = input.maxAttempts ?? 5;

    if (input.dedupeKey) {
      const result = await this.pool.query<SyncJobRow>(
        `
          INSERT INTO audit.sync_jobs (
            job_type, merchant_id, priority, window_start, window_end, payload,
            dedupe_key, max_attempts, run_after, updated_at
          )
          VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, now())
          ON CONFLICT (dedupe_key)
          WHERE dedupe_key IS NOT NULL AND status IN ('pending', 'running')
          DO UPDATE SET
            payload = EXCLUDED.payload,
            priority = LEAST(audit.sync_jobs.priority, EXCLUDED.priority),
            run_after = LEAST(audit.sync_jobs.run_after, EXCLUDED.run_after),
            updated_at = now()
          RETURNING *
        `,
        [
          input.jobType,
          input.merchantId,
          priority,
          input.windowStart ?? null,
          input.windowEnd ?? null,
          JSON.stringify(input.payload ?? {}),
          input.dedupeKey,
          maxAttempts,
          runAfter
        ]
      );
      return mapJob(result.rows[0]!);
    }

    const result = await this.pool.query<SyncJobRow>(
      `
        INSERT INTO audit.sync_jobs (
          job_type, merchant_id, priority, window_start, window_end, payload,
          dedupe_key, max_attempts, run_after, updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, now())
        RETURNING *
      `,
      [
        input.jobType,
        input.merchantId,
        priority,
        input.windowStart ?? null,
        input.windowEnd ?? null,
        JSON.stringify(input.payload ?? {}),
        input.dedupeKey ?? null,
        maxAttempts,
        runAfter
      ]
    );
    return mapJob(result.rows[0]!);
  }

  async enqueueOnce(input: EnqueueJobInput) {
    if (input.dedupeKey && await this.existsByDedupeKey(input.dedupeKey)) {
      return null;
    }
    return this.enqueue(input);
  }

  async existsByDedupeKey(dedupeKey: string, statuses?: string[]) {
    if (statuses) {
      const result = await this.pool.query<{ exists: boolean }>(
        "SELECT EXISTS (SELECT 1 FROM audit.sync_jobs WHERE dedupe_key = $1 AND status = ANY($2::text[])) AS exists",
        [dedupeKey, statuses]
      );
      return result.rows[0]?.exists === true;
    }
    const result = await this.pool.query<{ exists: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM audit.sync_jobs WHERE dedupe_key = $1) AS exists",
      [dedupeKey]
    );
    return result.rows[0]?.exists === true;
  }

  async claimNext(instanceId: string, allowedTypes?: JobType[]) {
    const result = await this.pool.query<SyncJobRow>(
      `
        UPDATE audit.sync_jobs
        SET status = 'running',
            locked_at = now(),
            locked_by = $1,
            started_at = COALESCE(started_at, now()),
            updated_at = now()
        WHERE id = (
          SELECT id
          FROM audit.sync_jobs
          WHERE status = 'pending'
            AND run_after <= now()
            AND ($2::text[] IS NULL OR job_type = ANY($2::text[]))
          ORDER BY priority ASC, run_after ASC, created_at ASC
          FOR UPDATE SKIP LOCKED
          LIMIT 1
        )
        RETURNING *
      `,
      [instanceId, allowedTypes ?? null]
    );
    return result.rows[0] ? mapJob(result.rows[0]) : null;
  }

  async requeue(jobId: string, delayMs: number, reason: string) {
    await this.pool.query(
      `
        UPDATE audit.sync_jobs
        SET status = 'pending',
            run_after = now() + ($2::text)::interval,
            locked_at = null,
            locked_by = null,
            last_error = $3,
            updated_at = now()
        WHERE id = $1
      `,
      [jobId, `${Math.max(1, Math.ceil(delayMs / 1000))} seconds`, reason]
    );
  }

  async complete(jobId: string) {
    await this.pool.query(
      `
        UPDATE audit.sync_jobs
        SET status = 'completed',
            completed_at = now(),
            locked_at = null,
            locked_by = null,
            updated_at = now()
        WHERE id = $1
      `,
      [jobId]
    );
  }

  async fail(job: SyncJob, error: unknown, options: { terminal?: boolean } = {}) {
    const message = error instanceof Error ? error.message : String(error);
    const nextAttempt = job.attemptCount + 1;
    if (options.terminal || nextAttempt >= job.maxAttempts) {
      await this.pool.query(
        `
          UPDATE audit.sync_jobs
          SET status = 'failed',
              attempt_count = $2,
              completed_at = now(),
              locked_at = null,
              locked_by = null,
              last_error = $3,
              updated_at = now()
          WHERE id = $1
        `,
        [job.id, nextAttempt, message]
      );
      return;
    }

    const delaySeconds = Math.min(3600, 2 ** job.attemptCount * 30);
    await this.pool.query(
      `
        UPDATE audit.sync_jobs
        SET status = 'pending',
            attempt_count = $2,
            run_after = now() + ($3::text)::interval,
            locked_at = null,
            locked_by = null,
            last_error = $4,
            updated_at = now()
        WHERE id = $1
      `,
      [job.id, nextAttempt, `${delaySeconds} seconds`, message]
    );
  }

  async cancelPendingWebhookFetches(merchantId: string) {
    await this.pool.query(
      `
        UPDATE audit.sync_jobs
        SET status = 'cancelled',
            completed_at = now(),
            updated_at = now(),
            last_error = 'Cancelled after mini sweep fallback.'
        WHERE merchant_id = $1
          AND job_type IN ('webhook_fetch_order', 'webhook_fetch_payment')
          AND status = 'pending'
      `,
      [merchantId]
    );
  }

  async recoverStaleRunning(staleAfterMinutes: number) {
    await this.pool.query(
      `
        UPDATE audit.sync_jobs
        SET status = 'pending',
            run_after = now(),
            locked_at = null,
            locked_by = null,
            last_error = 'Recovered stale running job.',
            updated_at = now()
        WHERE status = 'running'
          AND locked_at < now() - ($1::text)::interval
      `,
      [`${staleAfterMinutes} minutes`]
    );
  }

  async pendingWebhookFetchCount(merchantId: string) {
    const result = await this.pool.query<{ count: string }>(
      `
        SELECT count(*) AS count
        FROM audit.sync_jobs
        WHERE merchant_id = $1
          AND job_type IN ('webhook_fetch_order', 'webhook_fetch_payment')
          AND status = 'pending'
      `,
      [merchantId]
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  async activeJobCount(merchantId: string, jobType: JobType) {
    const result = await this.pool.query<{ count: string }>(
      `
        SELECT count(*) AS count
        FROM audit.sync_jobs
        WHERE merchant_id = $1
          AND job_type = $2
          AND status IN ('pending', 'running')
      `,
      [merchantId, jobType]
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  async insertRun(input: {
    job: SyncJob;
    status: "completed" | "failed" | "skipped";
    startedAt: Date;
    rowsRead?: number;
    rowsWritten?: number;
    dirtyWindowCount?: number;
    outputTables?: string[];
    metadata?: JsonRecord;
    error?: unknown;
  }) {
    const elapsedMs = Date.now() - input.startedAt.getTime();
    await this.pool.query(
      `
        INSERT INTO audit.sync_runs (
          job_id, job_type, merchant_id, status, started_at, completed_at,
          elapsed_ms, rows_read, rows_written, dirty_window_count, error_message,
          input_window, output_tables, metadata
        )
        VALUES (
          $1, $2, $3, $4, $5, now(), $6, $7, $8, $9, $10,
          CASE WHEN $11::timestamptz IS NULL OR $12::timestamptz IS NULL
            THEN NULL
            ELSE tstzrange($11::timestamptz, $12::timestamptz, '[)')
          END,
          $13::text[],
          $14::jsonb
        )
      `,
      [
        input.job.id,
        input.job.jobType,
        input.job.merchantId,
        input.status,
        input.startedAt,
        elapsedMs,
        input.rowsRead ?? 0,
        input.rowsWritten ?? 0,
        input.dirtyWindowCount ?? 0,
        input.error instanceof Error ? input.error.message : input.error ? String(input.error) : null,
        input.job.windowStart,
        input.job.windowEnd,
        input.outputTables ?? [],
        JSON.stringify(input.metadata ?? {})
      ]
    );
  }
}

type SyncJobRow = {
  id: string;
  job_type: string;
  merchant_id: string;
  status: string;
  priority: number;
  window_start: Date | null;
  window_end: Date | null;
  payload: JsonRecord;
  dedupe_key: string | null;
  attempt_count: number;
  max_attempts: number;
};

function mapJob(row: SyncJobRow): SyncJob {
  const jobType = JobTypeSchema.parse(row.job_type);
  validateJobPayload(jobType, row.payload);
  return {
    id: row.id,
    jobType,
    merchantId: row.merchant_id,
    status: row.status,
    priority: row.priority,
    windowStart: row.window_start,
    windowEnd: row.window_end,
    payload: row.payload,
    dedupeKey: row.dedupe_key,
    attemptCount: row.attempt_count,
    maxAttempts: row.max_attempts
  };
}
