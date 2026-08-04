import { describe, expect, test } from "vitest";
import type { HourlyPulse } from "@/lib/analytics-api/hourly-transform";
import type { KpiNumeric, TodayResponse } from "@/lib/analytics-api/today-shape";
import { runInsights } from "@/lib/insights/rules";

function makeKpi(
  value: number,
  baseline: number | null,
  wow_pct: number | null,
  unit: KpiNumeric["unit"] = "cents",
): KpiNumeric {
  return {
    value,
    unit,
    baseline,
    wow_pct,
    baseline_sample_size: baseline === null ? 0 : 4,
  };
}

function makeToday(overrides: Partial<TodayResponse["kpis"]> = {}, weekday = 2): TodayResponse {
  return {
    mode: "live",
    business_date: "2026-05-05",
    current_business_date: "2026-05-05",
    weekday,
    is_current_day: true,
    store_timezone: "America/Chicago",
    today_open: null,
    kpis: {
      net_sales: makeKpi(100_000, 100_000, 0),
      orders: makeKpi(50, 50, 0, "count"),
      avg_ticket: makeKpi(2_000, 2_000, 0),
      refunds: makeKpi(1_000, 1_000, 0),
      refund_rate: makeKpi(0.01, 0.01, 0, "rate"),
      ...overrides,
    },
  };
}

function makeHourly(
  currentHour: number,
  todayCumulative: number,
  expectedAtNow: number,
): HourlyPulse {
  const points = Array.from({ length: 24 }, (_, hour) => ({
    hour,
    today_cumulative: hour <= currentHour ? todayCumulative : null,
    baseline_mean: hour === currentHour ? expectedAtNow : Math.round((hour / 23) * expectedAtNow),
    baseline_stddev: 0,
    baseline_lower: 0,
    baseline_upper: 0,
    baseline_sample_size: 4,
    today_orders: 1,
  }));

  return {
    business_date: "2026-05-05",
    weekday: 2,
    is_current_day: true,
    points,
    pacing: {
      today_cumulative: todayCumulative,
      baseline_full_day: expectedAtNow * 2,
      progress_pct: (todayCumulative / (expectedAtNow * 2)) * 100,
      hours_remaining: 23 - currentHour,
      current_hour: currentHour,
    },
  };
}

describe("runInsights", () => {
  test("returns no insights when everything is normal", () => {
    const result = runInsights({ today: makeToday(), hourly: makeHourly(12, 100_000, 100_000) });

    expect(result).toEqual([]);
  });

  test("fires sales-pacing-critical when ratio is below 0.6", () => {
    const result = runInsights({ today: makeToday(), hourly: makeHourly(12, 30_000, 100_000) });

    expect(result.find((insight) => insight.id === "sales-pacing-critical")).toBeDefined();
  });

  test("fires sales-pacing-warning when ratio is between 0.6 and 0.8", () => {
    const result = runInsights({ today: makeToday(), hourly: makeHourly(12, 70_000, 100_000) });

    expect(result.find((insight) => insight.id === "sales-pacing-warning")).toBeDefined();
  });

  test("fires sales-pacing-positive when ratio is above 1.3", () => {
    const result = runInsights({ today: makeToday(), hourly: makeHourly(12, 140_000, 100_000) });

    expect(result.find((insight) => insight.id === "sales-pacing-positive")).toBeDefined();
  });

  test("fires refund-rate-elevated when rate and multiple are high", () => {
    const today = makeToday({
      refund_rate: makeKpi(0.04, 0.01, 300, "rate"),
    });

    const result = runInsights({ today, hourly: null });
    const refund = result.find((insight) => insight.id === "refund-rate-elevated");

    expect(refund).toBeDefined();
    expect(refund!.severity).toBe("critical");
  });

  test("does not fire refund-rate when the absolute rate is small", () => {
    const today = makeToday({
      refund_rate: makeKpi(0.005, 0.001, 400, "rate"),
    });

    const result = runInsights({ today, hourly: null });

    expect(result.find((insight) => insight.id === "refund-rate-elevated")).toBeUndefined();
  });

  test("fires avg-ticket-swing on absolute wow above 15 percent", () => {
    const today = makeToday({
      avg_ticket: makeKpi(2_500, 2_000, 25),
    });

    const result = runInsights({ today, hourly: null });
    const swing = result.find((insight) => insight.id === "avg-ticket-swing");

    expect(swing).toBeDefined();
    expect(swing!.severity).toBe("positive");
  });

  test("orders insights by severity with critical first", () => {
    const today = makeToday({
      avg_ticket: makeKpi(2_500, 2_000, 25),
      refund_rate: makeKpi(0.04, 0.01, 300, "rate"),
    });

    const result = runInsights({ today, hourly: null });

    expect(result[0]!.severity).toBe("critical");
  });

  test("caps output at four insights", () => {
    const today = makeToday({
      orders: makeKpi(100, 50, 100, "count"),
      avg_ticket: makeKpi(3_000, 2_000, 50),
      refund_rate: makeKpi(0.04, 0.01, 300, "rate"),
    });

    const result = runInsights({ today, hourly: makeHourly(12, 30_000, 100_000) });

    expect(result).toHaveLength(4);
    expect(result.map((insight) => insight.id)).toContain("order-volume-swing");
  });
});
