import { describe, expect, it } from "vitest";
import type { DbPool } from "../src/db.js";
import type { SyncJob } from "../src/scheduler/job-repository.js";
import { SyncWindowRepository } from "../src/scheduler/sync-window-repository.js";

describe("sync window ledger", () => {
  it("records window running and completion stages with job metrics", async () => {
    const pool = new QueryPool();
    const repo = new SyncWindowRepository(pool as unknown as DbPool);
    const job = windowJob();

    await repo.markJobRunning(job);
    await repo.markJobCompleted(job, {
      rowsRead: 10,
      rowsWritten: 8,
      dirtyWindowCount: 1,
      outputTables: ["raw.clover_orders"],
      metadata: { exportId: "export1" }
    });

    expect(pool.calls[0]!.sql).toContain("INSERT INTO audit.sync_windows");
    expect(pool.calls[0]!.params).toEqual([
      "merchant1",
      "historical_export_backfill",
      job.windowStart,
      job.windowEnd,
      job.id
    ]);
    expect(pool.calls[1]!.sql).toContain("job_completed");
    expect(pool.calls[1]!.params?.[4]).toBe("completed");
    expect(JSON.parse(String(pool.calls[1]!.params?.[8]))).toEqual({ exportId: "export1" });
  });

  it("lets a successful retry clear a previous failed window status", async () => {
    const pool = new QueryPool();
    const repo = new SyncWindowRepository(pool as unknown as DbPool);
    const job = windowJob();

    await repo.markJobRunning(job);
    await repo.markJobCompleted(job);

    expect(pool.calls[0]!.sql).toContain("status = 'running'");
    expect(pool.calls[1]!.sql).toContain("status = EXCLUDED.status");
    expect(pool.calls[0]!.sql).not.toContain("THEN 'failed'");
    expect(pool.calls[1]!.sql).not.toContain("THEN 'failed'");
  });

  it("records historical failure count and cooldown policy", async () => {
    const pool = new QueryPool();
    const repo = new SyncWindowRepository(pool as unknown as DbPool);
    const job = windowJob();
    const retryAfter = new Date("2026-04-26T14:00:00.000Z");

    await repo.markJobFailed(job, new Error("Clover request failed with 503."), {
      errorClass: "retryable",
      maxFailures: 3,
      retryAfter
    });

    expect(pool.calls[0]!.sql).toContain("failure_count");
    expect(pool.calls[0]!.sql).toContain("retry_after");
    expect(pool.calls[0]!.sql).toContain("blocked_at");
    expect(pool.calls[0]!.sql).toContain("THEN 'blocked'");
    expect(pool.calls[0]!.params).toEqual([
      "merchant1",
      "historical_export_backfill",
      job.windowStart,
      job.windowEnd,
      job.id,
      "Clover request failed with 503.",
      false,
      3,
      retryAfter,
      "retryable"
    ]);
  });

  it("reads historical backfill window state", async () => {
    const retryAfter = new Date("2026-04-26T14:00:00.000Z");
    const pool = new QueryPool([{
      status: "failed",
      retry_after: retryAfter,
      blocked_at: null,
      failure_count: "2",
      last_error: "Clover request failed with 503.",
      completed_at: null,
      updated_at: new Date("2026-04-26T13:00:00.000Z")
    }]);
    const repo = new SyncWindowRepository(pool as unknown as DbPool);

    const state = await repo.historicalBackfillWindowState({
      merchantId: "merchant1",
      windowStart: new Date("2026-04-26T00:00:00.000Z"),
      windowEnd: new Date("2026-04-27T00:00:00.000Z")
    });

    expect(state?.status).toBe("failed");
    expect(state?.retryAfter).toBe(retryAfter);
    expect(state?.failureCount).toBe(2);
  });

  it("requeues failed and blocked historical windows to pending without touching completed", async () => {
    const pool = new QueryPool([{}, {}, {}]);
    const repo = new SyncWindowRepository(pool as unknown as DbPool);

    const count = await repo.requeueHistoricalWindows({
      merchantId: "merchant1",
      statuses: ["failed", "blocked"],
      windowStart: null,
      windowEnd: null
    });

    expect(count).toBe(3);
    expect(pool.calls[0]!.sql).toContain("UPDATE audit.sync_windows");
    expect(pool.calls[0]!.sql).toContain("SET status = 'pending'");
    expect(pool.calls[0]!.sql).toContain("window_type = 'historical_export_backfill'");
    expect(pool.calls[0]!.sql).toContain("status = ANY($2::text[])");
    expect(pool.calls[0]!.sql).not.toContain("completed");
    expect(pool.calls[0]!.params).toEqual(["merchant1", ["failed", "blocked"], null, null]);
  });

  it("scopes an unblock requeue to blocked windows within a range", async () => {
    const pool = new QueryPool([{}]);
    const repo = new SyncWindowRepository(pool as unknown as DbPool);
    const start = new Date("2019-01-01T00:00:00.000Z");
    const end = new Date("2019-04-01T00:00:00.000Z");

    const count = await repo.requeueHistoricalWindows({
      merchantId: "merchant1",
      statuses: ["blocked"],
      windowStart: start,
      windowEnd: end
    });

    expect(count).toBe(1);
    expect(pool.calls[0]!.params).toEqual(["merchant1", ["blocked"], start, end]);
  });

  it("marks overlapping windows as mart refreshed", async () => {
    const pool = new QueryPool();
    const repo = new SyncWindowRepository(pool as unknown as DbPool);

    await repo.markMartRefreshed({
      merchantId: "merchant1",
      windowStart: new Date("2026-04-26T00:00:00.000Z"),
      windowEnd: new Date("2026-04-27T00:00:00.000Z")
    });

    expect(pool.calls[0]!.sql).toContain("mart_refreshed");
    expect(pool.calls[0]!.sql).toContain("window_start < $3");
  });
});

class QueryPool {
  calls: Array<{ sql: string; params?: unknown[] }> = [];

  constructor(private readonly rows: unknown[] = []) {}

  async query(sql: string, params?: unknown[]) {
    this.calls.push({ sql, params });
    return { rows: this.rows, rowCount: this.rows.length };
  }
}

function windowJob(): SyncJob {
  return {
    id: "job1",
    jobType: "historical_export_backfill",
    merchantId: "merchant1",
    status: "running",
    priority: 60,
    windowStart: new Date("2026-04-26T00:00:00.000Z"),
    windowEnd: new Date("2026-04-27T00:00:00.000Z"),
    payload: {
      start: "2026-04-26T00:00:00.000Z",
      end: "2026-04-27T00:00:00.000Z"
    },
    dedupeKey: null,
    attemptCount: 0,
    maxAttempts: 5
  };
}
