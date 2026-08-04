import { describe, expect, it } from "vitest";
import type { DbPool } from "../src/db.js";
import {
  scoreOrderPayload,
  sourcePriority,
  upsertRawOrders
} from "../src/ingest/raw-repository.js";

describe("raw order detail protection", () => {
  it("scores richer order payloads higher than export shells", () => {
    expect(scoreOrderPayload({ id: "order1" })).toBe(0);
    expect(scoreOrderPayload({
      id: "order1",
      orderType: { id: "dine-in" },
      lineItems: {
        elements: [
          {
            id: "line1",
            alternateName: "Special mix-in",
            modifications: {
              elements: [{ id: "mod1", name: "Oreo", amount: 100 }]
            }
          }
        ]
      }
    })).toBe(4);
  });

  it("orders source priority above export for detail-capable sources", () => {
    expect(sourcePriority("webhook")).toBeGreaterThan(sourcePriority("rest_detail"));
    expect(sourcePriority("rest_detail")).toBeGreaterThan(sourcePriority("hourly_rest_sweep"));
    expect(sourcePriority("hourly_rest_sweep")).toBeGreaterThan(sourcePriority("export"));
  });

  it("writes detail score, source priority, and guarded payload update SQL", async () => {
    const pool = new RawPool();

    await upsertRawOrders(pool as unknown as DbPool, "merchant1", [{
      id: "order1",
      createdTime: 1_714_003_200_000,
      orderType: { id: "dine-in" },
      lineItems: { elements: [{ id: "line1", modifications: { elements: [{ name: "Oreo" }] } }] }
    }], {
      source: "rest_detail",
      window: {
        start: new Date("2026-04-26T00:00:00.000Z"),
        end: new Date("2026-04-27T00:00:00.000Z")
      }
    });

    const insert = pool.calls.find((call) => call.sql.includes("INSERT INTO raw.clover_orders"));
    expect(insert?.sql).toContain("EXCLUDED.detail_score > raw.clover_orders.detail_score");
    expect(insert?.sql).toContain("EXCLUDED.source_priority > raw.clover_orders.source_priority");
    expect(insert?.params?.[9]).toBe(3);
    expect(insert?.params?.[10]).toBe("rest_detail");
    expect(insert?.params?.[11]).toBe(sourcePriority("rest_detail"));
    expect(insert?.params?.[12]).toBeInstanceOf(Date);
  });
});

class RawPool {
  calls: Array<{ sql: string; params?: unknown[] }> = [];

  async connect() {
    return {
      query: (sql: string, params?: unknown[]) => this.query(sql, params),
      release: () => undefined
    };
  }

  async query(sql: string, params?: unknown[]) {
    this.calls.push({ sql, params });
    return { rows: [], rowCount: 0 };
  }
}
