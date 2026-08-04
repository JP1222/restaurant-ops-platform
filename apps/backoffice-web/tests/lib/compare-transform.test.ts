import { describe, expect, test } from "vitest";
import { transformToCompare } from "@/lib/compare/compare-transform";
import type { TrendGranularity, TrendMetric, TrendsView } from "@/lib/analytics-api/trends-transform";

function view(
  values: number[],
  options: {
    metric?: TrendMetric;
    granularity?: TrendGranularity;
    from?: string;
    to?: string;
    startDay?: number;
  } = {},
): TrendsView {
  const metric = options.metric ?? "net_sales";
  const granularity = options.granularity ?? "day";
  const startDay = options.startDay ?? 1;

  return {
    metric,
    granularity,
    from: options.from ?? "2026-04-01",
    to: options.to ?? "2026-04-30",
    points: values.map((value, index) => ({
      bucket_start: `2026-04-${String(startDay + index).padStart(2, "0")}`,
      value,
      order_count: value / 100,
      net_sales_cents: value,
    })),
    totals: {
      net_sales_cents: values.reduce((sum, value) => sum + value, 0),
      order_count: values.length,
      refund_total_cents: 0,
      discount_total_cents: 0,
    },
  };
}

describe("transformToCompare", () => {
  test("equal-length periods produce paired relative-position points", () => {
    const result = transformToCompare(view([1_000, 2_000]), view([800, 2_500], { startDay: 8 }));

    expect(result.points).toEqual([
      {
        position_label: "Day 1",
        position_index: 1,
        primary_value: 1_000,
        primary_date: "2026-04-01",
        compare_value: 800,
        compare_date: "2026-04-08",
        diff: 200,
        diff_pct: 25,
      },
      {
        position_label: "Day 2",
        position_index: 2,
        primary_value: 2_000,
        primary_date: "2026-04-02",
        compare_value: 2_500,
        compare_date: "2026-04-09",
        diff: -500,
        diff_pct: -20,
      },
    ]);
    expect(result.totals).toEqual({
      primary_value: 3_000,
      compare_value: 3_300,
      diff: -300,
      diff_pct: expect.closeTo(-9.0909, 4),
    });
  });

  test("primary orphan positions remain visible without polluting totals", () => {
    const result = transformToCompare(view([1_000, 2_000, 9_000]), view([500, 1_000]));

    expect(result.points[2]).toMatchObject({
      position_label: "Day 3",
      primary_value: 9_000,
      compare_value: null,
      diff: null,
      diff_pct: null,
    });
    expect(result.totals.primary_value).toBe(3_000);
    expect(result.totals.compare_value).toBe(1_500);
  });

  test("comparison orphan positions remain visible", () => {
    const result = transformToCompare(view([1_000]), view([500, 700]));

    expect(result.points[1]).toMatchObject({
      primary_value: null,
      compare_value: 700,
      diff: null,
      diff_pct: null,
    });
  });

  test("diff_pct is null when comparison value is zero", () => {
    const result = transformToCompare(view([1_000]), view([0]));

    expect(result.points[0]!.diff).toBe(1_000);
    expect(result.points[0]!.diff_pct).toBeNull();
    expect(result.totals.diff_pct).toBeNull();
  });

  test("chart_kind switches from bar to line above 30 points", () => {
    expect(transformToCompare(view(Array.from({ length: 30 }, () => 1)), view([])).chart_kind).toBe(
      "bar",
    );
    expect(transformToCompare(view(Array.from({ length: 31 }, () => 1)), view([])).chart_kind).toBe(
      "line",
    );
  });

  test("weekly granularity uses week labels", () => {
    const result = transformToCompare(
      view([1_000], { granularity: "week" }),
      view([800], { granularity: "week" }),
    );

    expect(result.points[0]!.position_label).toBe("Week 1");
  });

  test("throws on metric or granularity mismatch", () => {
    expect(() => transformToCompare(view([1_000]), view([1_000], { metric: "orders" }))).toThrow(
      /metric mismatch/,
    );
    expect(() =>
      transformToCompare(view([1_000]), view([1_000], { granularity: "week" })),
    ).toThrow(/granularity mismatch/);
  });
});
