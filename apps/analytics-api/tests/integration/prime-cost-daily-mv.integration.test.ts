import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { startAnalyticsItContext, type AnalyticsItContext } from "./fixture.js";

// Proves mart.prime_cost_daily_mv (migration 015) against real Postgres: the
// effective-dated labor join (latest effective_from <= business_date), the
// NULL-not-zero behavior on days with no labor row, and that it carries the food
// leg (net sales + theoretical COGS) through from cost_daily_mv. Does NOT use
// ctx.truncate() (that wipes the meta registry seed); truncates only the base
// facts it dirties.
describe("prime_cost_daily_mv (real Postgres)", () => {
  let ctx: AnalyticsItContext;

  beforeAll(async () => {
    ctx = await startAnalyticsItContext();
  });

  afterAll(async () => {
    await ctx?.stop();
  });

  it("joins effective-dated labor cost and leaves it NULL when none is on file", async () => {
    await ctx.pool.query(
      "TRUNCATE mart.fact_payments, mart.fact_refunds, mart.fact_order_line_items, mart.dim_item_cost, mart.dim_labor_cost",
    );

    // Three days with sales; labor is configured only from 06-01 onward.
    await ctx.pool.query(`
      INSERT INTO mart.fact_payments
        (merchant_id, payment_id, business_date, tender_type, amount_cents)
      VALUES
        ('M1','p2','2026-06-02','CREDIT_CARD',100000),
        ('M1','p1','2026-06-01','CREDIT_CARD', 50000),
        ('M1','p0','2026-05-31','CREDIT_CARD', 40000)
    `);

    // One costed line on 06-02 so the food leg carries through: 2 × 200 = 400.
    await ctx.pool.query(`
      INSERT INTO mart.fact_order_line_items
        (merchant_id, order_id, line_item_fingerprint, business_date, item_fingerprint,
         item_id, item_name, quantity, gross_sales_cents, refunded)
      VALUES ('M1','o1','li1','2026-06-02','fp-a','clv-a','Vanilla Roll', 2, 1600, false)
    `);
    await ctx.pool.query(`
      INSERT INTO mart.dim_item_cost (clover_item_id, effective_from, plate_cost_cents)
      VALUES ('clv-a','2026-06-01', 200)
    `);

    // Labor changed 06-01 -> 06-02; 05-31 predates any row, so labor stays NULL.
    await ctx.pool.query(`
      INSERT INTO mart.dim_labor_cost (merchant_id, effective_from, daily_labor_cost_cents)
      VALUES
        ('M1','2026-06-01', 20000),
        ('M1','2026-06-02', 30000)
    `);

    await ctx.pool.query("REFRESH MATERIALIZED VIEW mart.sales_daily_mv");
    await ctx.pool.query("REFRESH MATERIALIZED VIEW mart.cost_daily_mv");
    await ctx.pool.query("REFRESH MATERIALIZED VIEW mart.prime_cost_daily_mv");

    const { rows } = await ctx.pool.query<{
      business_date: string;
      net_sales_cents: string;
      theoretical_cogs_cents: string;
      labor_cost_cents: string | null;
    }>(
      `SELECT business_date::text, net_sales_cents, theoretical_cogs_cents, labor_cost_cents
       FROM mart.prime_cost_daily_mv WHERE merchant_id = 'M1' ORDER BY business_date`,
    );
    const byDate = new Map(rows.map((r) => [r.business_date, r]));

    // 06-02: latest effective labor (30000); food leg carried through (COGS 400).
    const d2 = byDate.get("2026-06-02");
    expect(Number(d2?.net_sales_cents)).toBe(100000);
    expect(Number(d2?.theoretical_cogs_cents)).toBe(400);
    expect(Number(d2?.labor_cost_cents)).toBe(30000);

    // 06-01: the 06-01 labor row (20000); no costed lines -> COGS 0.
    const d1 = byDate.get("2026-06-01");
    expect(Number(d1?.labor_cost_cents)).toBe(20000);
    expect(Number(d1?.theoretical_cogs_cents)).toBe(0);

    // 05-31: predates every labor row -> labor_cost is NULL, NOT 0.
    const d0 = byDate.get("2026-05-31");
    expect(d0?.labor_cost_cents).toBeNull();
  });
});
