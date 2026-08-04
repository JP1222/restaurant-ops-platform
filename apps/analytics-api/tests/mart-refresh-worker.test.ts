import { describe, expect, it } from "vitest";
import type { AppConfig } from "../src/config.js";
import type { DbPool } from "../src/db.js";
import { MartRefreshWorker } from "../src/refresh/mart-refresh-worker.js";
import { fakeSyncTargets } from "./helpers/sync-targets.js";

const config = {
  storeTimezone: "America/Chicago",
  jobStaleAfterMinutes: 30,
  martRefreshIntervalSeconds: 30,
  martMvRefreshMinIntervalSeconds: 60
} as AppConfig;

describe("mart refresh worker", () => {
  it("drains dirty windows until no pending rows remain", async () => {
    const pool = new DirtyWindowPool([
      [dirtyRow("dirty1", "2026-04-26T12:00:00.000Z", "2026-04-26T13:00:00.000Z")],
      [dirtyRow("dirty2", "2026-04-26T13:00:00.000Z", "2026-04-26T14:00:00.000Z")],
      []
    ]);
    const refreshed: string[] = [];
    let mvRefreshes = 0;
    const worker = new MartRefreshWorker(pool as unknown as DbPool, config, fakeSyncTargets(), {
      withRefreshLock: async (_merged, task) => task(),
      refreshRange: async (_pool, options) => {
        refreshed.push(`${options.start.toISOString()}-${options.end.toISOString()}`);
      },
      refreshMaterializedViews: async () => {
        mvRefreshes += 1;
        return true;
      }
    });

    const claims = await worker.tick();

    expect(claims).toBe(2);
    expect(refreshed).toHaveLength(2);
    expect(pool.markedRefreshed).toHaveLength(2);
    expect(mvRefreshes).toBe(1);
  });

  it("keeps newly claimed dirty rows separate by claim token", async () => {
    const pool = new DirtyWindowPool([
      [dirtyRow("first", "2026-04-26T12:00:00.000Z", "2026-04-26T13:00:00.000Z")],
      [dirtyRow("new", "2026-04-26T13:00:00.000Z", "2026-04-26T14:00:00.000Z")],
      []
    ]);
    const worker = new MartRefreshWorker(pool as unknown as DbPool, config, fakeSyncTargets(), {
      withRefreshLock: async (_merged, task) => task(),
      refreshRange: async () => {},
      refreshMaterializedViews: async () => true
    });

    await worker.tick();

    expect(new Set(pool.markedRefreshed).size).toBe(2);
  });

  it("requeues retryable failed dirty windows before claiming pending rows", async () => {
    const pool = new DirtyWindowPool([]);
    const worker = new MartRefreshWorker(pool as unknown as DbPool, config, fakeSyncTargets(), {
      withRefreshLock: async (_merged, task) => task(),
      refreshRange: async () => {},
      refreshMaterializedViews: async () => true
    });

    await worker.tick();

    expect(pool.calls[0]!.sql).toContain("status = 'refreshing'");
    expect(pool.calls[1]!.sql).toContain("SET status = 'pending'");
    expect(pool.calls[1]!.sql).toContain("status = 'failed'");
    expect(pool.calls[1]!.sql).toContain("ON CONFLICT DO UPDATE command cannot affect row a second time");
  });

  it("recovers stale refreshing dirty windows before claiming pending rows", async () => {
    const pool = new DirtyWindowPool([]);
    const worker = new MartRefreshWorker(pool as unknown as DbPool, config, fakeSyncTargets(), {
      withRefreshLock: async (_merged, task) => task(),
      refreshRange: async () => {},
      refreshMaterializedViews: async () => true
    });

    await worker.tick();

    expect(pool.calls[0]!.sql).toContain("status = 'refreshing'");
    expect(pool.calls[0]!.params).toEqual(["30 minutes"]);
  });
});

type DirtyWindowRow = {
  id: string;
  merchant_id: string;
  business_date_start: string;
  business_date_end: string;
  utc_start: Date;
  utc_end: Date;
  reason: string;
  priority: number;
};

class DirtyWindowPool {
  calls: Array<{ sql: string; params?: unknown[] }> = [];
  markedRefreshed: string[] = [];

  constructor(private readonly claims: DirtyWindowRow[][]) {}

  async query(sql: string, params?: unknown[]) {
    this.calls.push({ sql, params });

    if (sql.includes("RETURNING *")) {
      return { rows: this.claims.shift() ?? [], rowCount: 0 };
    }

    if (sql.includes("SET status = 'refreshed'")) {
      this.markedRefreshed.push(String(params?.[0]));
      return { rows: [], rowCount: 1 };
    }

    return { rows: [], rowCount: 0 };
  }
}

function dirtyRow(id: string, start: string, end: string): DirtyWindowRow {
  return {
    id,
    merchant_id: "merchant1",
    business_date_start: "2026-04-26",
    business_date_end: "2026-04-26",
    utc_start: new Date(start),
    utc_end: new Date(end),
    reason: "test",
    priority: 100
  };
}
