import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { startAnalyticsItContext, type AnalyticsItContext } from "./fixture.js";
import {
  computeMetricDrivers,
  type DriverDimension,
} from "../../src/analytics/metric-drivers.js";

// Proves computeMetricDrivers decomposes a day's net-sales change against its
// same-weekday norm over REAL Postgres — exercising all five queries (headline +
// the four dimensions) against the actual mart schema, so a column/FILTER/array
// bug surfaces here, not in prod. Seeding fact_payments alone drives the headline
// (sales_daily_mv), daypart (sales_hourly_mv) and tender (payment_method_daily_mv);
// the order_type (fact_orders) and item (item_sales_hourly_mv) queries still run
// and must return empty without error. CURRENT_DATE-relative so the same-weekday
// baseline (D-7, D-14, ...) always lands on the seeded days.
describe("computeMetricDrivers (real Postgres)", () => {
  let ctx: AnalyticsItContext;

  beforeAll(async () => {
    ctx = await startAnalyticsItContext();
  });

  afterAll(async () => {
    await ctx?.stop();
  });

  async function refreshMvs() {
    // Every MV my queries read must be populated; an unrefreshed WITH NO DATA view
    // errors on SELECT. item_sales_hourly_mv stays empty (no line items) but populated.
    for (const mv of [
      "mart.sales_daily_mv",
      "mart.sales_hourly_mv",
      "mart.payment_method_daily_mv",
      "mart.item_sales_hourly_mv",
    ]) {
      await ctx.pool.query(`REFRESH MATERIALIZED VIEW ${mv}`);
    }
  }

  function dim(result: { dimensions: DriverDimension[] }, key: string): DriverDimension {
    const found = result.dimensions.find((d) => d.dimension === key);
    if (!found) throw new Error(`dimension ${key} missing`);
    return found;
  }

  it("attributes a same-weekday drop to the right daypart with signed shares", async () => {
    await ctx.pool.query("TRUNCATE mart.fact_payments");
    // Target day (CURRENT_DATE): lunch 6000 + dinner 2000 = 8000 net.
    // Two prior same-weekdays (-7, -14): lunch 5000 + dinner 5000 = 10000 each.
    await ctx.pool.query(
      `INSERT INTO mart.fact_payments
         (merchant_id, payment_id, business_date, local_hour, tender_type, amount_cents)
       VALUES
         ('M1','t-l',  CURRENT_DATE,      12, 'CREDIT_CARD', 6000),
         ('M1','t-d',  CURRENT_DATE,      18, 'CREDIT_CARD', 2000),
         ('M1','b7-l', CURRENT_DATE - 7,  12, 'CREDIT_CARD', 5000),
         ('M1','b7-d', CURRENT_DATE - 7,  18, 'CREDIT_CARD', 5000),
         ('M1','b14-l',CURRENT_DATE - 14, 12, 'CREDIT_CARD', 5000),
         ('M1','b14-d',CURRENT_DATE - 14, 18, 'CREDIT_CARD', 5000)`,
    );
    await refreshMvs();

    // No date passed: resolves the latest day (CURRENT_DATE) itself.
    const result = await computeMetricDrivers(ctx.pool, { merchantId: "M1" });

    expect(result.sufficient).toBe(true);
    expect(result.baseline.day_count).toBe(2); // -7 and -14 have data; -21/-28 do not
    expect(result.total).toMatchObject({
      current_cents: 8000,
      baseline_cents: 10000,
      delta_cents: -2000,
      delta_pct: -0.2,
    });

    const daypart = dim(result, "daypart");
    expect(daypart.current_cents).toBe(8000);
    expect(daypart.baseline_cents).toBe(10000);
    expect(daypart.delta_cents).toBe(-2000);
    // Dinner fell 3000 (the real driver); lunch ROSE 1000 (offsetting → negative share).
    expect(daypart.drivers[0]).toMatchObject({ key: "dinner", delta_cents: -3000 });
    expect(daypart.drivers[0].share_of_delta).toBeCloseTo(1.5, 6); // -3000 / -2000
    const lunch = daypart.drivers.find((d) => d.key === "lunch");
    expect(lunch?.delta_cents).toBe(1000);
    expect(lunch?.share_of_delta).toBeCloseTo(-0.5, 6); // +1000 / -2000

    // Tender (payment basis) reconciles to the headline payment total.
    const tender = dim(result, "tender");
    expect(tender.basis).toBe("payment");
    expect(tender.current_cents).toBe(8000);
    expect(tender.delta_cents).toBe(-2000);
    expect(tender.drivers[0]).toMatchObject({ key: "CREDIT_CARD", delta_cents: -2000 });

    // The order_type + item queries must execute against the real schema and come
    // back empty (no facts/line-items seeded) rather than throwing.
    expect(dim(result, "order_type").drivers).toEqual([]);
    expect(dim(result, "item").basis).toBe("gross_sales");
    expect(dim(result, "item").drivers).toEqual([]);
  });

  it("reports insufficient when there is no same-weekday history", async () => {
    await ctx.pool.query("TRUNCATE mart.fact_payments");
    await ctx.pool.query(
      `INSERT INTO mart.fact_payments
         (merchant_id, payment_id, business_date, local_hour, tender_type, amount_cents)
       VALUES ('M1','only', CURRENT_DATE, 12, 'CREDIT_CARD', 4200)`,
    );
    await refreshMvs();

    const result = await computeMetricDrivers(ctx.pool, { merchantId: "M1" });

    expect(result.sufficient).toBe(false);
    expect(result.baseline.day_count).toBe(0);
    expect(result.total.current_cents).toBe(4200);
    expect(result.total.baseline_cents).toBeNull();
    expect(result.total.delta_cents).toBeNull();
    // With no baseline, dimension deltas/shares are null but current still sums.
    expect(dim(result, "daypart").current_cents).toBe(4200);
    expect(dim(result, "daypart").delta_cents).toBeNull();
    expect(dim(result, "daypart").drivers[0]?.share_of_delta).toBeNull();
  });
});
