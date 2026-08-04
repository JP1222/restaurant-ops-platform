import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { startAnalyticsItContext, type AnalyticsItContext } from "./fixture.js";
import { ingestPlateCosts } from "../../src/inventory/ingest-plate-costs.js";

// Proves mart.cost_daily_mv (migration 012) against real Postgres: the
// effective-dated plate-cost join, the never-$0 / refund exclusions, coverage
// (costed vs total gross), and the sales-driven LEFT JOIN that keeps a row for
// every day with sales. Does NOT use ctx.truncate() (that wipes the meta
// registry seed); truncates only the base facts it dirties.
describe("cost_daily_mv (real Postgres)", () => {
  let ctx: AnalyticsItContext;

  beforeAll(async () => {
    ctx = await startAnalyticsItContext();
  });

  afterAll(async () => {
    await ctx?.stop();
  });

  it("computes effective-dated COGS, coverage, and net sales per day", async () => {
    await ctx.pool.query(
      "TRUNCATE mart.fact_payments, mart.fact_refunds, mart.fact_order_line_items, mart.dim_item_cost",
    );

    // Net sales: $100 on 06-02, $50 on 06-01 (06-01 has no line items).
    await ctx.pool.query(`
      INSERT INTO mart.fact_payments
        (merchant_id, payment_id, business_date, tender_type, amount_cents)
      VALUES
        ('M1','p1','2026-06-02','CREDIT_CARD',10000),
        ('M1','p0','2026-06-01','CREDIT_CARD', 5000)
    `);

    // Line items on 06-02:
    //   A (clv-a): 2 + 1 units, costed — plate cost is effective-dated.
    //   B (clv-b): 1 unit, NO cost row -> excluded from COGS, never $0.
    //   C (clv-c): refunded -> dropped from COGS, costed AND total gross.
    await ctx.pool.query(`
      INSERT INTO mart.fact_order_line_items
        (merchant_id, order_id, line_item_fingerprint, business_date, item_fingerprint,
         item_id, item_name, quantity, gross_sales_cents, refunded)
      VALUES
        ('M1','o1','li1','2026-06-02','fp-a','clv-a','Vanilla Roll', 2, 1600, false),
        ('M1','o2','li2','2026-06-02','fp-a','clv-a','Vanilla Roll', 1,  800, false),
        ('M1','o3','li3','2026-06-02','fp-b','clv-b','Mystery Roll', 1,  900, false),
        ('M1','o4','li4','2026-06-02','fp-c','clv-c','Refunded Roll',5, 5000, true)
    `);

    // clv-a cost changed 06-01 -> 06-02; the 06-02 lines must use 210, not 200.
    // clv-c has a cost but is refunded, so it must not appear in COGS.
    await ctx.pool.query(`
      INSERT INTO mart.dim_item_cost (clover_item_id, effective_from, plate_cost_cents) VALUES
        ('clv-a','2026-06-01', 200),
        ('clv-a','2026-06-02', 210),
        ('clv-c','2026-06-01', 300)
    `);

    await ctx.pool.query("REFRESH MATERIALIZED VIEW mart.sales_daily_mv");
    await ctx.pool.query("REFRESH MATERIALIZED VIEW mart.cost_daily_mv");

    const { rows } = await ctx.pool.query<{
      business_date: string;
      net_sales_cents: string;
      theoretical_cogs_cents: string;
      costed_gross_sales_cents: string;
      total_gross_sales_cents: string;
    }>(
      `SELECT business_date::text, net_sales_cents, theoretical_cogs_cents,
              costed_gross_sales_cents, total_gross_sales_cents
       FROM mart.cost_daily_mv WHERE merchant_id = 'M1' ORDER BY business_date`,
    );

    const byDate = new Map(rows.map((r) => [r.business_date, r]));

    const d2 = byDate.get("2026-06-02");
    // COGS = (2 + 1) units x 210 (the 06-02 cost, NOT 200) = 630.
    expect(Number(d2?.theoretical_cogs_cents)).toBe(630);
    // Costed gross = item A only (1600 + 800); B uncosted, C refunded.
    expect(Number(d2?.costed_gross_sales_cents)).toBe(2400);
    // Total gross = A + B (3300); C refunded is excluded everywhere.
    expect(Number(d2?.total_gross_sales_cents)).toBe(3300);
    expect(Number(d2?.net_sales_cents)).toBe(10000);

    // A day with sales but no line items still gets a row: COGS 0, coverage 0.
    const d1 = byDate.get("2026-06-01");
    expect(Number(d1?.net_sales_cents)).toBe(5000);
    expect(Number(d1?.theoretical_cogs_cents)).toBe(0);
    expect(Number(d1?.total_gross_sales_cents)).toBe(0);
  });

  // Regression for #474: a plate cost ingested as a UTC instant just after
  // midnight (its UTC date is a day AHEAD of the store-local date it actually
  // took effect) MUST still cost a sale on that store-local business date.
  // Before the fix, effective_from was stored as the UTC date, so the
  // `effective_from <= business_date` join dropped the cost and COGS read $0.
  it("costs a near-midnight sale instead of dropping it (UTC vs store-local)", async () => {
    await ctx.pool.query(
      "TRUNCATE mart.fact_payments, mart.fact_refunds, mart.fact_order_line_items, mart.dim_item_cost",
    );

    // Cost recorded 2026-06-02 19:30 America/Chicago (CDT, UTC-5) = 2026-06-03
    // 00:30 UTC. Stored UTC-naively this lands on effective_from = 2026-06-03;
    // stored store-locally (the fix) it lands on 2026-06-02 — the day it took
    // effect and the day the sale below happened.
    const nearMidnightUtc = "2026-06-03T00:30:00.000Z";
    await ingestPlateCosts(
      ctx.pool,
      [{ clover_item_id: "clv-x", plate_cost_cents: 250, currency: "USD", effective_from: nearMidnightUtc }],
      "America/Chicago",
    );

    // Prove the ingest stored the STORE-LOCAL date, not the UTC date.
    const stored = await ctx.pool.query<{ effective_from: string }>(
      "SELECT effective_from::text FROM mart.dim_item_cost WHERE clover_item_id = 'clv-x'",
    );
    expect(stored.rows[0]?.effective_from).toBe("2026-06-02");

    // A $20 payment + one costed line on the store-local business date 2026-06-02.
    await ctx.pool.query(`
      INSERT INTO mart.fact_payments
        (merchant_id, payment_id, business_date, tender_type, amount_cents)
      VALUES ('M2','p-x','2026-06-02','CREDIT_CARD',2000)
    `);
    await ctx.pool.query(`
      INSERT INTO mart.fact_order_line_items
        (merchant_id, order_id, line_item_fingerprint, business_date, item_fingerprint,
         item_id, item_name, quantity, gross_sales_cents, refunded)
      VALUES ('M2','o-x','li-x','2026-06-02','fp-x','clv-x','Midnight Roll', 2, 2000, false)
    `);

    await ctx.pool.query("REFRESH MATERIALIZED VIEW mart.sales_daily_mv");
    await ctx.pool.query("REFRESH MATERIALIZED VIEW mart.cost_daily_mv");

    const { rows } = await ctx.pool.query<{
      theoretical_cogs_cents: string;
      costed_gross_sales_cents: string;
      total_gross_sales_cents: string;
    }>(
      `SELECT theoretical_cogs_cents, costed_gross_sales_cents, total_gross_sales_cents
       FROM mart.cost_daily_mv WHERE merchant_id = 'M2' AND business_date = '2026-06-02'`,
    );

    // The cost is applied: 2 units x 250 = 500 (NOT dropped to 0), and the line
    // is counted as costed (coverage = costed/total = 2000/2000 = 100%).
    expect(Number(rows[0]?.theoretical_cogs_cents)).toBe(500);
    expect(Number(rows[0]?.costed_gross_sales_cents)).toBe(2000);
    expect(Number(rows[0]?.total_gross_sales_cents)).toBe(2000);
  });
});
