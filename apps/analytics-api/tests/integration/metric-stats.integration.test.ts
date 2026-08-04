import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { startAnalyticsItContext, type AnalyticsItContext } from "./fixture.js";
import { loadMetricRegistry } from "../../src/analytics/metric-registry.js";
import { metricStats } from "../../src/analytics/metric-stats.js";

// Proves metricStats positions a registry metric's as-of day against its own
// history over real Postgres + resolveMetric. Uses CURRENT_DATE-relative
// fixtures so the days-window always captures them. Does NOT use ctx.truncate()
// (wipes the meta registry seed); truncates only the facts it dirties.
describe("metricStats (real Postgres)", () => {
  let ctx: AnalyticsItContext;

  beforeAll(async () => {
    ctx = await startAnalyticsItContext();
  });

  afterAll(async () => {
    await ctx?.stop();
  });

  // 12 prior days with mild variation (so the baseline has real spread / MAD > 0)
  // plus today set to `today`.
  async function seedSeries(today: number | null) {
    await ctx.pool.query("TRUNCATE mart.fact_payments, mart.fact_refunds");
    await ctx.pool.query(
      `INSERT INTO mart.fact_payments
         (merchant_id, payment_id, business_date, tender_type, amount_cents)
       SELECT 'M1', 'p'||g, (CURRENT_DATE - g), 'CREDIT_CARD', 10000 + (g % 4) * 500
       FROM generate_series(1, 12) g`,
    );
    if (today !== null) {
      await ctx.pool.query(
        `INSERT INTO mart.fact_payments
           (merchant_id, payment_id, business_date, tender_type, amount_cents)
         VALUES ('M1','p-today', CURRENT_DATE, 'CREDIT_CARD', $1)`,
        [today],
      );
    }
    await ctx.pool.query("REFRESH MATERIALIZED VIEW mart.sales_daily_mv");
  }

  it("flags an as-of day that is a clear outlier vs its own history", async () => {
    await seedSeries(50000);
    const registry = await loadMetricRegistry(ctx.pool);

    const result = await metricStats(ctx.pool, registry, "net_sales_cents", {
      merchantId: "M1",
      timezone: "UTC",
      days: 30,
    });

    expect(result.insufficientData).toBe(false);
    expect(result.asOf?.value).toBe(50000);
    expect(result.baselineDays).toBe(12);
    expect(result.stats?.isAnomaly).toBe(true);
    expect(result.stats?.direction).toBe("high");
    expect(result.stats?.percentile).toBe(1); // today >= every baseline day
  });

  it("does not flag an in-range as-of day", async () => {
    await seedSeries(10500); // squarely inside the baseline spread
    const registry = await loadMetricRegistry(ctx.pool);

    const result = await metricStats(ctx.pool, registry, "net_sales_cents", {
      merchantId: "M1",
      timezone: "UTC",
      days: 30,
    });

    expect(result.insufficientData).toBe(false);
    expect(result.stats?.isAnomaly).toBe(false);
    expect(result.stats?.direction).toBe("normal");
  });

  it("returns insufficientData when the baseline is too short", async () => {
    await ctx.pool.query("TRUNCATE mart.fact_payments, mart.fact_refunds");
    // 4 days total -> baseline of 3 < MIN_BASELINE_DAYS (7).
    await ctx.pool.query(
      `INSERT INTO mart.fact_payments
         (merchant_id, payment_id, business_date, tender_type, amount_cents)
       SELECT 'M1', 'p'||g, (CURRENT_DATE - g), 'CREDIT_CARD', 10000
       FROM generate_series(0, 3) g`,
    );
    await ctx.pool.query("REFRESH MATERIALIZED VIEW mart.sales_daily_mv");
    const registry = await loadMetricRegistry(ctx.pool);

    const result = await metricStats(ctx.pool, registry, "net_sales_cents", {
      merchantId: "M1",
      timezone: "UTC",
      days: 30,
    });

    expect(result.insufficientData).toBe(true);
    expect(result.stats).toBeNull();
  });
});
