import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { startAnalyticsItContext, type AnalyticsItContext } from "./fixture.js";
import { loadMetricRegistry, resolveMetric } from "../../src/analytics/metric-registry.js";

// Proves the count-based actual COGS + yield variance metrics (migrations 019-021)
// resolve through the registry against real Postgres + mart.cost_variance_daily_mv. Does
// NOT use ctx.truncate() (it wipes the meta registry seed); truncates only the base facts
// it dirties.
describe("yield variance metrics (real Postgres)", () => {
  let ctx: AnalyticsItContext;
  const BASE = { merchantId: "M1", timezone: "America/Chicago" };
  // The window closes on 2026-06-08; cost_variance_daily_mv keys it on that closing date.
  const RANGE = { mode: "range", from: "2026-06-08", to: "2026-06-08" } as const;

  beforeAll(async () => {
    ctx = await startAnalyticsItContext();
  });

  afterAll(async () => {
    await ctx?.stop();
  });

  it("resolves actual_cogs_cents and yield_variance_cents per counted window", async () => {
    await ctx.pool.query(
      "TRUNCATE mart.fact_payments, mart.fact_refunds, mart.fact_order_line_items, mart.dim_item_cost, mart.dim_actual_cogs"
    );

    // Theoretical leg: one costed item sold on 2026-06-02 (4 x $5.00 plate cost = $20).
    await ctx.pool.query(`
      INSERT INTO mart.fact_payments
        (merchant_id, payment_id, business_date, tender_type, amount_cents)
      VALUES ('M1','p1','2026-06-02','CREDIT_CARD',10000)
    `);
    await ctx.pool.query(`
      INSERT INTO mart.fact_order_line_items
        (merchant_id, order_id, line_item_fingerprint, business_date, item_fingerprint,
         item_id, item_name, quantity, gross_sales_cents, refunded)
      VALUES ('M1','o1','li1','2026-06-02','fp-x','clv-x','Costed Roll', 4, 4000, false)
    `);
    await ctx.pool.query(`
      INSERT INTO mart.dim_item_cost (clover_item_id, effective_from, plate_cost_cents)
      VALUES ('clv-x','2026-06-01', 500)
    `);

    // Actual leg: one counted window 06-01 -> 06-08, actual COGS $27.00.
    await ctx.pool.query(`
      INSERT INTO mart.dim_actual_cogs
        (merchant_id, period_start, period_end, beginning_value_cents,
         received_value_cents, ending_value_cents, actual_cogs_cents)
      VALUES ('M1','2026-06-01','2026-06-08', 6000, 1500, 4800, 2700)
    `);

    await ctx.pool.query("REFRESH MATERIALIZED VIEW mart.sales_daily_mv");
    await ctx.pool.query("REFRESH MATERIALIZED VIEW mart.cost_daily_mv");
    await ctx.pool.query("REFRESH MATERIALIZED VIEW mart.cost_variance_daily_mv");

    const registry = await loadMetricRegistry(ctx.pool);

    async function value(name: string): Promise<number> {
      const res = await resolveMetric(ctx.pool, registry, name, { ...BASE, window: RANGE });
      expect(res.rows).toHaveLength(1);
      return Number(res.rows[0]?.value);
    }

    expect(registry.get("yield_variance_cents")).toMatchObject({
      baseView: "mart.cost_variance_daily_mv",
      unit: "cents",
      format: "currency"
    });

    // theoretical COGS over (06-01, 06-08] = 2000 (only 06-02 has costed sales).
    expect(await value("actual_cogs_cents")).toBe(2700);
    expect(await value("yield_variance_cents")).toBe(700); // 2700 - 2000
  });
});
