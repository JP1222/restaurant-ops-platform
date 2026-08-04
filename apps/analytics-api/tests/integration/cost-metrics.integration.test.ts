import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { startAnalyticsItContext, type AnalyticsItContext } from "./fixture.js";
import { loadMetricRegistry, resolveMetric } from "../../src/analytics/metric-registry.js";

// Proves the Phase 2 cost metrics (migration 013) resolve through the registry
// against real Postgres + mart.cost_daily_mv. Does NOT use ctx.truncate() (it
// wipes the meta registry seed); truncates only the base facts it dirties.
describe("cost metrics (real Postgres)", () => {
  let ctx: AnalyticsItContext;
  const DAY = { mode: "range", from: "2026-06-02", to: "2026-06-02" } as const;
  const BASE = { merchantId: "M1", timezone: "America/Chicago" };

  beforeAll(async () => {
    ctx = await startAnalyticsItContext();
  });

  afterAll(async () => {
    await ctx?.stop();
  });

  it("resolves food cost %, gross margin %, and coverage from cost_daily_mv", async () => {
    await ctx.pool.query(
      "TRUNCATE mart.fact_payments, mart.fact_refunds, mart.fact_order_line_items, mart.dim_item_cost",
    );

    // Net sales $100. One costed item (4 × $5.00 plate cost = $20 COGS on $40
    // gross) and one un-costed item ($10 gross, no recipe).
    //   food_cost_cents   = 2000
    //   food_cost_pct     = 2000 / 10000 = 0.20  (20%)
    //   gross_margin_pct  = 8000 / 10000 = 0.80
    //   cost_coverage_pct = 4000 / 5000  = 0.80  (un-costed $10 dilutes coverage)
    await ctx.pool.query(`
      INSERT INTO mart.fact_payments
        (merchant_id, payment_id, business_date, tender_type, amount_cents)
      VALUES ('M1','p1','2026-06-02','CREDIT_CARD',10000)
    `);
    await ctx.pool.query(`
      INSERT INTO mart.fact_order_line_items
        (merchant_id, order_id, line_item_fingerprint, business_date, item_fingerprint,
         item_id, item_name, quantity, gross_sales_cents, refunded)
      VALUES
        ('M1','o1','li1','2026-06-02','fp-x','clv-x','Costed Roll',   4, 4000, false),
        ('M1','o2','li2','2026-06-02','fp-y','clv-y','Uncosted Roll', 2, 1000, false)
    `);
    await ctx.pool.query(`
      INSERT INTO mart.dim_item_cost (clover_item_id, effective_from, plate_cost_cents)
      VALUES ('clv-x','2026-06-01', 500)
    `);
    await ctx.pool.query("REFRESH MATERIALIZED VIEW mart.sales_daily_mv");
    await ctx.pool.query("REFRESH MATERIALIZED VIEW mart.cost_daily_mv");

    const registry = await loadMetricRegistry(ctx.pool);

    async function value(name: string): Promise<number> {
      const res = await resolveMetric(ctx.pool, registry, name, { ...BASE, window: DAY });
      expect(res.rows).toHaveLength(1);
      return Number(res.rows[0]?.value);
    }

    expect(registry.get("food_cost_pct")).toMatchObject({
      baseView: "mart.cost_daily_mv",
      unit: "ratio",
      format: "percent",
    });

    expect(await value("food_cost_cents")).toBe(2000);
    expect(await value("food_cost_pct")).toBeCloseTo(0.2, 6);
    expect(await value("gross_margin_pct")).toBeCloseTo(0.8, 6);
    expect(await value("cost_coverage_pct")).toBeCloseTo(0.8, 6);
  });

  it("resolves food cost % / gross margin % to NULL on a day with sales but no costed items (#457)", async () => {
    await ctx.pool.query(
      "TRUNCATE mart.fact_payments, mart.fact_refunds, mart.fact_order_line_items, mart.dim_item_cost",
    );

    // $50 net sales, all from an item with NO plate cost on file. The honest
    // answer is "no data" — NOT 0% food cost / 100% margin.
    await ctx.pool.query(`
      INSERT INTO mart.fact_payments
        (merchant_id, payment_id, business_date, tender_type, amount_cents)
      VALUES ('M1','p1','2026-06-02','CREDIT_CARD',5000)
    `);
    await ctx.pool.query(`
      INSERT INTO mart.fact_order_line_items
        (merchant_id, order_id, line_item_fingerprint, business_date, item_fingerprint,
         item_id, item_name, quantity, gross_sales_cents, refunded)
      VALUES ('M1','o1','li1','2026-06-02','fp-z','clv-z','Uncosted Roll', 2, 2000, false)
    `);
    await ctx.pool.query("REFRESH MATERIALIZED VIEW mart.sales_daily_mv");
    await ctx.pool.query("REFRESH MATERIALIZED VIEW mart.cost_daily_mv");

    const registry = await loadMetricRegistry(ctx.pool);
    async function rawValue(name: string): Promise<unknown> {
      const res = await resolveMetric(ctx.pool, registry, name, { ...BASE, window: DAY });
      expect(res.rows).toHaveLength(1);
      return res.rows[0]?.value;
    }

    // Was 0 / 1 before the fix — now an honest NULL.
    expect(await rawValue("food_cost_pct")).toBeNull();
    expect(await rawValue("gross_margin_pct")).toBeNull();
    // Coverage stays a meaningful 0% (nothing costed) — proves the MV was left intact.
    expect(Number(await rawValue("cost_coverage_pct"))).toBe(0);
  });
});
