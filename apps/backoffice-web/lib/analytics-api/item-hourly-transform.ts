// transformItemToHeatmap returns a DaypartsView that is intentionally
// partial: only `heatmap` and `daysInWindow` are populated. The arrays
// `daypartMix` and `weekdayCurves` are left empty because the only
// consumer in Phase 6 is <DaypartsHeatmap>, which currently reads only
// those two fields (see components/dayparts/heatmap.tsx, lines 40/46/66
// as of Phase 5).
//
// SOFT CONTRACT: if anyone enhances <DaypartsHeatmap> to also render
// daypartMix or weekdayCurves, this transform must be updated in lockstep
// or the per-item Menu drill-down will silently render incomplete data.

import { DateTime } from "luxon";
import type { ItemHourlyRow } from "./types";
import type { DaypartsView, HeatmapCell } from "./dayparts-transform";

const STORE_TZ = "America/Chicago";

function toNumber(value: number | string | null | undefined): number {
  const parsed = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function weekdayForBusinessDate(businessDate: string): number {
  const luxonWeekday = DateTime.fromISO(businessDate, { zone: STORE_TZ }).weekday;
  return luxonWeekday === 7 ? 0 : luxonWeekday;
}

function normalizedHour(row: ItemHourlyRow): number {
  const hour = toNumber(row.local_hour);
  return Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : -1;
}

export function transformItemToHeatmap(rows: ItemHourlyRow[]): DaypartsView | null {
  if (rows.length === 0) return null;

  const sorted = [...rows].sort((a, b) => (a.business_date < b.business_date ? -1 : 1));
  const windowStart = sorted[0]!.business_date;
  const windowEnd = sorted[sorted.length - 1]!.business_date;

  const totalsByCell = new Map<string, { netSalesCents: number; orderCount: number }>();
  const datesByWeekday = new Map<number, Set<string>>();

  for (const row of rows) {
    const hour = normalizedHour(row);
    if (hour === -1) continue;
    const weekday = weekdayForBusinessDate(row.business_date);
    const cellKey = `${weekday}:${hour}`;
    const cell = totalsByCell.get(cellKey) ?? { netSalesCents: 0, orderCount: 0 };
    cell.netSalesCents += toNumber(row.gross_sales_cents);
    cell.orderCount += toNumber(row.line_count);
    totalsByCell.set(cellKey, cell);

    const dates = datesByWeekday.get(weekday) ?? new Set<string>();
    dates.add(row.business_date);
    datesByWeekday.set(weekday, dates);
  }

  const heatmap: HeatmapCell[] = [];
  for (let weekday = 0; weekday < 7; weekday += 1) {
    const sampleSize = datesByWeekday.get(weekday)?.size ?? 0;
    for (let hour = 0; hour < 24; hour += 1) {
      const totals = totalsByCell.get(`${weekday}:${hour}`);
      heatmap.push({
        weekday,
        hour,
        netSalesCents: sampleSize > 0 && totals ? totals.netSalesCents / sampleSize : 0,
        orderCount: sampleSize > 0 && totals ? totals.orderCount / sampleSize : 0,
        sampleSize
      });
    }
  }

  let totalNetSalesCents = 0;
  for (const row of rows) {
    if (normalizedHour(row) === -1) continue;
    totalNetSalesCents += toNumber(row.gross_sales_cents);
  }

  const peakCell = heatmap.reduce<HeatmapCell | null>(
    (best, cell) =>
      cell.netSalesCents > 0 && (best === null || cell.netSalesCents > best.netSalesCents)
        ? cell
        : best,
    null
  );

  const daysInWindow =
    Math.floor(
      (DateTime.fromISO(windowEnd, { zone: STORE_TZ }).toMillis() -
        DateTime.fromISO(windowStart, { zone: STORE_TZ }).toMillis()) /
        (24 * 60 * 60 * 1000)
    ) + 1;

  return {
    windowStart,
    windowEnd,
    daysInWindow,
    heatmap,
    daypartMix: [],
    weekdayCurves: [],
    totalNetSalesCents,
    peakCell
  };
}
