import { DateTime } from "luxon";
import type { DailySalesRow } from "./types";

export interface WeekVsWeekPoint {
  business_date: string;
  weekday: number;
  weekday_label: string;
  this_week_sales_cents: number;
  last_week_sales_cents: number;
  wow_pct: number | null;
}

export interface WeekVsWeekView {
  anchor_date: string;
  points: WeekVsWeekPoint[];
  this_week_total_cents: number;
  last_week_total_cents: number;
  wow_pct: number | null;
}

const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
// `business_date` is already a store-local calendar date ("YYYY-MM-DD"); every
// operation here is pure calendar-day arithmetic. We parse in a fixed zone (UTC)
// so the result is deterministic and server-timezone-independent. The store's
// real timezone only matters for instant↔date conversion, which this transform
// never does — so it must NOT hardcode a store tz here.
const CALENDAR_ZONE = "utc";

function toNumber(value: number | string | null | undefined): number {
  const parsed = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function addDays(date: string, days: number): string {
  return DateTime.fromISO(date, { zone: CALENDAR_ZONE }).plus({ days }).toFormat("yyyy-MM-dd");
}

function weekday(date: string): number {
  return DateTime.fromISO(date, { zone: CALENDAR_ZONE }).weekday % 7;
}

function pctDelta(current: number, baseline: number): number | null {
  return baseline === 0 ? null : ((current - baseline) / baseline) * 100;
}

export function transformToWeekVsWeek(rows: DailySalesRow[]): WeekVsWeekView | null {
  if (rows.length === 0) return null;

  const byDate = new Map<string, DailySalesRow>();
  for (const row of rows) {
    byDate.set(row.business_date, row);
  }

  const anchorDate = [...byDate.keys()].sort().at(-1);
  if (!anchorDate) return null;

  const startDate = addDays(anchorDate, -6);
  const points: WeekVsWeekPoint[] = [];

  for (let offset = 0; offset < 7; offset += 1) {
    const businessDate = addDays(startDate, offset);
    const lastWeekDate = addDays(businessDate, -7);
    const weekdayIndex = weekday(businessDate);
    const thisWeekSales = toNumber(byDate.get(businessDate)?.net_sales_cents);
    const lastWeekSales = toNumber(byDate.get(lastWeekDate)?.net_sales_cents);

    points.push({
      business_date: businessDate,
      weekday: weekdayIndex,
      weekday_label: WEEKDAY_LABELS[weekdayIndex] ?? businessDate,
      this_week_sales_cents: thisWeekSales,
      last_week_sales_cents: lastWeekSales,
      wow_pct: pctDelta(thisWeekSales, lastWeekSales),
    });
  }

  const thisWeekTotal = points.reduce((sum, point) => sum + point.this_week_sales_cents, 0);
  const lastWeekTotal = points.reduce((sum, point) => sum + point.last_week_sales_cents, 0);

  return {
    anchor_date: anchorDate,
    points,
    this_week_total_cents: thisWeekTotal,
    last_week_total_cents: lastWeekTotal,
    wow_pct: pctDelta(thisWeekTotal, lastWeekTotal),
  };
}
