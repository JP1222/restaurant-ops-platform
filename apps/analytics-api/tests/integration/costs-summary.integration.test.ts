import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { startAnalyticsItContext, type AnalyticsItContext } from "./fixture.js";
import { costsSummary } from "../../src/http/costs-summary.js";

// Proves GET /admin/api/costs bundles the cost metrics through the registry
// against real Postgres. Covers Phase 2 (food cost over cost_daily_mv) AND Phase
// 4a (labor + prime over prime_cost_daily_mv), including the honest null state
// before labor is configured. Uses CURRENT_DATE so the days-window always
// captures the fixture. Does NOT use ctx.truncate() (wipes the meta registry
// seed); truncates only the base facts it dirties.
describe("costsSummary (real Postgres)", () => {
  let ctx: AnalyticsItContext;

  beforeAll(async () => {
    ctx = await startAnalyticsItContext();
  });

  afterAll(async () => {
    await ctx?.stop();
  });

  it("resolves every cost metric and the margin trend through the registry", async () => {
    await ctx.pool.query(
      "TRUNCATE mart.fact_payments, mart.fact_refunds, mart.fact_order_line_items, mart.dim_item_cost, mart.dim_labor_cost",
    );

    // Net sales $100. One costed item (4 × $5.00 cost on $40 gross) + one
    // un-costed item ($10 gross): food cost 20%, margin 80%, coverage 80%.
    await ctx.pool.query(`
      INSERT INTO mart.fact_payments
        (merchant_id, payment_id, business_date, tender_type, amount_cents)
      VALUES ('M1','p1', CURRENT_DATE, 'CREDIT_CARD', 10000)
    `);
    await ctx.pool.query(`
      INSERT INTO mart.fact_order_line_items
        (merchant_id, order_id, line_item_fingerprint, business_date, item_fingerprint,
         item_id, item_name, quantity, gross_sales_cents, refunded)
      VALUES
        ('M1','o1','li1', CURRENT_DATE, 'fp-x','clv-x','Costed Roll',   4, 4000, false),
        ('M1','o2','li2', CURRENT_DATE, 'fp-y','clv-y','Uncosted Roll', 2, 1000, false)
    `);
    await ctx.pool.query(`
      INSERT INTO mart.dim_item_cost (clover_item_id, effective_from, plate_cost_cents)
      VALUES ('clv-x', CURRENT_DATE, 500)
    `);
    await ctx.pool.query("REFRESH MATERIALIZED VIEW mart.sales_daily_mv");
    await ctx.pool.query("REFRESH MATERIALIZED VIEW mart.cost_daily_mv");
    await ctx.pool.query("REFRESH MATERIALIZED VIEW mart.prime_cost_daily_mv");
    await ctx.pool.query("REFRESH MATERIALIZED VIEW mart.cost_variance_daily_mv");

    const summary = await costsSummary(ctx.pool, "M1", "UTC", 90);

    expect(summary.metrics.food_cost_pct).toMatchObject({
      unit: "ratio",
      label: "Food Cost %",
    });
    expect(summary.metrics.food_cost_pct?.value).toBeCloseTo(0.2, 6);
    expect(summary.metrics.gross_margin_pct?.value).toBeCloseTo(0.8, 6);
    expect(summary.metrics.cost_coverage_pct?.value).toBeCloseTo(0.8, 6);
    expect(summary.metrics.food_cost_cents?.value).toBe(2000);
    expect(summary.metrics.net_sales_cents?.value).toBe(10000);
    // Labor not configured yet -> labor + prime resolve to null (honest "not
    // connected"), never a fabricated 0.
    expect(summary.metrics.labor_cost_pct?.value).toBeNull();
    expect(summary.metrics.prime_cost_pct?.value).toBeNull();
    expect(summary.metrics.labor_cost_cents?.value).toBeNull();
    // No counted window yet -> actual COGS + yield variance resolve to null
    // (honest "not connected"), never a fabricated 0.
    expect(summary.metrics.actual_cogs_cents?.value).toBeNull();
    expect(summary.metrics.yield_variance_cents?.value).toBeNull();
    // Definitions ride along for the provenance table.
    expect(summary.metrics.food_cost_pct?.definition).toMatch(/net sales/i);

    // One business date in the window -> one trend point at ~80% margin.
    expect(summary.marginTrend).toHaveLength(1);
    expect(summary.marginTrend[0]?.value).toBeCloseTo(0.8, 6);
    // The real daily COGS-% series (ADR-0573) the Inventory overview sparkline
    // reads: same business date, food cost % ~20%.
    expect(summary.costTrend).toHaveLength(1);
    expect(summary.costTrend[0]?.value).toBeCloseTo(0.2, 6);
  });

  it("lights up labor + prime cost once a labor rate is on file", async () => {
    await ctx.pool.query(
      "TRUNCATE mart.fact_payments, mart.fact_refunds, mart.fact_order_line_items, mart.dim_item_cost, mart.dim_labor_cost",
    );

    // Same shape as above (net $100, food cost $20) plus a $30/day labor rate:
    // labor 30%, prime = (food $20 + labor $30) / $100 = 50%.
    await ctx.pool.query(`
      INSERT INTO mart.fact_payments
        (merchant_id, payment_id, business_date, tender_type, amount_cents)
      VALUES ('M1','p1', CURRENT_DATE, 'CREDIT_CARD', 10000)
    `);
    await ctx.pool.query(`
      INSERT INTO mart.fact_order_line_items
        (merchant_id, order_id, line_item_fingerprint, business_date, item_fingerprint,
         item_id, item_name, quantity, gross_sales_cents, refunded)
      VALUES ('M1','o1','li1', CURRENT_DATE, 'fp-x','clv-x','Costed Roll', 4, 4000, false)
    `);
    await ctx.pool.query(`
      INSERT INTO mart.dim_item_cost (clover_item_id, effective_from, plate_cost_cents)
      VALUES ('clv-x', CURRENT_DATE, 500)
    `);
    await ctx.pool.query(`
      INSERT INTO mart.dim_labor_cost (merchant_id, effective_from, daily_labor_cost_cents)
      VALUES ('M1', CURRENT_DATE, 3000)
    `);
    await ctx.pool.query("REFRESH MATERIALIZED VIEW mart.sales_daily_mv");
    await ctx.pool.query("REFRESH MATERIALIZED VIEW mart.cost_daily_mv");
    await ctx.pool.query("REFRESH MATERIALIZED VIEW mart.prime_cost_daily_mv");
    await ctx.pool.query("REFRESH MATERIALIZED VIEW mart.cost_variance_daily_mv");

    const summary = await costsSummary(ctx.pool, "M1", "UTC", 90);

    expect(summary.metrics.labor_cost_cents?.value).toBe(3000);
    expect(summary.metrics.labor_cost_pct?.value).toBeCloseTo(0.3, 6);
    expect(summary.metrics.prime_cost_pct?.value).toBeCloseTo(0.5, 6);
    expect(summary.metrics.prime_cost_pct).toMatchObject({
      unit: "ratio",
      label: "Prime Cost %",
    });
  });
});
