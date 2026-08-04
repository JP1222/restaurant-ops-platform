import type { IncomingMessage, ServerResponse } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { startAnalyticsItContext, type AnalyticsItContext } from "./fixture.js";
import type { AppConfig } from "../../src/config.js";
import type { DbPool } from "../../src/db.js";
import { handleInventorySoldItems } from "../../src/http/inventory-feed.js";

// Exercises the real sold-items feed query against Postgres, proving the
// per-line `modifiers` array is sourced from mart.fact_line_item_modifiers
// (joined on line_item_id + merchant_id) and defaults to [] when none exist.
const config = { adminToken: "admin-secret" } as AppConfig;

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

interface SoldItem {
  line_item_id: string;
  clover_item_id: string | null;
  item_name: string;
  quantity: number;
  modifiers: string[];
}

async function fetchSoldItems(pool: DbPool): Promise<SoldItem[]> {
  const { req, res, body } = httpPair(authHeaders);
  await handleInventorySoldItems(
    req,
    res,
    pool,
    config,
    new URL("http://localhost/admin/api/inventory/sold-items?merchantId=M1"),
  );
  expect(res.statusCode).toBe(200);
  return (JSON.parse(body.value) as { items: SoldItem[] }).items;
}

describe("inventory sold-items feed modifiers (real Postgres)", () => {
  let ctx: AnalyticsItContext;

  beforeAll(async () => {
    ctx = await startAnalyticsItContext();
  });

  afterAll(async () => {
    await ctx?.stop();
  });

  beforeEach(async () => {
    await ctx.pool.query(
      "TRUNCATE mart.fact_order_line_items, mart.fact_line_item_modifiers",
    );
  });

  it("returns the selected modifier names per line item", async () => {
    await ctx.pool.query(`
      INSERT INTO mart.fact_order_line_items
        (merchant_id, order_id, line_item_fingerprint, line_item_id, business_date,
         created_at_utc, item_fingerprint, item_id, item_name, quantity, refunded)
      VALUES
        ('M1','o1','li-fp-1','li-1', CURRENT_DATE,
         '2026-06-01T12:00:00Z','fp-a','clv-a','Custom Roll', 2, false)
    `);
    await ctx.pool.query(`
      INSERT INTO mart.fact_line_item_modifiers
        (merchant_id, order_id, line_item_fingerprint, line_item_modifier_fingerprint,
         line_item_id, business_date, item_fingerprint, modifier_name)
      VALUES
        ('M1','o1','li-fp-1','mod-fp-1','li-1', CURRENT_DATE, 'fp-a','Extra Avocado'),
        ('M1','o1','li-fp-1','mod-fp-2','li-1', CURRENT_DATE, 'fp-a','Spicy Mayo')
    `);

    const items = await fetchSoldItems(ctx.pool);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      line_item_id: "li-1",
      clover_item_id: "clv-a",
      item_name: "Custom Roll",
      quantity: 2,
      // array_agg is ordered by modifier_name
      modifiers: ["Extra Avocado", "Spicy Mayo"],
    });
  });

  it("returns modifiers: [] for a line with no modifiers", async () => {
    await ctx.pool.query(`
      INSERT INTO mart.fact_order_line_items
        (merchant_id, order_id, line_item_fingerprint, line_item_id, business_date,
         created_at_utc, item_fingerprint, item_id, item_name, quantity, refunded)
      VALUES
        ('M1','o2','li-fp-2','li-2', CURRENT_DATE,
         '2026-06-01T12:05:00Z','fp-b','clv-b','Plain Roll', 1, false)
    `);

    const items = await fetchSoldItems(ctx.pool);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ line_item_id: "li-2", modifiers: [] });
  });

  it("scopes modifiers to the same merchant + line item", async () => {
    await ctx.pool.query(`
      INSERT INTO mart.fact_order_line_items
        (merchant_id, order_id, line_item_fingerprint, line_item_id, business_date,
         created_at_utc, item_fingerprint, item_id, item_name, quantity, refunded)
      VALUES
        ('M1','o3','li-fp-3','li-3', CURRENT_DATE,
         '2026-06-01T12:10:00Z','fp-c','clv-c','Custom Roll', 1, false)
    `);
    // A modifier row for a DIFFERENT merchant that happens to reuse the same
    // line_item_id must not leak into M1's feed (join is keyed on both).
    await ctx.pool.query(`
      INSERT INTO mart.fact_line_item_modifiers
        (merchant_id, order_id, line_item_fingerprint, line_item_modifier_fingerprint,
         line_item_id, business_date, item_fingerprint, modifier_name)
      VALUES
        ('M1','o3','li-fp-3','mod-fp-3','li-3', CURRENT_DATE, 'fp-c','Ginger'),
        ('M2','o3','li-fp-3','mod-fp-9','li-3', CURRENT_DATE, 'fp-c','Wasabi')
    `);

    const items = await fetchSoldItems(ctx.pool);
    expect(items).toHaveLength(1);
    expect(items[0]?.modifiers).toEqual(["Ginger"]);
  });
});
