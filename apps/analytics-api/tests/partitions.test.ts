import { describe, expect, it } from "vitest";
import type { DbPool } from "../src/db.js";
import {
  dropOldSyncRunsPartitions,
  ensureSyncRunsMonthlyPartition,
  ensureSyncRunsMonthlyPartitions,
  nextMonth
} from "../src/lib/partitions.js";

describe("sync_runs partition maintenance", () => {
  it("creates current and next month partitions idempotently", async () => {
    const pool = new PartitionPool();

    await ensureSyncRunsMonthlyPartitions(pool as unknown as DbPool, new Date("2026-04-26T12:00:00.000Z"));

    const sql = pool.calls.map((call) => call.sql).join("\n");
    expect(sql).toContain("BEGIN");
    expect(sql).toContain("LOCK TABLE audit.sync_runs, audit.sync_runs_default IN SHARE MODE");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS audit.\"sync_runs_2026m04\"");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS audit.\"sync_runs_2026m05\"");
    expect(sql).toContain("COMMIT");
    expect(partitionMoveIsAtomic(pool.calls, "sync_runs_2026m04", "2026-04", "2026-05")).toBe(true);
    expect(partitionMoveIsAtomic(pool.calls, "sync_runs_2026m05", "2026-05", "2026-06")).toBe(true);
  });

  it("rolls back partition creation when attach fails", async () => {
    const pool = new PartitionPool([], "ATTACH PARTITION");

    await expect(ensureSyncRunsMonthlyPartition(pool as unknown as DbPool, "2026-04"))
      .rejects.toThrow("forced query failure");

    const sql = pool.calls.map((call) => call.sql);
    expect(sql).toContain("BEGIN");
    expect(sql.some((entry) => entry.includes("LOCK TABLE audit.sync_runs"))).toBe(true);
    expect(sql).toContain("ROLLBACK");
    expect(pool.releaseCount).toBe(1);
  });

  it("drops monthly partitions that end before the retention cutoff but keeps default", async () => {
    const pool = new PartitionPool([
      { relname: "sync_runs_2026m01" },
      { relname: "sync_runs_2026m02" },
      { relname: "sync_runs_default" }
    ]);

    const dropped = await dropOldSyncRunsPartitions(pool as unknown as DbPool, new Date("2026-02-15T00:00:00.000Z"));

    expect(dropped).toEqual(["sync_runs_2026m01"]);
    expect(pool.calls.some((call) => call.sql.includes("DROP TABLE IF EXISTS audit.\"sync_runs_default\""))).toBe(false);
  });

  it("calculates next month across year boundaries", () => {
    expect(nextMonth("2026-12")).toBe("2027-01");
  });
});

class PartitionPool {
  calls: Array<{ sql: string; params?: unknown[] }> = [];
  releaseCount = 0;
  constructor(
    private readonly rows: Array<{ relname: string }> = [],
    private readonly failOn?: string
  ) {}

  async connect() {
    return {
      query: (sql: string, params?: unknown[]) => this.query(sql, params),
      release: () => {
        this.releaseCount += 1;
      }
    };
  }

  async query(sql: string, params?: unknown[]) {
    this.calls.push({ sql, params });
    if (this.failOn && sql.includes(this.failOn)) {
      throw new Error("forced query failure");
    }
    if (sql.includes("SELECT EXISTS")) {
      return { rows: [{ exists: false }], rowCount: 1 };
    }
    if (sql.includes("FROM pg_class")) {
      return { rows: this.rows, rowCount: this.rows.length };
    }
    return { rows: [], rowCount: 0 };
  }
}

function partitionMoveIsAtomic(
  calls: Array<{ sql: string }>,
  partitionName: string,
  startMonth: string,
  endMonth: string
) {
  const insertIndex = calls.findIndex((call) => call.sql.includes(`INSERT INTO audit."${partitionName}"`));
  const deleteIndex = calls.findIndex((call, index) =>
    index > insertIndex
    && call.sql.includes("DELETE FROM audit.sync_runs_default")
    && call.sql.includes(`created_at >= '${startMonth}-01'`)
    && call.sql.includes(`created_at < '${endMonth}-01'`)
  );
  const attachIndex = calls.findIndex((call, index) =>
    index > deleteIndex && call.sql.includes(`ATTACH PARTITION audit."${partitionName}"`)
  );
  const beginIndex = calls.findLastIndex((call, index) => index < insertIndex && call.sql.includes("BEGIN"));
  const commitIndex = calls.findIndex((call, index) => index > attachIndex && call.sql.includes("COMMIT"));
  return beginIndex >= 0 && beginIndex < insertIndex && insertIndex < deleteIndex && deleteIndex < attachIndex && attachIndex < commitIndex;
}
