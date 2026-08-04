import { describe, expect, test } from "vitest";
import { transformItemToHeatmap } from "@/lib/analytics-api/item-hourly-transform";
import type { ItemHourlyRow } from "@/lib/analytics-api/types";

function row(
  date: string,
  hour: number,
  grossCents: number,
  lineCount = 1
): ItemHourlyRow {
  return {
    business_date: date,
    local_hour: hour,
    quantity: lineCount,
    gross_sales_cents: grossCents,
    line_count: lineCount
  };
}

describe("transformItemToHeatmap", () => {
  test("returns null on empty input", () => {
    expect(transformItemToHeatmap([])).toBeNull();
  });

  test("averages a 168-cell heatmap across multiple occurrences of the same weekday-hour", () => {
    // 2026-05-11 (Mon) and 2026-05-18 (Mon, one week later)
    const view = transformItemToHeatmap([
      row("2026-05-11", 12, 6000),
      row("2026-05-18", 12, 4000)
    ])!;

    expect(view.heatmap).toHaveLength(168);
    expect(view.daypartMix).toEqual([]);
    expect(view.weekdayCurves).toEqual([]);

    // 2026-05-11 is a Monday => weekday=1 in 0=Sun convention.
    const mondayNoon = view.heatmap.find((c) => c.weekday === 1 && c.hour === 12)!;
    expect(mondayNoon.netSalesCents).toBe(5000); // avg of 6000 and 4000
    expect(mondayNoon.sampleSize).toBe(2);
  });

  test("peakCell identifies the highest-revenue (weekday, hour) bucket", () => {
    const view = transformItemToHeatmap([
      row("2026-05-11", 12, 100), // Mon noon
      row("2026-05-16", 19, 999) // Sat 7pm
    ])!;

    expect(view.peakCell).not.toBeNull();
    expect(view.peakCell!.netSalesCents).toBe(999);
    expect(view.peakCell!.weekday).toBe(6); // Saturday in 0=Sun convention
    expect(view.peakCell!.hour).toBe(19);
  });
});
