import { DateTime } from "luxon";
import type { HourlyRow } from "./types";

const STORE_TZ = "America/Chicago";

export interface HeatmapCell {
  weekday: number; // 0 = Sunday .. 6 = Saturday
  hour: number; // 0..23
  netSalesCents: number; // average across all weeks in window
  orderCount: number; // average across all weeks in window
  sampleSize: number; // how many weekday occurrences contributed
}

export type DaypartKey = "breakfast" | "lunch" | "dinner" | "off_peak";

export interface DaypartSlice {
  key: DaypartKey;
  label: string;
  hours: number[];
  netSalesCents: number;
  share: number; // 0..1 of total
}

export interface WeekdayCurve {
  weekday: number; // 0..6
  label: string;
  hourly: { hour: number; netSalesCents: number }[]; // length 24
}

export interface DaypartsView {
  windowStart: string; // business_date of first row
  windowEnd: string; // business_date of last row
  daysInWindow: number;
  heatmap: HeatmapCell[]; // length 168 (7 * 24)
  daypartMix: DaypartSlice[];
  weekdayCurves: WeekdayCurve[]; // length 7
  totalNetSalesCents: number;
  peakCell: HeatmapCell | null;
}

const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

const DAYPART_DEFINITIONS: { key: DaypartKey; label: string; hours: number[] }[] = [
  { key: "breakfast", label: "Breakfast (5–10)", hours: [5, 6, 7, 8, 9, 10] },
  { key: "lunch", label: "Lunch (11–14)", hours: [11, 12, 13, 14] },
  { key: "dinner", label: "Dinner (17–21)", hours: [17, 18, 19, 20, 21] },
  {
    key: "off_peak",
    label: "Off-peak / late-night",
    hours: [22, 23, 0, 1, 2, 3, 4, 15, 16]
  }
];

function toNumber(value: number | string | null | undefined): number {
  const parsed = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function weekdayForBusinessDate(businessDate: string): number {
  // Luxon weekday: 1=Mon..7=Sun. Convert to 0=Sun..6=Sat for US calendar convention.
  const luxonWeekday = DateTime.fromISO(businessDate, { zone: STORE_TZ }).weekday;
  return luxonWeekday === 7 ? 0 : luxonWeekday;
}

function normalizedHour(row: HourlyRow): number {
  const hour = toNumber(row.hour);
  return Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : -1;
}

export function transformToDayparts(rows: HourlyRow[]): DaypartsView | null {
  if (rows.length === 0) return null;

  // Sort by business_date ascending; window bounds come from first/last row.
  const sorted = [...rows].sort((a, b) => (a.business_date < b.business_date ? -1 : 1));
  const windowStart = sorted[0]!.business_date;
  const windowEnd = sorted[sorted.length - 1]!.business_date;

  // Accumulate (weekday, hour) -> totals; also track distinct business_dates per
  // weekday so we can divide by sample count, not by event count.
  const totalsByCell = new Map<string, { netSalesCents: number; orderCount: number }>();
  const datesByWeekday = new Map<number, Set<string>>();

  for (const row of rows) {
    const hour = normalizedHour(row);
    if (hour === -1) continue;
    const weekday = weekdayForBusinessDate(row.business_date);
    const cellKey = `${weekday}:${hour}`;
    const cell = totalsByCell.get(cellKey) ?? { netSalesCents: 0, orderCount: 0 };
    cell.netSalesCents += toNumber(row.net_sales_cents);
    cell.orderCount += toNumber(row.order_count);
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

  // Daypart mix: sum net sales across the whole window per daypart.
  // Each row in the input is one business_date x hour, so a straight sum is
  // already "total revenue earned in this daypart across the window".
  const totalsByDaypart = new Map<DaypartKey, number>();
  let totalNetSalesCents = 0;
  for (const row of rows) {
    const hour = normalizedHour(row);
    if (hour === -1) continue;
    const sales = toNumber(row.net_sales_cents);
    totalNetSalesCents += sales;
    for (const daypart of DAYPART_DEFINITIONS) {
      if (daypart.hours.includes(hour)) {
        totalsByDaypart.set(daypart.key, (totalsByDaypart.get(daypart.key) ?? 0) + sales);
        break;
      }
    }
  }

  const daypartMix: DaypartSlice[] = DAYPART_DEFINITIONS.map((d) => {
    const netSalesCents = totalsByDaypart.get(d.key) ?? 0;
    return {
      key: d.key,
      label: d.label,
      hours: d.hours,
      netSalesCents,
      share: totalNetSalesCents > 0 ? netSalesCents / totalNetSalesCents : 0
    };
  });

  // Weekday curves: average net sales per hour for each weekday.
  const weekdayCurves: WeekdayCurve[] = [];
  for (let weekday = 0; weekday < 7; weekday += 1) {
    const sampleSize = datesByWeekday.get(weekday)?.size ?? 0;
    const hourly = Array.from({ length: 24 }, (_, hour) => {
      const totals = totalsByCell.get(`${weekday}:${hour}`);
      return {
        hour,
        netSalesCents: sampleSize > 0 && totals ? totals.netSalesCents / sampleSize : 0
      };
    });
    weekdayCurves.push({
      weekday,
      label: WEEKDAY_LABELS[weekday] ?? `wd${weekday}`,
      hourly
    });
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
    daypartMix,
    weekdayCurves,
    totalNetSalesCents,
    peakCell
  };
}

export { WEEKDAY_LABELS };
