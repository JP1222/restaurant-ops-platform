import { describe, expect, it } from "vitest";
import type { AppConfig } from "../src/config.js";
import type { DbPool } from "../src/db.js";
import { runOrderDetailHydrationJob } from "../src/jobs/order-detail-hydration.js";
import type { SyncJob } from "../src/scheduler/job-repository.js";

const config = {
  storeTimezone: "America/Chicago"
} as AppConfig;

describe("order detail hydration job", () => {
  it("hydrates successful orders and records failed samples without blocking the batch", async () => {
    const pool = new HydrationPool();
    const clover = {
      fetchOrderWithDetails: async (orderId: string) => {
        if (orderId === "bad") {
          throw new Error("not found");
        }
        return {
          id: orderId,
          createdTime: 1_714_003_200_000,
          orderType: { id: "dine-in" },
          lineItems: { elements: [{ id: "line1", modifications: { elements: [{ name: "Oreo" }] } }] }
        };
      }
    };

    const metrics = await runOrderDetailHydrationJob(
      pool as unknown as DbPool,
      config,
      clover as never,
      hydrationJob(["good", "bad"])
    );

    expect(metrics.rowsRead).toBe(2);
    expect(metrics.rowsWritten).toBe(1);
    expect(metrics.dirtyWindowCount).toBe(1);
    expect(pool.exportSummary).toMatchObject({
      orderDetailSucceeded: 1,
      orderDetailFailed: 1,
      failedOrderIdsSample: ["bad"]
    });
    expect(pool.calls.some((call) => call.sql.includes("INSERT INTO raw.clover_orders"))).toBe(true);
    expect(pool.calls.some((call) => call.sql.includes("INSERT INTO audit.dirty_windows"))).toBe(true);
  });

  it("fails the hydration job when every detail fetch fails so normal job retry can run", async () => {
    const pool = new HydrationPool();
    const clover = {
      fetchOrderWithDetails: async () => {
        throw new Error("temporary outage");
      }
    };

    await expect(runOrderDetailHydrationJob(
      pool as unknown as DbPool,
      config,
      clover as never,
      hydrationJob(["bad"])
    )).rejects.toThrow("Order detail hydration failed");
  });
});

class HydrationPool {
  calls: Array<{ sql: string; params?: unknown[] }> = [];
  exportSummary: unknown = {};

  async connect() {
    return {
      query: (sql: string, params?: unknown[]) => this.query(sql, params),
      release: () => undefined
    };
  }

  async query(sql: string, params?: unknown[]) {
    this.calls.push({ sql, params });
    if (sql.includes("SELECT import_summary")) {
      return { rows: [{ import_summary: this.exportSummary }], rowCount: 1 };
    }
    if (sql.includes("UPDATE raw.clover_exports")) {
      this.exportSummary = JSON.parse(String(params?.[1] ?? "{}"));
    }
    return { rows: [], rowCount: 0 };
  }
}

function hydrationJob(orderIds: string[]): SyncJob {
  return {
    id: "job1",
    jobType: "order_detail_hydration",
    merchantId: "merchant1",
    status: "running",
    priority: 45,
    windowStart: new Date("2026-04-26T00:00:00.000Z"),
    windowEnd: new Date("2026-04-27T00:00:00.000Z"),
    payload: {
      orderIds,
      rawExportId: "00000000-0000-4000-8000-000000000001",
      start: "2026-04-26T00:00:00.000Z",
      end: "2026-04-27T00:00:00.000Z"
    },
    dedupeKey: null,
    attemptCount: 0,
    maxAttempts: 5
  };
}
