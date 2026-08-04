import { describe, expect, test } from "vitest";
import { transformToWeekVsWeek } from "@/lib/analytics-api/wow-transform";
import type { DailySalesRow } from "@/lib/analytics-api/types";

function row(business_date: string, net_sales_cents: number): DailySalesRow {
  return {
    business_date,
    net_sales_cents,
    order_count: 1,
    payment_total_cents: net_sales_cents,
    refund_total_cents: 0,
    tax_total_cents: 0,
    tip_total_cents: 0,
    discount_total_cents: 0,
  };
}

describe("transformToWeekVsWeek", () => {
  test("returns null for empty input", () => {
    expect(transformToWeekVsWeek([])).toBeNull();
  });

  test("builds seven chronological pairs ending at the latest business date", () => {
    const rows: DailySalesRow[] = [];
    for (let day = 1; day <= 14; day += 1) {
      rows.push(row(`2026-05-${day.toString().padStart(2, "0")}`, day * 1_000));
    }

    const result = transformToWeekVsWeek(rows);

    expect(result).not.toBeNull();
    expect(result!.anchor_date).toBe("2026-05-14");
    expect(result!.points.map((point) => point.business_date)).toEqual([
      "2026-05-08",
      "2026-05-09",
      "2026-05-10",
      "2026-05-11",
      "2026-05-12",
      "2026-05-13",
      "2026-05-14",
    ]);
  });

  test("pairs this week with the same weekday last week", () => {
    const result = transformToWeekVsWeek([row("2026-05-05", 1_000), row("2026-05-12", 2_500)]);

    const tuesday = result!.points.find((point) => point.business_date === "2026-05-12");

    expect(tuesday!.weekday_label).toBe("Tue");
    expect(tuesday!.this_week_sales_cents).toBe(2_500);
    expect(tuesday!.last_week_sales_cents).toBe(1_000);
    expect(tuesday!.wow_pct).toBe(150);
  });

  test("keeps missing pairs visible with null percent delta", () => {
    const result = transformToWeekVsWeek([row("2026-05-12", 2_500)]);
    const tuesday = result!.points.find((point) => point.business_date === "2026-05-12");

    expect(tuesday!.this_week_sales_cents).toBe(2_500);
    expect(tuesday!.last_week_sales_cents).toBe(0);
    expect(tuesday!.wow_pct).toBeNull();
    expect(result!.wow_pct).toBeNull();
  });

  // Locks the calendar-day arithmetic across a year boundary after the transform
  // moved off a hardcoded store tz to fixed-zone date math. Also implicitly guards
  // the #686 regression: the lookup map is keyed on the raw business_date string,
  // so if the date keys ever drifted from clean "YYYY-MM-DD" the same-weekday pair
  // below would silently read 0 instead of the prior-week value.
  test("pairs the same weekday across a year boundary", () => {
    const result = transformToWeekVsWeek([row("2025-12-26", 1_000), row("2026-01-02", 3_000)]);

    expect(result!.anchor_date).toBe("2026-01-02");
    expect(result!.points.map((point) => point.business_date)).toEqual([
      "2025-12-27",
      "2025-12-28",
      "2025-12-29",
      "2025-12-30",
      "2025-12-31",
      "2026-01-01",
      "2026-01-02",
    ]);

    const friday = result!.points.find((point) => point.business_date === "2026-01-02");
    expect(friday!.weekday_label).toBe("Fri");
    expect(friday!.this_week_sales_cents).toBe(3_000);
    expect(friday!.last_week_sales_cents).toBe(1_000);
    expect(friday!.wow_pct).toBe(200);
  });
});
