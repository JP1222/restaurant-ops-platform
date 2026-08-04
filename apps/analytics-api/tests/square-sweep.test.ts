import { describe, expect, it } from "vitest";

import type { AppConfig } from "../src/config.js";
import type { DbPool } from "../src/db.js";
import type { SyncJob } from "../src/scheduler/job-repository.js";
import type { SquareClient } from "../src/square/client.js";
import type { JsonRecord } from "../src/types.js";
import { runSquareSweepJob } from "../src/jobs/square-sweep.js";

// Captures every query — both pool.query (sync_cursors, dirty_windows) and the
// transaction-client queries (the raw upserts go through withTransaction →
// pool.connect()).
class CapturePool {
  calls: Array<{ sql: string; params?: unknown[] }> = [];
  async query(sql: string, params?: unknown[]) {
    this.calls.push({ sql, params });
    return { rows: [], rowCount: 0 };
  }
  async connect() {
    const calls = this.calls;
    return {
      async query(sql: string, params?: unknown[]) {
        calls.push({ sql, params });
        return { rows: [], rowCount: 0 };
      },
      release() {},
    };
  }
}

function fakeSquare(over: {
  orders?: JsonRecord[];
  payments?: JsonRecord[];
  refunds?: JsonRecord[];
}): SquareClient {
  return {
    listOrders: async () => over.orders ?? [],
    listPayments: async () => over.payments ?? [],
    listRefunds: async () => over.refunds ?? [],
  } as unknown as SquareClient;
}

const config = { storeTimezone: "UTC" } as AppConfig;

function job(): SyncJob {
  return {
    jobType: "square_sweep",
    merchantId: "square:LV78H3YNW202D",
    payload: { start: "2026-06-18T00:00:00.000Z", end: "2026-06-18T01:00:00.000Z" },
  } as unknown as SyncJob;
}

describe("runSquareSweepJob", () => {
  it("lands orders/payments/refunds in raw.square_*, appends a dirty window + cursor", async () => {
    const pool = new CapturePool();
    const square = fakeSquare({
      orders: [{ id: "O1", createdAt: "2026-06-18T00:30:00Z", updatedAt: "2026-06-18T00:31:00Z" }],
      payments: [{ id: "P1", orderId: "O1", createdAt: "2026-06-18T00:32:00Z" }],
      refunds: [{ id: "R1", paymentId: "P1", orderId: "O1", createdAt: "2026-06-18T00:40:00Z" }],
    });

    const metrics = await runSquareSweepJob(pool as unknown as DbPool, config, square, job());

    const sql = pool.calls.map((c) => c.sql).join("\n");
    expect(sql).toContain("INSERT INTO raw.square_orders");
    expect(sql).toContain("INSERT INTO raw.square_payments");
    expect(sql).toContain("INSERT INTO raw.square_refunds");
    expect(sql).toContain("INSERT INTO audit.dirty_windows");
    expect(sql).toContain("INSERT INTO audit.sync_cursors");

    expect(metrics.metadata).toEqual({ orderCount: 1, paymentCount: 1, refundCount: 1 });
    expect(metrics.rowsRead).toBe(3);
    expect(metrics.rowsWritten).toBe(3);
    expect(metrics.dirtyWindowCount).toBe(1);
    expect(metrics.outputTables).toContain("raw.square_orders");
  });

  it("is a clean no-op when the store has no activity in the window", async () => {
    const pool = new CapturePool();
    const metrics = await runSquareSweepJob(pool as unknown as DbPool, config, fakeSquare({}), job());
    expect(metrics.rowsWritten).toBe(0);
    expect(metrics.metadata).toEqual({ orderCount: 0, paymentCount: 0, refundCount: 0 });
    // Still appends the dirty window so the mart re-derives the (now-empty) range.
    expect(pool.calls.map((c) => c.sql).join("\n")).toContain("INSERT INTO audit.dirty_windows");
  });
});
