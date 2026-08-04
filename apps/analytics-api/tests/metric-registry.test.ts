import { describe, expect, it } from "vitest";
import { composeMetricSql, type MetricDefinition } from "../src/analytics/metric-registry.js";

const netSales: MetricDefinition = {
  name: "net_sales_cents",
  label: "Net Sales",
  measure: "sum(net_sales_cents)",
  baseView: "mart.sales_daily_mv",
  allowedDimensions: ["business_date"],
  allowedFilters: [],
  unit: "cents",
  format: "currency",
  synonyms: [],
  definition: "Payment total minus refunds.",
};

const avgTicket: MetricDefinition = {
  ...netSales,
  name: "avg_ticket_cents",
  measure: "sum(net_sales_cents)::numeric / nullif(sum(order_count), 0)",
  unit: "ratio",
};

const cashSales: MetricDefinition = {
  ...netSales,
  name: "cash_sales_cents",
  measure: "sum(amount_cents) filter (where tender_type = 'CASH')",
  baseView: "mart.payment_method_daily_mv",
  allowedFilters: ["tender_type"],
};

// Phase-5 distribution metric: a per-order percentile over fact_orders. Proves the
// composer interpolates a non-aggregate-sum measure (percentile_cont WITHIN GROUP)
// verbatim and still binds the merchant/date/day params, so no composer change is
// needed to add it (migration 023).
const medianTicket: MetricDefinition = {
  ...netSales,
  name: "median_ticket_cents",
  measure: "percentile_cont(0.5) within group (order by net_sales_cents)",
  baseView: "mart.fact_orders",
};

const CHI = "America/Chicago";

describe("composeMetricSql", () => {
  it("composes a per-order percentile measure over fact_orders", () => {
    const q = composeMetricSql(medianTicket, {
      merchantId: "M1",
      timezone: CHI,
      window: { mode: "days", days: 30 },
      dimensions: ["business_date"],
    });
    expect(q.text).toContain(
      "percentile_cont(0.5) within group (order by net_sales_cents) AS value",
    );
    expect(q.text).toContain("FROM mart.fact_orders, bounds");
    expect(q.text).toContain("merchant_id = $1");
    expect(q.text).toContain("GROUP BY business_date");
    expect(q.values).toEqual(["M1", CHI, 30]);
  });

  it("composes a timezone-aware daily series for the days window", () => {
    const q = composeMetricSql(netSales, {
      merchantId: "M1",
      timezone: CHI,
      window: { mode: "days", days: 7 },
      dimensions: ["business_date"],
    });
    expect(q.text).toContain("WITH bounds AS (SELECT (now() AT TIME ZONE $2)::date AS today)");
    expect(q.text).toContain("sum(net_sales_cents) AS value");
    expect(q.text).toContain("FROM mart.sales_daily_mv, bounds");
    expect(q.text).toContain("merchant_id = $1");
    expect(q.text).toContain("business_date >= bounds.today - ($3::integer - 1)");
    expect(q.text).toContain("GROUP BY business_date");
    expect(q.text).toContain("ORDER BY business_date");
    // merchant $1, timezone $2, days $3
    expect(q.values).toEqual(["M1", CHI, 7]);
  });

  it("composes a grand total (no dimensions) for the range window", () => {
    const q = composeMetricSql(netSales, {
      merchantId: "M1",
      timezone: CHI,
      window: { mode: "range", from: "2026-06-01", to: "2026-06-02" },
    });
    expect(q.text).toContain("sum(net_sales_cents) AS value");
    expect(q.text).toContain("business_date BETWEEN $2::date AND $3::date");
    expect(q.text).not.toContain("GROUP BY");
    expect(q.text).not.toContain("WITH bounds");
    expect(q.values).toEqual(["M1", "2026-06-01", "2026-06-02"]);
  });

  it("keeps a ratio measure intact (computed per group, not summed)", () => {
    const q = composeMetricSql(avgTicket, {
      merchantId: "M1",
      timezone: CHI,
      window: { mode: "days", days: 30 },
    });
    expect(q.text).toContain("sum(net_sales_cents)::numeric / nullif(sum(order_count), 0) AS value");
  });

  it("binds an allowed filter value as a parameter", () => {
    const q = composeMetricSql(cashSales, {
      merchantId: "M1",
      timezone: CHI,
      window: { mode: "range", from: "2026-06-01", to: "2026-06-02" },
      filters: { tender_type: "CASH" },
    });
    expect(q.text).toContain("tender_type = $4");
    expect(q.values).toEqual(["M1", "2026-06-01", "2026-06-02", "CASH"]);
  });

  it("rejects a dimension outside the allow-list", () => {
    expect(() =>
      composeMetricSql(netSales, {
        merchantId: "M1",
        timezone: CHI,
        window: { mode: "days", days: 7 },
        dimensions: ["weekday"],
      }),
    ).toThrow(/dimension "weekday"/);
  });

  it("rejects a filter outside the allow-list", () => {
    expect(() =>
      composeMetricSql(netSales, {
        merchantId: "M1",
        timezone: CHI,
        window: { mode: "days", days: 7 },
        filters: { tender_type: "CASH" },
      }),
    ).toThrow(/filter "tender_type"/);
  });

  it("rejects a non-ISO range date", () => {
    expect(() =>
      composeMetricSql(netSales, {
        merchantId: "M1",
        timezone: CHI,
        window: { mode: "range", from: "June 1", to: "2026-06-02" },
      }),
    ).toThrow(/ISO dates/);
  });

  it("rejects a non-positive day count", () => {
    expect(() =>
      composeMetricSql(netSales, {
        merchantId: "M1",
        timezone: CHI,
        window: { mode: "days", days: 0 },
      }),
    ).toThrow(/positive integer/);
  });
});
