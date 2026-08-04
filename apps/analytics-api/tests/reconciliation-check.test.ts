import { describe, expect, it } from "vitest";
import type { AppConfig } from "../src/config.js";
import type { DbPool } from "../src/db.js";
import { reconcileWindow } from "../src/jobs/reconciliation-check.js";

const config = {
  storeTimezone: "America/Chicago"
} as AppConfig;

describe("reconciliation check", () => {
  it("records passed results without repair jobs when raw and mart match", async () => {
    const pool = new ReconciliationPool([matchingDay()]);

    const result = await reconcileWindow(
      pool as unknown as DbPool,
      config,
      "merchant1",
      new Date("2026-04-26T00:00:00.000Z"),
      new Date("2026-04-27T00:00:00.000Z")
    );

    expect(result.failedDays).toBe(0);
    const insert = pool.calls.find((call) => call.sql.includes("INSERT INTO audit.reconciliation_results"));
    expect(insert?.params?.[2]).toBe("passed");
    expect(pool.calls.some((call) => call.sql.includes("INSERT INTO audit.sync_jobs"))).toBe(false);
  });

  it("records failed delta and creates a deduped repair window", async () => {
    const pool = new ReconciliationPool([{ ...matchingDay(), payment_total_delta_cents: 500 }]);

    const result = await reconcileWindow(
      pool as unknown as DbPool,
      config,
      "merchant1",
      new Date("2026-04-26T00:00:00.000Z"),
      new Date("2026-04-27T00:00:00.000Z")
    );

    expect(result.failedDays).toBe(1);
    expect(result.repairJobsCreated).toBe(1);
    const insert = pool.calls.find((call) => call.sql.includes("INSERT INTO audit.reconciliation_results"));
    expect(insert?.params?.[2]).toBe("failed");
    expect(insert?.params?.[4]).toBe(500);
    const repair = pool.calls.find((call) => call.sql.includes("INSERT INTO audit.sync_jobs"));
    expect(repair?.params?.[0]).toBe("repair_window");
    expect(repair?.params?.[6]).toBe("merchant1:repair_window:2026-04-26");
  });
});

class ReconciliationPool {
  calls: Array<{ sql: string; params?: unknown[] }> = [];
  constructor(private readonly rows: unknown[]) {}

  async query(sql: string, params?: unknown[]) {
    this.calls.push({ sql, params });
    if (sql.includes("generate_series")) {
      return { rows: this.rows, rowCount: this.rows.length };
    }
    if (sql.includes("INSERT INTO audit.reconciliation_results")) {
      return { rows: [{ id: "00000000-0000-4000-8000-000000000001" }], rowCount: 1 };
    }
    if (sql.includes("SELECT EXISTS")) {
      return { rows: [{ exists: false }], rowCount: 1 };
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

function matchingDay() {
  return {
    business_date: "2026-04-26",
    raw_order_count: 2,
    mart_order_count: 2,
    order_count_delta: 0,
    raw_payment_total_cents: 1000,
    mart_payment_total_cents: 1000,
    payment_total_delta_cents: 0,
    raw_net_sales_cents: 900,
    mart_net_sales_cents: 900,
    net_sales_delta_cents: 0,
    raw_tax_cents: 80,
    mart_tax_cents: 80,
    tax_delta_cents: 0,
    raw_tip_cents: 20,
    mart_tip_cents: 20,
    tip_delta_cents: 0,
    raw_refund_cents: 100,
    mart_refund_cents: 100,
    refund_delta_cents: 0,
    raw_cash_cents: 400,
    mart_cash_cents: 400,
    cash_delta_cents: 0,
    raw_credit_card_cents: 600,
    mart_credit_card_cents: 600,
    credit_card_delta_cents: 0
  };
}
