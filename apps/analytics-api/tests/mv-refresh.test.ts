import { describe, expect, it } from "vitest";
import type { AppConfig } from "../src/config.js";
import type { DbPool } from "../src/db.js";
import {
  refreshMaterializedViews,
  refreshMaterializedViewsThrottled
} from "../src/refresh/mv-refresh.js";

// Independent copy of the production order: pins the refresh sequence so an
// accidental reorder fails here. cost_daily_mv reads sales_daily_mv, so it must
// follow it (see src/refresh/mv-refresh.ts).
const MATERIALIZED_VIEWS = [
  "mart.sales_daily_mv",
  "mart.cost_daily_mv",
  "mart.prime_cost_daily_mv",
  "mart.cost_variance_daily_mv",
  "mart.sales_hourly_mv",
  "mart.item_sales_daily_mv",
  "mart.payment_method_daily_mv",
  "mart.employee_sales_daily_mv",
  "mart.item_sales_hourly_mv"
];

describe("refreshMaterializedViews", () => {
  it("refreshes every materialized view inside a single transaction", async () => {
    const pool = new FakeMvRefreshPool();

    const ran = await refreshMaterializedViews(pool as unknown as DbPool);

    expect(ran).toBe(true);
    expect(pool.transactions).toHaveLength(1);
    const tx = pool.transactions[0]!;
    expect(tx.committed).toBe(true);
    expect(tx.rolledBack).toBe(false);
    expect(tx.refreshed).toEqual(MATERIALIZED_VIEWS);
    // Atomicity guard: REFRESH must appear bracketed by BEGIN/COMMIT.
    // The fake throws if any REFRESH is issued outside a transaction.
    const beginIdx = pool.queries.indexOf("BEGIN");
    const commitIdx = pool.queries.indexOf("COMMIT");
    expect(beginIdx).toBeGreaterThanOrEqual(0);
    expect(commitIdx).toBeGreaterThan(beginIdx);
    const refreshesBetween = pool.queries
      .slice(beginIdx, commitIdx)
      .filter((q) => q.startsWith("REFRESH MATERIALIZED VIEW"));
    expect(refreshesBetween).toHaveLength(MATERIALIZED_VIEWS.length);
  });

  it("includes item_sales_hourly_mv in the cycle", async () => {
    const pool = new FakeMvRefreshPool();
    await refreshMaterializedViews(pool as unknown as DbPool);
    expect(pool.transactions[0]!.refreshed).toContain("mart.item_sales_hourly_mv");
  });

  it("uses REFRESH MATERIALIZED VIEW without CONCURRENTLY so it can run inside the transaction", async () => {
    const pool = new FakeMvRefreshPool();
    await refreshMaterializedViews(pool as unknown as DbPool);
    for (const sql of pool.transactions[0]!.allStatements) {
      if (sql.startsWith("REFRESH MATERIALIZED VIEW")) {
        expect(sql).not.toContain("CONCURRENTLY");
      }
    }
  });

  it("rolls back every prior refresh when any view fails mid-batch", async () => {
    const pool = new FakeMvRefreshPool({
      failOnView: "mart.item_sales_daily_mv",
      failTimes: Infinity
    });

    await expect(refreshMaterializedViews(pool as unknown as DbPool)).rejects.toThrow(/boom/);

    // We attempted the batch twice (one retry); both ended in ROLLBACK.
    expect(pool.transactions).toHaveLength(2);
    for (const tx of pool.transactions) {
      expect(tx.committed).toBe(false);
      expect(tx.rolledBack).toBe(true);
      // Each tx began the refresh sequence but stopped at the failing view —
      // sales_daily_mv, cost_daily_mv, prime_cost_daily_mv, cost_variance_daily_mv,
      // sales_hourly_mv attempted, item_sales_daily_mv failed, the rest never ran.
      expect(tx.refreshed).toEqual([
        "mart.sales_daily_mv",
        "mart.cost_daily_mv",
        "mart.prime_cost_daily_mv",
        "mart.cost_variance_daily_mv",
        "mart.sales_hourly_mv"
      ]);
    }
  });

  it("retries the batch once on transient failure and commits on the second attempt", async () => {
    const pool = new FakeMvRefreshPool({
      failOnView: "mart.sales_hourly_mv",
      failTimes: 1
    });

    const ran = await refreshMaterializedViews(pool as unknown as DbPool);

    expect(ran).toBe(true);
    expect(pool.transactions).toHaveLength(2);
    // First attempt: rolled back at the failing view.
    expect(pool.transactions[0]!.rolledBack).toBe(true);
    expect(pool.transactions[0]!.committed).toBe(false);
    // Second attempt: fully refreshed and committed.
    expect(pool.transactions[1]!.committed).toBe(true);
    expect(pool.transactions[1]!.rolledBack).toBe(false);
    expect(pool.transactions[1]!.refreshed).toEqual(MATERIALIZED_VIEWS);
  });

  it("acquires the advisory lock before refreshing and releases it after", async () => {
    const pool = new FakeMvRefreshPool();
    await refreshMaterializedViews(pool as unknown as DbPool);

    const lockCalls = pool.queries.filter((q) => q.includes("pg_try_advisory_lock"));
    const unlockCalls = pool.queries.filter((q) => q.includes("pg_advisory_unlock"));
    expect(lockCalls).toHaveLength(1);
    expect(unlockCalls).toHaveLength(1);
  });

  it("yields without refreshing when another session already holds the advisory lock", async () => {
    const pool = new FakeMvRefreshPool({ advisoryLockBusy: true });

    const ran = await refreshMaterializedViews(pool as unknown as DbPool);

    expect(ran).toBe(false);
    expect(pool.transactions).toHaveLength(0);
  });

  it("never leaves sales_daily_mv refreshed while sales_hourly_mv is stale (issue #149)", async () => {
    // If the hourly view fails, the daily view's refresh inside the same
    // transaction must roll back — otherwise the dashboard shows daily
    // totals that don't reconcile against hourly buckets.
    const pool = new FakeMvRefreshPool({
      failOnView: "mart.sales_hourly_mv",
      failTimes: Infinity
    });

    await expect(refreshMaterializedViews(pool as unknown as DbPool)).rejects.toThrow();

    for (const tx of pool.transactions) {
      expect(tx.committed).toBe(false);
      expect(tx.rolledBack).toBe(true);
      // sales_daily_mv was REFRESHed inside the tx, but the tx rolled back —
      // so from the database's perspective it was never refreshed.
      expect(tx.refreshed).toContain("mart.sales_daily_mv");
      expect(tx.refreshed).not.toContain("mart.sales_hourly_mv");
    }
  });
});

// GH #482: the throttle window must advance ONLY after a successful refresh, so
// a failed refresh does not mask itself for a window. These tests use the same
// FakeMvRefreshPool, extended to model the audit.refresh_state gate.
describe("refreshMaterializedViewsThrottled throttle ordering (GH #482)", () => {
  const config = { martMvRefreshMinIntervalSeconds: 60 } as unknown as AppConfig;

  it("advances the throttle ONLY after the refresh commits", async () => {
    const pool = new FakeMvRefreshPool({ shouldRefresh: true });

    const ran = await refreshMaterializedViewsThrottled(pool as unknown as DbPool, config);

    expect(ran).toBe(true);
    expect(pool.transactions[0]?.committed).toBe(true);
    expect(pool.throttleAdvanced).toBe(true); // updated_at = now() issued
  });

  it("does NOT advance the throttle when the refresh fails, so the next tick retries", async () => {
    const pool = new FakeMvRefreshPool({
      shouldRefresh: true,
      failOnView: "mart.sales_daily_mv",
      failTimes: Infinity
    });

    await expect(
      refreshMaterializedViewsThrottled(pool as unknown as DbPool, config)
    ).rejects.toThrow();

    // The whole point of #482: a failed refresh leaves updated_at untouched, so
    // should_refresh stays true on the next call instead of masking the failure.
    expect(pool.throttleAdvanced).toBe(false);
  });

  it("skips the refresh (and never advances) while inside the throttle window", async () => {
    const pool = new FakeMvRefreshPool({ shouldRefresh: false });

    const ran = await refreshMaterializedViewsThrottled(pool as unknown as DbPool, config);

    expect(ran).toBe(false);
    expect(pool.transactions).toHaveLength(0);
    expect(pool.throttleAdvanced).toBe(false);
  });

  it("does not advance the throttle when another session holds the advisory lock", async () => {
    const pool = new FakeMvRefreshPool({ shouldRefresh: true, advisoryLockBusy: true });

    const ran = await refreshMaterializedViewsThrottled(pool as unknown as DbPool, config);

    expect(ran).toBe(false);
    expect(pool.throttleAdvanced).toBe(false); // the lock-holder advances on its own success
  });
});

type FakeMvRefreshOptions = {
  failOnView?: string;
  failTimes?: number;
  advisoryLockBusy?: boolean;
  shouldRefresh?: boolean;
};

type FakeTransaction = {
  committed: boolean;
  rolledBack: boolean;
  refreshed: string[];
  allStatements: string[];
};

class FakeMvRefreshPool {
  /** Every SQL string seen anywhere — pool.query or any client.query. */
  queries: string[] = [];
  /** One record per BEGIN ... COMMIT|ROLLBACK block. */
  transactions: FakeTransaction[] = [];
  /** GH #482: set true when `UPDATE audit.refresh_state SET updated_at = now()` runs. */
  throttleAdvanced = false;
  private failuresRemaining: number;
  private advisoryLockHeld = false;

  constructor(private readonly options: FakeMvRefreshOptions = {}) {
    this.failuresRemaining = options.failTimes ?? 0;
  }

  async query(sql: string): Promise<{ rows: unknown[]; rowCount: number }> {
    return this.runStatement(sql, null);
  }

  async connect() {
    const ownedTx: { current: FakeTransaction | null } = { current: null };
    return {
      query: async (sql: string) => this.runStatement(sql, ownedTx),
      release: () => {
        if (ownedTx.current && !ownedTx.current.committed && !ownedTx.current.rolledBack) {
          throw new Error("client released while still inside transaction");
        }
      }
    };
  }

  private async runStatement(
    sql: string,
    ownedTx: { current: FakeTransaction | null } | null
  ): Promise<{ rows: unknown[]; rowCount: number }> {
    this.queries.push(sql);

    // GH #482 throttle gate: read-only staleness check. Returns the configured
    // should_refresh without advancing updated_at (mirrors the source's
    // self-assignment no-op).
    if (sql.includes("INSERT INTO audit.refresh_state")) {
      return { rows: [{ should_refresh: this.options.shouldRefresh ?? true }], rowCount: 1 };
    }
    // GH #482 throttle advance: only issued after a successful refresh.
    if (sql.includes("UPDATE audit.refresh_state")) {
      this.throttleAdvanced = true;
      return { rows: [], rowCount: 1 };
    }

    if (sql.includes("pg_try_advisory_lock")) {
      const locked = !this.options.advisoryLockBusy && !this.advisoryLockHeld;
      if (locked) {
        this.advisoryLockHeld = true;
      }
      return { rows: [{ locked }], rowCount: 1 };
    }
    if (sql.includes("pg_advisory_unlock")) {
      this.advisoryLockHeld = false;
      return { rows: [{ unlocked: true }], rowCount: 1 };
    }

    if (sql === "BEGIN" || sql.startsWith("BEGIN")) {
      if (!ownedTx) {
        throw new Error("BEGIN issued on the pool directly — withTransaction must use a client");
      }
      const tx: FakeTransaction = {
        committed: false,
        rolledBack: false,
        refreshed: [],
        allStatements: []
      };
      ownedTx.current = tx;
      this.transactions.push(tx);
      return { rows: [], rowCount: 0 };
    }
    if (sql === "COMMIT" || sql.startsWith("COMMIT")) {
      if (!ownedTx?.current) {
        throw new Error("COMMIT without active transaction");
      }
      ownedTx.current.committed = true;
      ownedTx.current = null;
      return { rows: [], rowCount: 0 };
    }
    if (sql === "ROLLBACK" || sql.startsWith("ROLLBACK")) {
      if (!ownedTx?.current) {
        throw new Error("ROLLBACK without active transaction");
      }
      ownedTx.current.rolledBack = true;
      ownedTx.current = null;
      return { rows: [], rowCount: 0 };
    }

    const refreshMatch = sql.match(/^REFRESH MATERIALIZED VIEW (?:CONCURRENTLY )?(\S+)/);
    if (refreshMatch) {
      if (!ownedTx?.current) {
        throw new Error(`REFRESH outside transaction (atomicity violated): ${sql}`);
      }
      const tx = ownedTx.current;
      tx.allStatements.push(sql);
      const view = refreshMatch[1]!;
      if (this.options.failOnView === view && this.failuresRemaining > 0) {
        this.failuresRemaining -= 1;
        throw new Error(`boom: refresh failed for ${view}`);
      }
      tx.refreshed.push(view);
      return { rows: [], rowCount: 0 };
    }

    if (ownedTx?.current) {
      ownedTx.current.allStatements.push(sql);
    }
    return { rows: [], rowCount: 0 };
  }
}
