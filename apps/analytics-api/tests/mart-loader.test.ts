import { describe, expect, it } from "vitest";
import type { DbPool } from "../src/db.js";
import { refreshMartForRange } from "../src/transform/mart-loader.js";

describe("mart loader modifier fact", () => {
  it("writes one fact_line_item_modifiers row per normalized modifier", async () => {
    const pool = new MartPool();

    await refreshMartForRange(pool as unknown as DbPool, {
      merchantId: "merchant1",
      start: new Date("2026-04-26T00:00:00.000Z"),
      end: new Date("2026-04-27T00:00:00.000Z"),
      timezone: "America/Chicago",
      provider: "clover"
    });

    const modifierInsert = pool.calls.find((call) => call.sql.includes("INSERT INTO mart.fact_line_item_modifiers"));
    expect(modifierInsert).toBeTruthy();
    expect(modifierInsert?.params?.[9]).toBe("Oreo");
    expect(modifierInsert?.params?.[10]).toBe(100);
    expect(pool.calls.some((call) => call.sql.includes("DELETE FROM mart.fact_line_item_modifiers"))).toBe(true);
  });

  it("deduplicates rows that share a batch upsert key", async () => {
    const pool = new MartPool({
      id: "order1",
      createdTime: Date.parse("2026-04-26T17:00:00.000Z"),
      lineItems: {
        elements: [
          {
            id: "line1",
            name: "Vanilla",
            price: 699,
            item: { id: "item1", name: "Vanilla" }
          },
          {
            id: "line2",
            name: "Vanilla",
            price: 699,
            item: { id: "item1", name: "Vanilla" }
          }
        ]
      }
    });

    await refreshMartForRange(pool as unknown as DbPool, {
      merchantId: "merchant1",
      start: new Date("2026-04-26T00:00:00.000Z"),
      end: new Date("2026-04-27T00:00:00.000Z"),
      timezone: "America/Chicago",
      provider: "clover"
    });

    const itemInsert = pool.calls.find((call) => call.sql.includes("INSERT INTO mart.dim_item"));
    const lineItemInsert = pool.calls.find((call) => call.sql.includes("INSERT INTO mart.fact_order_line_items"));

    expect(itemInsert?.params).toHaveLength(5);
    expect(lineItemInsert?.params).toHaveLength(36);
  });
});

describe("mart loader provider dispatch", () => {
  it("a Square merchant reads raw.square_* and maps catalog_object_id → item_id", async () => {
    const squareOrder = {
      id: "sqOrder1",
      createdAt: "2026-04-26T17:00:00.000Z",
      state: "COMPLETED",
      totalMoney: { amount: 575, currency: "USD" },
      lineItems: [
        {
          uid: "L1",
          name: "Vanilla Scoop",
          quantity: "1",
          catalogObjectId: "SQ_ITEM_VANILLA",
          basePriceMoney: { amount: 500, currency: "USD" },
          modifiers: [{ uid: "M1", catalogObjectId: "SQ_MOD_FUDGE", name: "Hot Fudge", totalPriceMoney: { amount: 75 } }]
        }
      ]
    };
    const pool = new MartPool(squareOrder, "square");

    await refreshMartForRange(pool as unknown as DbPool, {
      merchantId: "square:LV78H3YNW202D",
      start: new Date("2026-04-26T00:00:00.000Z"),
      end: new Date("2026-04-27T00:00:00.000Z"),
      timezone: "America/Chicago",
      provider: "square"
    });

    // It read the Square source, NOT Clover.
    expect(pool.calls.some((c) => c.sql.includes("FROM raw.square_orders"))).toBe(true);
    expect(pool.calls.some((c) => c.sql.includes("FROM raw.clover_orders"))).toBe(false);

    const lineItemInsert = pool.calls.find((c) => c.sql.includes("INSERT INTO mart.fact_order_line_items"));
    // item_id is the 8th column (index 7) in the line-item row.
    expect(lineItemInsert?.params?.[7]).toBe("SQ_ITEM_VANILLA");
    const modifierInsert = pool.calls.find((c) => c.sql.includes("INSERT INTO mart.fact_line_item_modifiers"));
    expect(modifierInsert?.params?.[9]).toBe("Hot Fudge");
    expect(modifierInsert?.params?.[10]).toBe(75); // Square totalPriceMoney.amount → cents
  });

  it("refuses an unknown provider before deleting the mart range (fail loud)", async () => {
    const pool = new MartPool();
    await expect(
      refreshMartForRange(pool as unknown as DbPool, {
        merchantId: "merchant1",
        start: new Date("2026-04-26T00:00:00.000Z"),
        end: new Date("2026-04-27T00:00:00.000Z"),
        timezone: "America/Chicago",
        provider: "toast"
      })
    ).rejects.toThrow(/unknown provider/i);
    // The destructive DELETE must NOT have run.
    expect(pool.calls.some((c) => c.sql.includes("DELETE FROM mart."))).toBe(false);
  });
});

class MartPool {
  calls: Array<{ sql: string; params?: unknown[] }> = [];

  constructor(
    private readonly orderPayload: Record<string, unknown> = {
      id: "order1",
      createdTime: Date.parse("2026-04-26T17:00:00.000Z"),
      lineItems: {
        elements: [{
          id: "line1",
          name: "Vanilla",
          price: 699,
          unitQty: 1000,
          modifications: {
            elements: [{ id: "mod1", name: "Oreo", amount: 100 }]
          }
        }]
      }
    },
    private readonly provider: "clover" | "square" = "clover"
  ) {}

  async connect() {
    return {
      query: (sql: string, params?: unknown[]) => this.query(sql, params),
      release: () => undefined
    };
  }

  async query(sql: string, params?: unknown[]) {
    this.calls.push({ sql, params });
    if (sql.includes(`FROM raw.${this.provider}_orders`)) {
      return {
        rows: [{ payload: this.orderPayload }],
        rowCount: 1
      };
    }
    return { rows: [], rowCount: 0 };
  }
}
