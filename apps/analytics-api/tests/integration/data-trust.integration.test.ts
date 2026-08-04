import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { startAnalyticsItContext, type AnalyticsItContext } from "./fixture.js";
import { computeDataTrust } from "../../src/analytics/data-trust.js";

// Proves computeDataTrust composes the real audit.reconciliation_results +
// audit.data_quality_checks state into an owner-facing per-day verdict over real
// Postgres. CURRENT_DATE-relative fixtures so the window always captures them.
// Truncates only the tables it dirties (keeps the meta registry seed intact).
describe("computeDataTrust (real Postgres)", () => {
  let ctx: AnalyticsItContext;

  beforeAll(async () => {
    ctx = await startAnalyticsItContext();
  });

  afterAll(async () => {
    await ctx?.stop();
  });

  beforeEach(async () => {
    await ctx.pool.query(
      "TRUNCATE mart.fact_payments, mart.fact_refunds, audit.reconciliation_results, audit.data_quality_checks",
    );
    // sales_daily_mv is a materialized view — truncating the facts doesn't empty
    // it until refreshed, so a test that doesn't re-seed would otherwise read the
    // prior test's stale max(business_date).
    await ctx.pool.query("REFRESH MATERIALIZED VIEW mart.sales_daily_mv");
  });

  // A week of sales ending on CURRENT_DATE -> sales_daily_mv max = today.
  async function seedSales() {
    await ctx.pool.query(
      `INSERT INTO mart.fact_payments
         (merchant_id, payment_id, business_date, tender_type, amount_cents)
       SELECT 'M1', 'p'||g, (CURRENT_DATE - g), 'CREDIT_CARD', 10000
       FROM generate_series(0, 6) g`,
    );
    await ctx.pool.query("REFRESH MATERIALIZED VIEW mart.sales_daily_mv");
  }

  async function relativeDates() {
    const { rows } = await ctx.pool.query<{ d0: string; d2: string; d3: string; d5: string }>(
      `SELECT to_char(CURRENT_DATE, 'YYYY-MM-DD') AS d0,
              to_char(CURRENT_DATE - 2, 'YYYY-MM-DD') AS d2,
              to_char(CURRENT_DATE - 3, 'YYYY-MM-DD') AS d3,
              to_char(CURRENT_DATE - 5, 'YYYY-MM-DD') AS d5`,
    );
    return rows[0]!;
  }

  it("leaves the settling latest day trustworthy but degrades overall on a real break + critical DQ", async () => {
    await seedSales();
    const { d0, d2, d3 } = await relativeDates();

    // Day-2 broke reconciliation; day-3 passed. Today/yesterday have no row yet.
    await ctx.pool.query(
      `INSERT INTO audit.reconciliation_results (merchant_id, business_date, status, net_sales_delta_cents)
       VALUES ('M1', CURRENT_DATE - 2, 'failed', 4200),
              ('M1', CURRENT_DATE - 3, 'passed', 0)`,
    );
    await ctx.pool.query(
      `INSERT INTO audit.data_quality_checks (merchant_id, check_name, status, severity)
       VALUES ('M1', 'missing_business_dates', 'failed', 'critical')`,
    );

    const result = await computeDataTrust(ctx.pool, { merchantId: "M1" });

    expect(result.as_of).toBe(d0);
    // The latest day is still settling — NOT an alarm.
    expect(result.asked_day.status).toBe("pending");
    expect(result.sufficient).toBe(true);
    expect(result.caveat).toMatch(/settling/i);

    // ...but the window has a genuine break + a critical DQ failure -> degraded.
    expect(result.overall).toBe("degraded");
    expect(result.reconciliation.unresolved_break_days).toBe(1);
    expect(result.reconciliation.oldest_unresolved_break_day).toBe(d2);
    expect(result.data_quality.critical_failures).toBe(1);

    const byDate = new Map(result.recent_days.map((d) => [d.business_date, d.status]));
    expect(byDate.get(d2)).toBe("failed");
    expect(byDate.get(d3)).toBe("reconciled");
  });

  it("hedges when the ASKED day itself failed reconciliation", async () => {
    await seedSales();
    await ctx.pool.query(
      `INSERT INTO audit.reconciliation_results (merchant_id, business_date, status, net_sales_delta_cents)
       VALUES ('M1', CURRENT_DATE - 2, 'failed', 9900)`,
    );
    const { d2 } = await relativeDates();

    const result = await computeDataTrust(ctx.pool, { merchantId: "M1", date: d2 });

    expect(result.as_of).toBe(d2);
    expect(result.asked_day.status).toBe("failed");
    expect(result.sufficient).toBe(false);
    expect(result.caveat).toMatch(/FAILED/);
    expect(result.overall).toBe("degraded");
  });

  it("a later 'passed' supersedes an earlier 'failed' for the same day (DISTINCT ON newest)", async () => {
    await seedSales();
    // Break, then a self-heal repass an hour later — the newest row is truth.
    await ctx.pool.query(
      `INSERT INTO audit.reconciliation_results (merchant_id, business_date, status, net_sales_delta_cents, created_at)
       VALUES ('M1', CURRENT_DATE - 3, 'failed', 5000, now() - interval '1 hour'),
              ('M1', CURRENT_DATE - 3, 'passed', 0, now())`,
    );
    const { d3 } = await relativeDates();

    const result = await computeDataTrust(ctx.pool, { merchantId: "M1", date: d3 });

    expect(result.asked_day.status).toBe("reconciled");
    expect(result.sufficient).toBe(true);
    expect(result.caveat).toBeNull();
    expect(result.reconciliation.unresolved_break_days).toBe(0);
    expect(result.overall).toBe("ok");
  });

  it("reads an old asked day with no reconcile row as no_data (unverified), never falsely settling", async () => {
    await seedSales();
    const { d5 } = await relativeDates();

    // d5 is neither the latest day nor the day before it, and has no recon row.
    const result = await computeDataTrust(ctx.pool, { merchantId: "M1", date: d5 });

    expect(result.asked_day.status).toBe("no_data");
    expect(result.caveat).toMatch(/unverified/i);
    expect(result.sufficient).toBe(true);
  });

  it("rates a warning-only data-quality failure as caution, not degraded", async () => {
    await seedSales();
    await ctx.pool.query(
      `INSERT INTO audit.data_quality_checks (merchant_id, check_name, status, severity)
       VALUES ('M1', 'daily_order_count_drop', 'failed', 'warning')`,
    );

    const result = await computeDataTrust(ctx.pool, { merchantId: "M1" });

    expect(result.overall).toBe("caution");
    expect(result.sufficient).toBe(true);
    expect(result.data_quality.critical_failures).toBe(0);
    expect(result.data_quality.unresolved_failures).toBe(1);
  });

  it("honors lookback_days when sizing the recent window", async () => {
    await seedSales();
    const { d0 } = await relativeDates();

    const narrow = await computeDataTrust(ctx.pool, { merchantId: "M1", lookbackDays: 3 });
    expect(narrow.recent_days).toHaveLength(3);
    expect(narrow.recent_days[0]!.business_date).toBe(d0);

    const wide = await computeDataTrust(ctx.pool, { merchantId: "M1", lookbackDays: 14 });
    expect(wide.recent_days).toHaveLength(14);
    expect(wide.recent_days[0]!.business_date).toBe(d0);
  });

  it("returns an honest empty verdict when there is no sales data at all", async () => {
    const result = await computeDataTrust(ctx.pool, { merchantId: "M1" });
    expect(result.as_of).toBe("");
    expect(result.recent_days).toHaveLength(0);
    expect(result.overall).toBe("ok");
    expect(result.sufficient).toBe(true);
  });
});
