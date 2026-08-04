import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { startAnalyticsItContext, type AnalyticsItContext } from "./fixture.js";
import { menuEngineering } from "../../src/http/menu-engineering.js";

describe("menuEngineering (real Postgres)", () => {
  let ctx: AnalyticsItContext;

  beforeAll(async () => {
    ctx = await startAnalyticsItContext();
  });

  afterAll(async () => {
    await ctx?.stop();
  });

  it("joins units + revenue to the latest plate cost; null when cost is unknown", async () => {
    await ctx.pool.query("TRUNCATE mart.fact_order_line_items, mart.dim_item, mart.dim_item_cost");

    // Item A: Clover-linked, has a plate cost (two effective rows -> latest wins).
    // Item B: Clover-linked, but no cost row -> plate cost unknown (null).
    await ctx.pool.query(`
      INSERT INTO mart.fact_order_line_items
        (merchant_id, order_id, line_item_fingerprint, business_date, item_fingerprint, item_id, item_name, quantity, gross_sales_cents)
      VALUES
        ('M1','o1','li1', CURRENT_DATE, 'fp-a','clv-a','Vanilla Roll', 2, 1600),
        ('M1','o2','li2', CURRENT_DATE, 'fp-a','clv-a','Vanilla Roll', 1,  800),
        ('M1','o3','li3', CURRENT_DATE, 'fp-b','clv-b','Mystery Roll', 1,  900)
    `);
    await ctx.pool.query(`
      INSERT INTO mart.dim_item (merchant_id, item_fingerprint, item_id, item_name) VALUES
        ('M1','fp-a','clv-a','Vanilla Roll'),
        ('M1','fp-b','clv-b','Mystery Roll')
    `);
    await ctx.pool.query(`
      INSERT INTO mart.dim_item_cost (clover_item_id, effective_from, plate_cost_cents) VALUES
        ('clv-a','2026-06-01', 200),
        ('clv-a','2026-06-02', 210)
    `);
    await ctx.pool.query("REFRESH MATERIALIZED VIEW mart.item_sales_daily_mv");

    const { items } = await menuEngineering(ctx.pool, "M1", "UTC", 365);
    const byName = new Map(items.map((i) => [i.item_name, i]));

    expect(byName.get("Vanilla Roll")).toMatchObject({
      clover_item_id: "clv-a",
      units: 3,
      gross_sales_cents: 2400,
      plate_cost_cents: 210, // latest effective cost, not 200
    });
    expect(byName.get("Mystery Roll")).toMatchObject({
      clover_item_id: "clv-b",
      units: 1,
      gross_sales_cents: 900,
      plate_cost_cents: null, // cost unknown — never coerced to 0
    });
  });
});
