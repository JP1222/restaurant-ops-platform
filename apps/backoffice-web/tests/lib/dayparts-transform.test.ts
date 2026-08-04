import { describe, expect, test } from "vitest";
import { transformToDayparts } from "@/lib/analytics-api/dayparts-transform";
import type { HourlyRow } from "@/lib/analytics-api/types";

function row(date: string, hour: number, netCents: number, orders = 1): HourlyRow {
  return {
    business_date: date,
    hour,
    net_sales_cents: netCents,
    order_count: orders,
    payment_total_cents: netCents
  };
}

describe("transformToDayparts", () => {
  test("returns null on empty input", () => {
    expect(transformToDayparts([])).toBeNull();
  });

  test("produces a 168-cell heatmap with weekday 0..6 hour 0..23", () => {
    // 2026-05-11 was a Monday in store TZ.
    const view = transformToDayparts([row("2026-05-11", 12, 5000)])!;
    expect(view.heatmap).toHaveLength(168);
    expect(view.heatmap.every((c) => c.weekday >= 0 && c.weekday <= 6)).toBe(true);
    expect(view.heatmap.every((c) => c.hour >= 0 && c.hour <= 23)).toBe(true);

    // 2026-05-11 is a Monday => weekday=1 in 0=Sun convention.
    const mondayNoon = view.heatmap.find((c) => c.weekday === 1 && c.hour === 12)!;
    expect(mondayNoon.netSalesCents).toBe(5000);
    expect(mondayNoon.sampleSize).toBe(1);
  });

  test("averages across multiple occurrences of the same weekday-hour", () => {
    const view = transformToDayparts([
      row("2026-05-11", 12, 6000), // Monday
      row("2026-05-18", 12, 4000) // also Monday, one week later
    ])!;

    const mondayNoon = view.heatmap.find((c) => c.weekday === 1 && c.hour === 12)!;
    expect(mondayNoon.netSalesCents).toBe(5000); // avg of 6000 and 4000
    expect(mondayNoon.sampleSize).toBe(2);
  });

  test("daypart mix: lunch hours are bucketed into 'lunch'", () => {
    const view = transformToDayparts([
      row("2026-05-11", 7, 100), // breakfast
      row("2026-05-11", 12, 900), // lunch
      row("2026-05-11", 19, 500) // dinner
    ])!;

    const lunch = view.daypartMix.find((d) => d.key === "lunch")!;
    expect(lunch.netSalesCents).toBe(900);
    expect(lunch.share).toBeCloseTo(900 / 1500, 5);

    const breakfast = view.daypartMix.find((d) => d.key === "breakfast")!;
    expect(breakfast.netSalesCents).toBe(100);

    const dinner = view.daypartMix.find((d) => d.key === "dinner")!;
    expect(dinner.netSalesCents).toBe(500);
  });

  test("off-peak bucket catches hours not in breakfast/lunch/dinner", () => {
    const view = transformToDayparts([
      row("2026-05-11", 2, 50), // late-night
      row("2026-05-11", 15, 200), // between lunch and dinner
      row("2026-05-11", 23, 80) // late-night
    ])!;

    const off = view.daypartMix.find((d) => d.key === "off_peak")!;
    expect(off.netSalesCents).toBe(330);
    expect(off.share).toBeCloseTo(1, 5);
  });

  test("weekdayCurves returns 7 curves of length 24 each", () => {
    const view = transformToDayparts([row("2026-05-11", 12, 1000)])!;
    expect(view.weekdayCurves).toHaveLength(7);
    for (const curve of view.weekdayCurves) {
      expect(curve.hourly).toHaveLength(24);
    }
  });

  test("peakCell points at the highest-revenue cell", () => {
    const view = transformToDayparts([
      row("2026-05-11", 12, 100),
      row("2026-05-16", 19, 999) // Saturday 7pm
    ])!;

    expect(view.peakCell).not.toBeNull();
    expect(view.peakCell!.netSalesCents).toBe(999);
    // 2026-05-16 is a Saturday => weekday=6 (0=Sun).
    expect(view.peakCell!.weekday).toBe(6);
    expect(view.peakCell!.hour).toBe(19);
  });

  test("ignores out-of-range hour values without throwing", () => {
    const view = transformToDayparts([
      { business_date: "2026-05-11", hour: -1, net_sales_cents: 9999, order_count: 1, payment_total_cents: 0 },
      { business_date: "2026-05-11", hour: 25, net_sales_cents: 9999, order_count: 1, payment_total_cents: 0 },
      row("2026-05-11", 12, 100)
    ])!;
    expect(view.totalNetSalesCents).toBe(100);
  });

  test("daysInWindow counts inclusive day range", () => {
    const view = transformToDayparts([
      row("2026-05-01", 12, 100),
      row("2026-05-07", 12, 100)
    ])!;
    expect(view.daysInWindow).toBe(7);
    expect(view.windowStart).toBe("2026-05-01");
    expect(view.windowEnd).toBe("2026-05-07");
  });
});
