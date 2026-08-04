import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { startAnalyticsItContext, type AnalyticsItContext } from "./fixture.js";
import { loadMetricRegistry, resolveMetric } from "../../src/analytics/metric-registry.js";

// Proves migration 010 + the metric registry against a real Postgres: the
// migration applies and seeds the structured columns, loadMetricRegistry reads
// them, and resolveMetric composes SQL that actually executes against the real
// mart views and matches a hand-written query (the Phase 0b acceptance bar).
// Note: we do NOT use ctx.truncate() — it wipes the `meta` schema (and thus the
// seeded registry); each test truncates only the base facts it dirties.
describe("metric registry (real Postgres)", () => {
  let ctx: AnalyticsItContext;
  const RANGE = { mode: "range", from: "2026-06-01", to: "2026-06-02" } as const;
  const BASE = { merchantId: "M1", timezone: "America/Chicago" };

  beforeAll(async () => {
    ctx = await startAnalyticsItContext();
  });

  afterAll(async () => {
    await ctx?.stop();
  });

  it("migration 010 seeds the structured registry intact", async () => {
    const registry = await loadMetricRegistry(ctx.pool);

    expect(registry.get("net_sales_cents")).toMatchObject({
      measure: "sum(net_sales_cents)",
      baseView: "mart.sales_daily_mv",
      unit: "cents",
      allowedDimensions: ["business_date"],
    });
    expect(registry.get("avg_ticket_cents")?.unit).toBe("ratio");
    // The doubled-quote filter literal must survive the migration intact.
    expect(registry.get("cash_sales_cents")?.measure).toBe(
      "sum(amount_cents) filter (where tender_type = 'CASH')",
    );
    expect(registry.get("cash_sales_cents")?.baseView).toBe("mart.payment_method_daily_mv");
  });

  it("resolveMetric executes against every real base view without error", async () => {
    await ctx.pool.query(
      "TRUNCATE mart.fact_orders, mart.fact_payments, mart.fact_refunds, mart.fact_order_line_items",
    );
    for (const mv of ["sales_daily_mv", "item_sales_daily_mv", "payment_method_daily_mv"]) {
      await ctx.pool.query(`REFRESH MATERIALIZED VIEW mart.${mv}`);
    }
    const registry = await loadMetricRegistry(ctx.pool);

    // net_sales (sales_daily_mv), gross_sales (item_sales_daily_mv),
    // cash_sales (payment_method_daily_mv) — each must resolve its base view +
    // measure columns against the real schema. Empty mart => one null row.
    for (const name of ["net_sales_cents", "gross_sales_cents", "cash_sales_cents"]) {
      const res = await resolveMetric(ctx.pool, registry, name, { ...BASE, window: RANGE });
      expect(res.rows).toHaveLength(1);
      expect(res.sql).toContain("mart.");
    }
  });

  it("resolveMetric returns correct values and matches a direct query", async () => {
    await ctx.pool.query("TRUNCATE mart.fact_orders");
    await ctx.pool.query(`
      INSERT INTO mart.fact_orders (merchant_id, order_id, business_date) VALUES
        ('M1', 'o1', '2026-06-01'),
        ('M1', 'o2', '2026-06-01'),
        ('M1', 'o3', '2026-06-02')
    `);
    await ctx.pool.query("REFRESH MATERIALIZED VIEW mart.sales_daily_mv");
    const registry = await loadMetricRegistry(ctx.pool);

    // Grouped series: two business dates, totalling three orders.
    const series = await resolveMetric(ctx.pool, registry, "order_count", {
      ...BASE,
      window: RANGE,
      dimensions: ["business_date"],
    });
    expect(series.rows).toHaveLength(2);
    expect(series.rows.reduce((sum, r) => sum + Number(r.value), 0)).toBe(3);

    // Grand total equals a hand-written query against the same MV.
    const total = await resolveMetric(ctx.pool, registry, "order_count", { ...BASE, window: RANGE });
    const direct = await ctx.pool.query<{ value: string }>(
      `SELECT sum(order_count) AS value FROM mart.sales_daily_mv
       WHERE merchant_id = $1 AND business_date BETWEEN $2::date AND $3::date`,
      ["M1", RANGE.from, RANGE.to],
    );
    expect(Number(total.rows[0]?.value)).toBe(3);
    expect(Number(total.rows[0]?.value)).toBe(Number(direct.rows[0]?.value));
  });
});
