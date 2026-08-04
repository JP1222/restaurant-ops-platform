import { describe, expect, it } from "vitest";

import type { AppConfig } from "../src/config.js";
import type { DbPool } from "../src/db.js";
import { Scheduler } from "../src/scheduler/scheduler.js";
import { fakeSyncTargets } from "./helpers/sync-targets.js";
import type { SyncTarget } from "../src/sync-targets/repository.js";

// A pool that returns a row for sync_jobs INSERTs (so mapJob works) and
// exists=false for dedupe checks, capturing every query so we can read the
// enqueued job_types.
class SchedulerPool {
  calls: Array<{ sql: string; params?: unknown[] }> = [];
  async query(sql: string, params?: unknown[]) {
    this.calls.push({ sql, params });
    if (sql.includes("SELECT EXISTS")) {
      return { rows: [{ exists: false }], rowCount: 1 };
    }
    if (sql.includes("INSERT INTO audit.sync_jobs")) {
      return {
        rows: [
          {
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
            status: "pending",
          },
        ],
        rowCount: 1,
      };
    }
    return { rows: [], rowCount: 0 };
  }

  // tick() runs maintenance through withTransaction (pool.connect()); the client
  // delegates to the same query logic.
  async connect() {
    return {
      query: (sql: string, params?: unknown[]) => this.query(sql, params),
      release() {},
    };
  }

  enqueuedJobTypes(): string[] {
    return this.calls
      .filter((c) => c.sql.includes("INSERT INTO audit.sync_jobs"))
      .map((c) => String(c.params?.[0]));
  }
}

const config = {
  hourlySweepOffsetMinutes: 0,
  syncOverlapHours: 6,
  exportWindowStartUtc: "10:00",
  exportWindowEndUtc: "15:00",
  exportHistoricalBackfillWindowShare: 0.4,
  forecastRefreshHourUtc: 16,
  externalReconScanMinIntervalMinutes: 30,
  externalReconMaxConcurrentDays: 1,
} as AppConfig;

// 05:30 UTC: outside the export window (10:00–15:00) and the forecast hour (16),
// so for a Clover target the hourly sweep fires but export/forecast don't — keeps
// the assertion focused on the sweep routing.
const NOW = new Date("2026-06-18T05:30:00.000Z");

function squareTarget(): SyncTarget {
  return { merchantId: "square:LV78H3YNW202D", provider: "square", token: "t", storeTimezone: "UTC", active: true };
}

describe("Scheduler provider routing", () => {
  it("a Square target enqueues square_sweep and NONE of the Clover-only jobs", async () => {
    const pool = new SchedulerPool();
    const scheduler = new Scheduler(pool as unknown as DbPool, config, fakeSyncTargets([squareTarget()]));

    await scheduler.tick(NOW);

    const types = pool.enqueuedJobTypes();
    expect(types).toContain("square_sweep");
    expect(types).not.toContain("hourly_rest_sweep");
    expect(types).not.toContain("export_reconcile");
    expect(types).not.toContain("historical_export_backfill");
    expect(types).not.toContain("external_recon");
  });

  it("a Clover target still enqueues hourly_rest_sweep and never square_sweep (unchanged)", async () => {
    const pool = new SchedulerPool();
    const clover: SyncTarget = {
      merchantId: "clover-1",
      provider: "clover",
      token: "t",
      storeTimezone: "UTC",
      active: true,
    };
    const scheduler = new Scheduler(pool as unknown as DbPool, config, fakeSyncTargets([clover]));

    await scheduler.tick(NOW);

    const types = pool.enqueuedJobTypes();
    expect(types).toContain("hourly_rest_sweep");
    expect(types).not.toContain("square_sweep");
  });
});
