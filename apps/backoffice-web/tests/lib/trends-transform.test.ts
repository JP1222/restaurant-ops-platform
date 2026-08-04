import { describe, expect, test } from "vitest";
import { transformToTrends } from "@/lib/analytics-api/trends-transform";
import type { DailySalesRow } from "@/lib/analytics-api/types";

function row(
  business_date: string,
  net_sales_cents: number,
  order_count: number,
  refund_total_cents = 0,
  discount_total_cents = 0,
): DailySalesRow {
  return {
    business_date,
    net_sales_cents,
    order_count,
    refund_total_cents,
    payment_total_cents: net_sales_cents + refund_total_cents,
    tax_total_cents: 0,
    tip_total_cents: 0,
    discount_total_cents,
  };
}

describe("transformToTrends", () => {
  test("returns an empty valid shape for empty rows", () => {
    expect(transformToTrends([], "net_sales", "day", "2026-04-01", "2026-04-30")).toEqual({
      metric: "net_sales",
      granularity: "day",
      from: "2026-04-01",
      to: "2026-04-30",
      points: [],
      totals: {
        net_sales_cents: 0,
        order_count: 0,
        refund_total_cents: 0,
        discount_total_cents: 0,
      },
    });
  });

  test("discounts metric reports the per-bucket discount total as a loss lens", () => {
    const result = transformToTrends(
      [
        row("2026-04-01", 10_000, 5, 0, 800),
        row("2026-04-02", 12_000, 6, 0, 1_500),
      ],
      "discounts",
      "day",
      "2026-04-01",
      "2026-04-02",
    );
    expect(result.points.map((point) => point.value)).toEqual([800, 1_500]);
    expect(result.totals.discount_total_cents).toBe(2_300);
  });

  test("day granularity filters range and sorts by business date", () => {
    const result = transformToTrends(
      [
        row("2026-04-03", 3_000, 3),
        row("2026-03-31", 9_000, 9),
        row("2026-04-01", 1_000, 1),
        row("2026-04-02", 2_000, 2),
      ],
      "net_sales",
      "day",
      "2026-04-01",
      "2026-04-03",
    );

    expect(result.points.map((point) => point.bucket_start)).toEqual([
      "2026-04-01",
      "2026-04-02",
      "2026-04-03",
    ]);
    expect(result.points.map((point) => point.value)).toEqual([1_000, 2_000, 3_000]);
    expect(result.totals.net_sales_cents).toBe(6_000);
  });

  test("week granularity groups by ISO Monday", () => {
    const result = transformToTrends(
      [row("2026-04-06", 1_000, 1), row("2026-04-07", 2_000, 2), row("2026-04-13", 3_000, 3)],
      "net_sales",
      "week",
      "2026-04-01",
      "2026-04-30",
    );

    expect(result.points).toEqual([
      {
        bucket_start: "2026-04-06",
        value: 3_000,
        order_count: 3,
        net_sales_cents: 3_000,
      },
      {
        bucket_start: "2026-04-13",
        value: 3_000,
        order_count: 3,
        net_sales_cents: 3_000,
      },
    ]);
  });

  test("orders metric uses order counts", () => {
    const result = transformToTrends(
      [row("2026-04-01", 10_000, 7), row("2026-04-02", 20_000, 9)],
      "orders",
      "day",
      "2026-04-01",
      "2026-04-02",
    );

    expect(result.points.map((point) => point.value)).toEqual([7, 9]);
  });

  test("avg ticket uses bucket totals for weekly aggregation", () => {
    const result = transformToTrends(
      [row("2026-04-06", 10_000, 1), row("2026-04-07", 20_000, 9)],
      "avg_ticket",
      "week",
      "2026-04-01",
      "2026-04-30",
    );

    expect(result.points[0]!.value).toBe(3_000);
  });

  test("refund rate uses refund total divided by payment total (registry 口径)", () => {
    const result = transformToTrends(
      [row("2026-04-01", 10_000, 4, 500), row("2026-04-02", 20_000, 6, 2_000)],
      "refund_rate",
      "week",
      "2026-04-01",
      "2026-04-30",
    );

    // refund / payment_total (ADR-0030), NOT refund / net_sales:
    // week totals payment 32_500, refund 2_500 -> 2_500 / 32_500 = 0.076923
    // (the legacy ÷net value was 0.08333). Matches Today's migrated 口径.
    expect(result.points[0]!.value).toBeCloseTo(0.076923, 4);
    expect(result.totals.refund_total_cents).toBe(2_500);
  });

  test("refund rate at day grain also divides by payment total", () => {
    const result = transformToTrends(
      [row("2026-04-01", 9_500, 4, 500)],
      "refund_rate",
      "day",
      "2026-04-01",
      "2026-04-01",
    );

    // payment_total = 9_500 + 500 = 10_000; refund_rate = 500 / 10_000 = 0.05.
    expect(result.points[0]!.value).toBeCloseTo(0.05, 6);
  });
});
