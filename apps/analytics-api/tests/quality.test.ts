import { describe, expect, it } from "vitest";
import type { DbPool } from "../src/db.js";
import { runDataQualityChecks } from "../src/quality/checks.js";

describe("data quality checks", () => {
  it("checks only paid orders for missing line items and includes detail quality checks", async () => {
    const pool = new QualityPool();

    await runDataQualityChecks(pool as unknown as DbPool, "merchant1");

    const sql = pool.calls.map((call) => call.sql).join("\n");
    const checkNames = pool.calls
      .filter((call) => call.sql.includes("INSERT INTO audit.data_quality_checks"))
      .map((call) => call.params?.[1]);
    expect(checkNames).toContain("orders_without_line_items");
    const ordersWithoutLineItems = pool.calls.find((call) => call.sql.includes("orders_without_line_items") || call.params?.[1] === "orders_without_line_items");
    expect(ordersWithoutLineItems).toBeTruthy();
    expect(sql).toContain("EXISTS");
    expect(sql).toContain("mart.fact_payments");
    expect(checkNames).toContain("hourly_sweep_stale");
    expect(checkNames).toContain("export_reconcile_stale");
    expect(checkNames).toContain("low_detail_score_paid_orders");
    expect(checkNames).toContain("modifier_total_without_modifiers");
    expect(checkNames).toContain("daily_order_count_drop");
    expect(sql).toContain("raw.clover_orders");
  });
});

class QualityPool {
  calls: Array<{ sql: string; params?: unknown[] }> = [];

  async query(sql: string, params?: unknown[]) {
    assertParameterCount(sql, params ?? []);
    this.calls.push({ sql, params });
    if (sql.includes("count(*)::integer AS count")) {
      return { rows: [{ count: 1 }], rowCount: 1 };
    }
    if (sql.includes("AS count")) {
      return { rows: [{ count: 1 }], rowCount: 1 };
    }
    if (sql.includes("UPDATE audit.data_quality_checks")) {
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes("INSERT INTO audit.data_quality_checks")) {
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }
}

function assertParameterCount(sql: string, params: unknown[]) {
  const indexes = [...sql.matchAll(/\$(\d+)/g)].map((match) => Number(match[1]));
  const expected = indexes.length === 0 ? 0 : Math.max(...indexes);
  expect(params).toHaveLength(expected);
}
