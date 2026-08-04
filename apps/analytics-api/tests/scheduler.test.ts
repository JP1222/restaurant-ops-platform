import { describe, expect, it } from "vitest";
import type { AppConfig } from "../src/config.js";
import type { DbPool } from "../src/db.js";
import {
  cleanupWebhookInbox,
  isHistoricalBackfillWindow,
  isWithinExportWindow,
  nextHistoricalBackfillWindowAt,
  Scheduler
} from "../src/scheduler/scheduler.js";
import { fakeSyncTargets } from "./helpers/sync-targets.js";

const config = {
  exportWindowStartUtc: "10:00",
  exportWindowEndUtc: "15:00",
  exportHistoricalBackfillWindowShare: 0.4,
  historicalBackfillMaxWindowFailures: 3,
  historicalBackfillMaxAutoUnblockAttempts: 3,
  historicalBackfillBlockedRetryAfterMinutes: 30,
  historicalBackfillMaxConcurrentWindows: 1
} as AppConfig;

const syncTargets = fakeSyncTargets();

describe("scheduler export windows", () => {
  it("detects the Clover Export API window", () => {
    expect(isWithinExportWindow(new Date("2026-04-26T09:59:00.000Z"), config)).toBe(false);
    expect(isWithinExportWindow(new Date("2026-04-26T10:00:00.000Z"), config)).toBe(true);
    expect(isWithinExportWindow(new Date("2026-04-26T14:59:00.000Z"), config)).toBe(true);
    expect(isWithinExportWindow(new Date("2026-04-26T15:00:00.000Z"), config)).toBe(false);
  });

  it("reserves the later share of the export window for historical backfill", () => {
    expect(isHistoricalBackfillWindow(new Date("2026-04-26T12:59:00.000Z"), config)).toBe(false);
    expect(isHistoricalBackfillWindow(new Date("2026-04-26T13:00:00.000Z"), config)).toBe(true);
  });

  it("reports the next historical backfill export slot", () => {
    expect(nextHistoricalBackfillWindowAt(new Date("2026-04-26T12:00:00.000Z"), config)?.toISOString())
      .toBe("2026-04-26T13:00:00.000Z");
    expect(nextHistoricalBackfillWindowAt(new Date("2026-04-26T13:30:00.000Z"), config)?.toISOString())
      .toBe("2026-04-26T13:30:00.000Z");
  });

  it("cleans only processed or ignored webhook inbox rows past retention", async () => {
    const pool = new QueryPool();

    await cleanupWebhookInbox(pool as unknown as DbPool, 30);

    expect(pool.calls[0]!.sql).toContain("DELETE FROM audit.webhook_inbox");
    expect(pool.calls[0]!.sql).toContain("status IN ('processed', 'ignored')");
    expect(pool.calls[0]!.sql).not.toContain("'failed'");
    expect(pool.calls[0]!.params).toEqual(["30 days"]);
  });

  it("does not enqueue historical backfill while another historical window is active", async () => {
    const pool = new HistoricalPool({ activeCount: 1 });
    const scheduler = new Scheduler(pool as unknown as DbPool, {
      ...config,
      backfillStartDate: new Date("2018-04-01T00:00:00.000Z"),
      backfillWindowDays: 30
    } as AppConfig, syncTargets);

    await callHistoricalEnqueue(scheduler, new Date("2026-04-26T13:00:00.000Z"));

    expect(pool.calls.some((call) => call.sql.includes("INSERT INTO audit.sync_jobs"))).toBe(false);
  });

  it("enqueues only the next missing historical window", async () => {
    const pool = new HistoricalPool({ activeCount: 0, existingDedupeChecks: [true, false] });
    const scheduler = new Scheduler(pool as unknown as DbPool, {
      ...config,
      backfillStartDate: new Date("2018-04-01T00:00:00.000Z"),
      backfillWindowDays: 30
    } as AppConfig, syncTargets);

    await callHistoricalEnqueue(scheduler, new Date("2026-04-26T13:00:00.000Z"));

    const inserts = pool.calls.filter((call) => call.sql.includes("INSERT INTO audit.sync_jobs"));
    expect(inserts).toHaveLength(1);
    expect(inserts[0]!.params?.[0]).toBe("historical_export_backfill");
    expect(inserts[0]!.params?.[3]).toEqual(new Date("2018-05-01T00:00:00.000Z"));
  });

  it("fills the concurrency budget with multiple windows per tick", async () => {
    const pool = new HistoricalPool({ activeCount: 0 });
    const scheduler = new Scheduler(pool as unknown as DbPool, {
      ...config,
      historicalBackfillMaxConcurrentWindows: 3,
      backfillStartDate: new Date("2018-04-01T00:00:00.000Z"),
      backfillWindowDays: 30
    } as AppConfig, syncTargets);

    await callHistoricalEnqueue(scheduler, new Date("2026-04-26T13:00:00.000Z"));

    const inserts = pool.calls.filter((call) => call.sql.includes("INSERT INTO audit.sync_jobs"));
    expect(inserts).toHaveLength(3);
    expect(inserts.map((call) => call.params?.[3])).toEqual([
      new Date("2018-04-01T00:00:00.000Z"),
      new Date("2018-05-01T00:00:00.000Z"),
      new Date("2018-05-31T00:00:00.000Z")
    ]);
  });

  it("subtracts in-flight jobs from the concurrency budget", async () => {
    const pool = new HistoricalPool({ activeCount: 1 });
    const scheduler = new Scheduler(pool as unknown as DbPool, {
      ...config,
      historicalBackfillMaxConcurrentWindows: 2,
      backfillStartDate: new Date("2018-04-01T00:00:00.000Z"),
      backfillWindowDays: 30
    } as AppConfig, syncTargets);

    await callHistoricalEnqueue(scheduler, new Date("2026-04-26T13:00:00.000Z"));

    // budget 2 - 1 active = 1 free slot, so only one new window is enqueued.
    const inserts = pool.calls.filter((call) => call.sql.includes("INSERT INTO audit.sync_jobs"));
    expect(inserts).toHaveLength(1);
  });

  it("skips a cooling failed window and enqueues a later one (no head-of-line block)", async () => {
    const pool = new HistoricalPool({
      activeCount: 0,
      windowStates: [{
        status: "failed",
        retry_after: new Date("2026-04-26T14:00:00.000Z"),
        blocked_at: null,
        failure_count: 1,
        last_error: "Clover request failed with 503.",
        completed_at: null,
        updated_at: new Date("2026-04-26T12:00:00.000Z")
      }]
    });
    const scheduler = new Scheduler(pool as unknown as DbPool, {
      ...config,
      backfillStartDate: new Date("2018-04-01T00:00:00.000Z"),
      backfillWindowDays: 30
    } as AppConfig, syncTargets);

    await callHistoricalEnqueue(scheduler, new Date("2026-04-26T13:00:00.000Z"));

    const inserts = pool.calls.filter((call) => call.sql.includes("INSERT INTO audit.sync_jobs"));
    expect(inserts).toHaveLength(1);
    // The cooling first window (2018-04-01) is skipped; the next window is enqueued
    // instead of the whole backfill stalling.
    expect(inserts[0]!.params?.[3]).toEqual(new Date("2018-05-01T00:00:00.000Z"));
  });

  it("retries a failed historical window after cooldown", async () => {
    const pool = new HistoricalPool({
      activeCount: 0,
      windowStates: [{
        status: "failed",
        retry_after: new Date("2026-04-26T12:00:00.000Z"),
        blocked_at: null,
        failure_count: 1,
        last_error: "Clover request failed with 503.",
        completed_at: null,
        updated_at: new Date("2026-04-26T12:00:00.000Z")
      }]
    });
    const scheduler = new Scheduler(pool as unknown as DbPool, {
      ...config,
      backfillStartDate: new Date("2018-04-01T00:00:00.000Z"),
      backfillWindowDays: 30
    } as AppConfig, syncTargets);

    await callHistoricalEnqueue(scheduler, new Date("2026-04-26T13:00:00.000Z"));

    const inserts = pool.calls.filter((call) => call.sql.includes("INSERT INTO audit.sync_jobs"));
    expect(inserts).toHaveLength(1);
    expect(inserts[0]!.params?.[3]).toEqual(new Date("2018-04-01T00:00:00.000Z"));
  });

  it("skips a blocked window not yet eligible for auto-unblock and continues", async () => {
    const pool = new HistoricalPool({
      activeCount: 0,
      windowStates: [{
        status: "blocked",
        retry_after: null,
        blocked_at: new Date("2026-04-26T12:45:00.000Z"),
        failure_count: 3,
        last_error: "Clover request failed with 401.",
        completed_at: null,
        updated_at: new Date("2026-04-26T12:45:00.000Z")
      }]
    });
    const scheduler = new Scheduler(pool as unknown as DbPool, {
      ...config,
      backfillStartDate: new Date("2018-04-01T00:00:00.000Z"),
      backfillWindowDays: 30
    } as AppConfig, syncTargets);

    await callHistoricalEnqueue(scheduler, new Date("2026-04-26T13:00:00.000Z"));

    const inserts = pool.calls.filter((call) => call.sql.includes("INSERT INTO audit.sync_jobs"));
    // blocked_at + 30min cooldown (13:15) is still in the future, so the blocked
    // window is skipped — but later windows must not be blocked.
    expect(inserts).toHaveLength(1);
    expect(inserts[0]!.params?.[3]).toEqual(new Date("2018-05-01T00:00:00.000Z"));
  });

  it("auto-unblocks a blocked window once the retry cooldown has elapsed", async () => {
    const pool = new HistoricalPool({
      activeCount: 0,
      windowStates: [{
        status: "blocked",
        retry_after: null,
        blocked_at: new Date("2026-04-26T12:00:00.000Z"),
        failure_count: 3,
        last_error: "Clover request failed with 503.",
        completed_at: null,
        updated_at: new Date("2026-04-26T12:00:00.000Z")
      }]
    });
    const scheduler = new Scheduler(pool as unknown as DbPool, {
      ...config,
      backfillStartDate: new Date("2018-04-01T00:00:00.000Z"),
      backfillWindowDays: 30
    } as AppConfig, syncTargets);

    await callHistoricalEnqueue(scheduler, new Date("2026-04-26T13:00:00.000Z"));

    const inserts = pool.calls.filter((call) => call.sql.includes("INSERT INTO audit.sync_jobs"));
    expect(inserts).toHaveLength(1);
    expect(inserts[0]!.params?.[3]).toEqual(new Date("2018-04-01T00:00:00.000Z"));
  });

  it("permanently parks a blocked window past the auto-unblock ceiling", async () => {
    const pool = new HistoricalPool({
      activeCount: 0,
      windowStates: [{
        status: "blocked",
        retry_after: null,
        blocked_at: new Date("2026-04-26T12:00:00.000Z"),
        failure_count: 6,
        last_error: "Clover request failed with 401.",
        completed_at: null,
        updated_at: new Date("2026-04-26T12:00:00.000Z")
      }]
    });
    const scheduler = new Scheduler(pool as unknown as DbPool, {
      ...config,
      backfillStartDate: new Date("2018-04-01T00:00:00.000Z"),
      backfillWindowDays: 30
    } as AppConfig, syncTargets);

    await callHistoricalEnqueue(scheduler, new Date("2026-04-26T13:00:00.000Z"));

    const inserts = pool.calls.filter((call) => call.sql.includes("INSERT INTO audit.sync_jobs"));
    // failure_count (6) >= maxWindowFailures (3) + maxAutoUnblockAttempts (3): the
    // window stays parked for manual intervention; a later window proceeds.
    expect(inserts).toHaveLength(1);
    expect(inserts[0]!.params?.[3]).toEqual(new Date("2018-05-01T00:00:00.000Z"));
  });

  it("treats a completed moving tail window with the same start as complete", async () => {
    const pool = new HistoricalPool({
      activeCount: 0,
      windowStates: [{
        status: "completed",
        retry_after: null,
        blocked_at: null,
        failure_count: 0,
        last_error: null,
        completed_at: new Date("2026-04-26T13:00:00.000Z"),
        updated_at: new Date("2026-04-26T13:00:00.000Z")
      }]
    });
    const scheduler = new Scheduler(pool as unknown as DbPool, {
      ...config,
      backfillStartDate: new Date("2026-04-01T00:00:00.000Z"),
      backfillWindowDays: 30
    } as AppConfig, syncTargets);

    await callHistoricalEnqueue(scheduler, new Date("2026-04-26T13:00:00.000Z"));

    expect(pool.calls.some((call) => call.sql.includes("INSERT INTO audit.sync_jobs"))).toBe(false);
  });
});

class QueryPool {
  calls: Array<{ sql: string; params?: unknown[] }> = [];

  async query(sql: string, params?: unknown[]) {
    this.calls.push({ sql, params });
    return { rows: [], rowCount: 0 };
  }
}

type WindowStateRow = {
  status: string;
  retry_after: Date | null;
  blocked_at: Date | null;
  failure_count: number;
  last_error: string | null;
  completed_at: Date | null;
  updated_at: Date | null;
};

class HistoricalPool {
  calls: Array<{ sql: string; params?: unknown[] }> = [];

  constructor(private readonly options: {
    activeCount: number;
    existingDedupeChecks?: boolean[];
    windowStates?: Array<WindowStateRow | null>;
  }) {}

  async query(sql: string, params?: unknown[]) {
    this.calls.push({ sql, params });
    if (sql.includes("SELECT count(*) AS count") && sql.includes("status IN ('pending', 'running')")) {
      return { rows: [{ count: String(this.options.activeCount) }], rowCount: 1 };
    }
    if (sql.includes("SELECT EXISTS")) {
      const exists = this.options.existingDedupeChecks?.shift() ?? false;
      return { rows: [{ exists }], rowCount: 1 };
    }
    if (sql.includes("FROM audit.sync_windows") && sql.includes("window_type = 'historical_export_backfill'")) {
      const state = this.options.windowStates?.shift() ?? null;
      return { rows: state ? [state] : [], rowCount: state ? 1 : 0 };
    }
    if (sql.includes("INSERT INTO audit.sync_jobs")) {
      return {
        rows: [{
          id: "job1",
          job_type: params?.[0],
          merchant_id: params?.[1],
          priority: params?.[2],
          window_start: params?.[3],
          window_end: params?.[4],
          payload: JSON.parse(String(params?.[5] ?? "{}")),
          dedupe_key: params?.[6],
          max_attempts: params?.[7],
          attempt_count: 0,
          status: "pending"
        }],
        rowCount: 1
      };
    }
    return { rows: [], rowCount: 0 };
  }
}

async function callHistoricalEnqueue(scheduler: Scheduler, now: Date) {
  await (scheduler as unknown as {
    enqueueHistoricalBackfill: (now: Date, merchantId: string) => Promise<void>;
  }).enqueueHistoricalBackfill(now, "merchant1");
}
