import { describe, expect, it } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AppConfig } from "../src/config.js";
import type { DbPool } from "../src/db.js";
import { handleInventorySoldItems } from "../src/http/inventory-feed.js";

type QueryCall = { sql: string; params?: unknown[] };

const config = { adminToken: "admin-secret" } as AppConfig;

class MockPool {
  calls: QueryCall[] = [];

  constructor(private readonly results: Array<{ rows?: unknown[]; rowCount?: number }> = []) {}

  async query(sql: string, params?: unknown[]) {
    this.calls.push({ sql, params });
    return this.results.shift() ?? { rows: [], rowCount: 0 };
  }
}

function httpPair(headers: Record<string, string> = {}) {
  const req = { method: "GET", headers } as IncomingMessage;

  const body = { value: "" };
  const res = {
    statusCode: 0,
    headers: {} as Record<string, string>,
    setHeader(key: string, value: string) {
      this.headers[key] = value;
    },
    end(chunk = "") {
      body.value = chunk;
    },
  } as ServerResponse & { headers: Record<string, string> };

  return { req, res, body };
}

const authHeaders = { authorization: "Bearer admin-secret" };

describe("handleInventorySoldItems modifiers", () => {
  it("rejects unauthorized requests", async () => {
    const pool = new MockPool();
    const { req, res, body } = httpPair();

    await handleInventorySoldItems(
      req,
      res,
      pool as unknown as DbPool,
      config,
      new URL("http://localhost/admin/api/inventory/sold-items?merchantId=M1"),
    );

    expect(res.statusCode).toBe(401);
    expect(JSON.parse(body.value)).toEqual({ error: "unauthorized" });
    expect(pool.calls).toHaveLength(0);
  });

  it("queries fact_line_item_modifiers by line_item_id + merchant_id", async () => {
    const pool = new MockPool([{ rows: [] }]);
    const { req, res } = httpPair(authHeaders);

    await handleInventorySoldItems(
      req,
      res,
      pool as unknown as DbPool,
      config,
      new URL("http://localhost/admin/api/inventory/sold-items?merchantId=M1"),
    );

    expect(pool.calls).toHaveLength(1);
    const sql = pool.calls[0]!.sql;
    expect(sql).toContain("mart.fact_line_item_modifiers");
    expect(sql).toContain("array_agg(m.modifier_name");
    expect(sql).toContain("m.line_item_id = li.line_item_id");
    expect(sql).toContain("m.merchant_id = li.merchant_id");
    // Existing contract preserved: inclusive watermark + refunded filter + ASC order.
    expect(sql).toContain("li.refunded = false");
    expect(sql).toContain("li.created_at_utc >= $2");
    expect(sql).toContain("ORDER BY li.created_at_utc ASC");
  });

  it("maps modifier_names into the modifiers field and defaults to []", async () => {
    const created = new Date("2026-06-01T12:00:00.000Z");
    const pool = new MockPool([
      {
        rows: [
          {
            line_item_id: "li-with-mods",
            item_id: "clv-a",
            item_name: "Vanilla Roll",
            quantity: "2",
            created_at_utc: created,
            modifier_names: ["Extra Avocado", "Spicy Mayo"],
          },
          {
            line_item_id: "li-no-mods",
            item_id: "clv-b",
            item_name: "Plain Roll",
            quantity: "1",
            created_at_utc: created,
            modifier_names: null,
          },
        ],
      },
    ]);
    const { req, res, body } = httpPair(authHeaders);

    await handleInventorySoldItems(
      req,
      res,
      pool as unknown as DbPool,
      config,
      new URL("http://localhost/admin/api/inventory/sold-items?merchantId=M1"),
    );

    expect(res.statusCode).toBe(200);
    const parsed = JSON.parse(body.value) as {
      items: Array<{ line_item_id: string; modifiers: string[] }>;
      cursor: string;
    };

    const withMods = parsed.items.find((i) => i.line_item_id === "li-with-mods");
    const noMods = parsed.items.find((i) => i.line_item_id === "li-no-mods");

    expect(withMods?.modifiers).toEqual(["Extra Avocado", "Spicy Mayo"]);
    expect(noMods?.modifiers).toEqual([]);
    expect(parsed.cursor).toBe(created.toISOString());
  });

  it("routes item_id to clover_item_id for a Clover store (square id null)", async () => {
    const created = new Date("2026-06-01T12:00:00.000Z");
    const pool = new MockPool([
      { rows: [{ line_item_id: "li1", item_id: "clv-a", item_name: "Roll", quantity: "1", created_at_utc: created, modifier_names: [] }] },
    ]);
    const { req, res, body } = httpPair(authHeaders);
    await handleInventorySoldItems(
      req,
      res,
      pool as unknown as DbPool,
      config,
      new URL("http://localhost/admin/api/inventory/sold-items?merchantId=M1"),
    );
    const item = (JSON.parse(body.value) as { items: Array<{ clover_item_id: string | null; square_catalog_item_id: string | null }> }).items[0];
    expect(item?.clover_item_id).toBe("clv-a");
    expect(item?.square_catalog_item_id).toBeNull();
  });

  it("routes item_id to square_catalog_item_id for a square:{loc} store (clover id null)", async () => {
    const created = new Date("2026-06-01T12:00:00.000Z");
    const pool = new MockPool([
      { rows: [{ line_item_id: "li1", item_id: "SQ_ITEM_VANILLA", item_name: "Vanilla", quantity: "1", created_at_utc: created, modifier_names: [] }] },
    ]);
    const { req, res, body } = httpPair(authHeaders);
    await handleInventorySoldItems(
      req,
      res,
      pool as unknown as DbPool,
      config,
      new URL("http://localhost/admin/api/inventory/sold-items?merchantId=square:LV78H3YNW202D"),
    );
    const item = (JSON.parse(body.value) as { items: Array<{ clover_item_id: string | null; square_catalog_item_id: string | null }> }).items[0];
    expect(item?.square_catalog_item_id).toBe("SQ_ITEM_VANILLA");
    expect(item?.clover_item_id).toBeNull();
  });

  it("defensively drops null/blank modifier names", async () => {
    const created = new Date("2026-06-01T12:00:00.000Z");
    const pool = new MockPool([
      {
        rows: [
          {
            line_item_id: "li-dirty",
            item_id: "clv-a",
            item_name: "Vanilla Roll",
            quantity: "1",
            created_at_utc: created,
            // pg can't actually return nulls inside array_agg over a NOT NULL
            // column, but guard the mapping anyway.
            modifier_names: ["Good", "", null as unknown as string, "Also Good"],
          },
        ],
      },
    ]);
    const { req, res, body } = httpPair(authHeaders);

    await handleInventorySoldItems(
      req,
      res,
      pool as unknown as DbPool,
      config,
      new URL("http://localhost/admin/api/inventory/sold-items?merchantId=M1"),
    );

    const parsed = JSON.parse(body.value) as {
      items: Array<{ modifiers: string[] }>;
    };
    expect(parsed.items[0]?.modifiers).toEqual(["Good", "Also Good"]);
  });
});
