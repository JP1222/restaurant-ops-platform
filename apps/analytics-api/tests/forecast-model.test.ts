import { describe, expect, it } from "vitest";
import { DateTime } from "luxon";

import { backtest, weekdaySeasonalForecast, type SeriesPoint } from "../src/forecast/model.js";

// `weeks` weeks of daily points starting on a Monday; value = valueFor(weekday, dayIndex).
function buildSeries(
  startMonday: string,
  weeks: number,
  valueFor: (weekday: number, dayIndex: number) => number,
): SeriesPoint[] {
  const start = DateTime.fromISO(startMonday, { zone: "utc" });
  const out: SeriesPoint[] = [];
  for (let i = 0; i < weeks * 7; i += 1) {
    const d = start.plus({ days: i });
    out.push({ date: d.toISODate()!, value: valueFor(d.weekday, i) });
  }
  return out;
}

const WEEKDAY_BASE: Record<number, number> = { 1: 100, 2: 200, 3: 300, 4: 400, 5: 500, 6: 600, 7: 700 };
const MONDAY = "2026-01-05"; // 2026-01-05 is a Monday (Luxon weekday 1)

describe("weekdaySeasonalForecast", () => {
  it("reproduces a clean weekday profile with a zero band, starting the day after history", () => {
    const history = buildSeries(MONDAY, 8, (w) => WEEKDAY_BASE[w]!);
    const fc = weekdaySeasonalForecast(history, 7);

    expect(fc).toHaveLength(7);
    for (const point of fc) {
      const w = DateTime.fromISO(point.target_date, { zone: "utc" }).weekday;
      expect(point.value).toBe(WEEKDAY_BASE[w]!);
      // constant samples -> std 0 -> band collapses onto the point
      expect(point.lo).toBe(WEEKDAY_BASE[w]!);
      expect(point.hi).toBe(WEEKDAY_BASE[w]!);
    }
    const lastDate = history[history.length - 1]!.date;
    expect(fc[0]!.target_date).toBe(
      DateTime.fromISO(lastDate, { zone: "utc" }).plus({ days: 1 }).toISODate(),
    );
  });

  it("returns [] for empty history or a non-positive horizon", () => {
    expect(weekdaySeasonalForecast([], 7)).toEqual([]);
    expect(weekdaySeasonalForecast(buildSeries(MONDAY, 2, () => 100), 0)).toEqual([]);
  });

  it("clamps the lower band at 0 for a high-variance weekday", () => {
    // Mondays alternate 10 / 200 across weeks -> mean 105, large std -> lo would go < 0.
    const history = buildSeries(MONDAY, 8, (w, i) =>
      w === 1 ? (Math.floor(i / 7) % 2 === 0 ? 10 : 200) : 100,
    );
    const fc = weekdaySeasonalForecast(history, 7);
    const monday = fc.find((p) => DateTime.fromISO(p.target_date, { zone: "utc" }).weekday === 1)!;
    expect(monday.value).toBeCloseTo(105, 6);
    expect(monday.lo).toBe(0);
    expect(monday.hi).toBeGreaterThan(monday.value);
  });
});

describe("backtest", () => {
  it("scores 0 error on a perfectly periodic series", () => {
    const history = buildSeries(MONDAY, 8, (w) => WEEKDAY_BASE[w]!);
    const result = backtest(history, 7);
    expect(result.n).toBe(7);
    expect(result.mape).toBe(0);
    expect(result.wape).toBe(0);
  });

  it("scores a known 10% level jump in the held-out week", () => {
    // 100 for 7 weeks, then 110 for the last week. Model trained on the 100s.
    const history = buildSeries(MONDAY, 8, (_w, i) => (i >= 49 ? 110 : 100));
    const result = backtest(history, 7);
    expect(result.n).toBe(7);
    expect(result.mape).toBeCloseTo(10 / 110, 6);
    expect(result.wape).toBeCloseTo(70 / 770, 6);
  });

  it("returns nulls when there isn't enough history to hold out a window", () => {
    const history = buildSeries(MONDAY, 1, () => 100).slice(0, 5);
    expect(backtest(history, 30)).toEqual({ mape: null, wape: null, n: 0 });
  });
});
