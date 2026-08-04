import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { startAnalyticsItContext, type AnalyticsItContext } from "./fixture.js";
import { salesSummary } from "../../src/http/dashboard.js";

/**
 * Phase-0 parity gate (ADR-0030). Proves salesSummary now resolves the two ratio
 * metrics — avg_ticket_cents and refund_rate — per business_date through the
 * governed metric registry, so Today/Trends can read one governed definition
 * instead of hand-deriving the ratios.
 *
 * The load-bearing assertion is the refund_rate 口径: the registry defines it as
 * refund_total / payment_total, which DIFFERS from the legacy page formula
 * refund_total / net_sales. This test pins the registry definition and asserts
 * the migrated value is NOT the legacy one — so the migration is a deliberate,
 * documented correction, not a silent parity. avg_ticket_cents
 * (net_sales / order_count) is unchanged from the old formula → clean parity.
 *
 * Does NOT truncate meta.* (would wipe the registry seed); truncates only the
 * base facts it dirties.
 */
describe("salesSummary per-day ratios via the registry (real Postgres)", () => {
  let ctx: AnalyticsItContext;

  beforeAll(async () => {
    ctx = await startAnalyticsItContext();
  });

  afterAll(async () => {
    await ctx?.stop();
  });

  it("resolves avg_ticket_cents = net/orders and refund_rate over payment_total (not net sales)", async () => {
    await ctx.pool.query(
      "TRUNCATE mart.fact_orders, mart.fact_payments, mart.fact_refunds, mart.fact_order_line_items",
    );

    // payment_total 10000, refund 1000 -> net_sales 9000; 4 orders -> avg_ticket 2250.
    // refund_rate (registry 口径) = refund/payment = 1000/10000 = 0.10
    //   — NOT refund/net = 1000/9000 = 0.111 (the legacy page formula).
    await ctx.pool.query(`
      INSERT INTO mart.fact_orders (merchant_id, order_id, business_date)
      VALUES ('M1','o1',CURRENT_DATE),('M1','o2',CURRENT_DATE),
             ('M1','o3',CURRENT_DATE),('M1','o4',CURRENT_DATE)
    `);
    await ctx.pool.query(`
      INSERT INTO mart.fact_payments
        (merchant_id, payment_id, business_date, tender_type, amount_cents)
      VALUES ('M1','p1', CURRENT_DATE, 'CREDIT_CARD', 10000)
    `);
    await ctx.pool.query(`
      INSERT INTO mart.fact_refunds
        (merchant_id, refund_id, business_date, amount_cents)
      VALUES ('M1','r1', CURRENT_DATE, 1000)
    `);
    await ctx.pool.query("REFRESH MATERIALIZED VIEW mart.sales_daily_mv");

    const summary = await salesSummary(ctx.pool, "M1", "UTC", { mode: "days", days: 90 });

    expect(summary.daily).toHaveLength(1);
    const row = summary.daily[0] as Record<string, unknown>;

    // Sanity on the raw components the ratios are built from.
    expect(Number(row.net_sales_cents)).toBe(9000);
    expect(Number(row.payment_total_cents)).toBe(10000);
    expect(Number(row.order_count)).toBe(4);

    // avg_ticket = net / orders = 9000 / 4 = 2250 (matches the legacy formula → clean parity).
    expect(row.avg_ticket_cents).toBeCloseTo(2250, 6);

    // refund_rate = refund / payment_total = 1000 / 10000 = 0.10 (registry 口径).
    expect(row.refund_rate).toBeCloseTo(0.1, 6);
    // Explicitly NOT refund / net_sales = 1000 / 9000 ≈ 0.111 (the legacy page formula).
    // This guards the deliberate 口径 correction against a silent regression.
    expect(row.refund_rate).not.toBeCloseTo(1000 / 9000, 4);
  });

  it("returns null ratios for a day with no orders/payments rather than fabricating 0", async () => {
    await ctx.pool.query(
      "TRUNCATE mart.fact_orders, mart.fact_payments, mart.fact_refunds, mart.fact_order_line_items",
    );
    // A refund but no payments and no orders -> avg_ticket (÷0 orders) and
    // refund_rate (÷0 payment) both resolve to null via nullif, not 0/NaN.
    await ctx.pool.query(`
      INSERT INTO mart.fact_refunds
        (merchant_id, refund_id, business_date, amount_cents)
      VALUES ('M1','r1', CURRENT_DATE, 500)
    `);
    await ctx.pool.query("REFRESH MATERIALIZED VIEW mart.sales_daily_mv");

    const summary = await salesSummary(ctx.pool, "M1", "UTC", { mode: "days", days: 90 });
    const row = summary.daily.find(
      (r: Record<string, unknown>) => Number(r.refund_total_cents) === 500,
    ) as Record<string, unknown> | undefined;

    expect(row).toBeDefined();
    expect(row?.avg_ticket_cents).toBeNull();
    expect(row?.refund_rate).toBeNull();
  });
});
