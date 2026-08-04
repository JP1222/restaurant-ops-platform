import { DateTime } from "luxon";
import type { HourlyRow } from "./types";

// Fallback only — the real store zone rides on the caller-supplied `nowInStoreTz`.
const DEFAULT_STORE_TZ = "America/Chicago";

export interface HourlyPulsePoint {
  hour: number;
  today_cumulative: number | null;
  baseline_mean: number;
  baseline_stddev: number;
  baseline_lower: number;
  baseline_upper: number;
  baseline_sample_size: number;
  today_orders: number;
}

export interface PacingState {
  today_cumulative: number;
  baseline_full_day: number;
  progress_pct: number;
  hours_remaining: number;
  current_hour: number;
}

export interface HourlyPulse {
  business_date: string;
  weekday: number;
  is_current_day: boolean;
  points: HourlyPulsePoint[];
  pacing: PacingState | null;
}

function toNumber(value: number | string | null | undefined): number {
  const parsed = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function stddev(values: number[]): number {
  if (values.length < 2) return 0;

  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;

  return Math.sqrt(variance);
}

function weekdayForBusinessDate(businessDate: string, zone: string): number {
  return DateTime.fromISO(businessDate, { zone }).weekday % 7;
}

function normalizedHour(row: HourlyRow): number {
  const hour = toNumber(row.hour);
  return Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : -1;
}

export function transformToHourlyPulse(
  rows: HourlyRow[],
  nowInStoreTz: DateTime,
): HourlyPulse | null {
  if (rows.length === 0) return null;

  const sortedDesc = [...rows].sort((a, b) =>
    a.business_date < b.business_date ? 1 : a.business_date > b.business_date ? -1 : 0,
  );
  const today = sortedDesc[0];
  if (!today) return null;

  const businessDate = today.business_date;
  // `nowInStoreTz` arrives already set to the store's zone; derive the zone from
  // it so day/hour boundaries bucket in the store's OWN timezone. The old code
  // re-`setZone`d to a hardcoded America/Chicago, silently shifting a non-Central
  // store #2's "current day"/"current hour" by its UTC offset.
  const zone = nowInStoreTz.zoneName ?? DEFAULT_STORE_TZ;
  const weekday = weekdayForBusinessDate(businessDate, zone);
  const is_current_day = businessDate === nowInStoreTz.toFormat("yyyy-MM-dd");
  const currentHour = is_current_day ? nowInStoreTz.hour : 23;

  const byDate = new Map<string, Map<number, HourlyRow>>();
  for (const row of rows) {
    const hour = normalizedHour(row);
    if (hour === -1) continue;

    const existing = byDate.get(row.business_date) ?? new Map<number, HourlyRow>();
    existing.set(hour, row);
    byDate.set(row.business_date, existing);
  }

  const todayHours = byDate.get(businessDate) ?? new Map<number, HourlyRow>();
  const sameWeekdayDates = Array.from(byDate.keys())
    .filter((date) => date !== businessDate)
    .filter((date) => weekdayForBusinessDate(date, zone) === weekday)
    .sort()
    .reverse()
    .slice(0, 4);

  const points: HourlyPulsePoint[] = [];
  let todayCumulative = 0;

  for (let hour = 0; hour < 24; hour += 1) {
    const todayHour = todayHours.get(hour);
    const todayOrders = toNumber(todayHour?.order_count);
    let today_cumulative: number | null;

    if (is_current_day && hour > currentHour) {
      today_cumulative = null;
    } else {
      todayCumulative += toNumber(todayHour?.net_sales_cents);
      today_cumulative = todayCumulative;
    }

    const baselineSamples = sameWeekdayDates.map((date) => {
      const historicalHours = byDate.get(date) ?? new Map<number, HourlyRow>();
      let cumulative = 0;

      for (let h = 0; h <= hour; h += 1) {
        cumulative += toNumber(historicalHours.get(h)?.net_sales_cents);
      }

      return cumulative;
    });

    const baseline_mean =
      baselineSamples.length > 0
        ? baselineSamples.reduce((sum, value) => sum + value, 0) / baselineSamples.length
        : 0;
    const baseline_stddev = stddev(baselineSamples);

    points.push({
      hour,
      today_cumulative,
      baseline_mean,
      baseline_stddev,
      baseline_lower: Math.max(0, baseline_mean - baseline_stddev),
      baseline_upper: baseline_mean + baseline_stddev,
      baseline_sample_size: baselineSamples.length,
      today_orders: today_cumulative === null ? 0 : todayOrders,
    });
  }

  const currentPoint = points[currentHour];
  const baselineFullDay = points[23]?.baseline_mean ?? 0;
  const todayCumulativeNow = currentPoint?.today_cumulative ?? 0;
  const pacing = is_current_day
    ? {
        today_cumulative: todayCumulativeNow,
        baseline_full_day: baselineFullDay,
        progress_pct: baselineFullDay > 0 ? (todayCumulativeNow / baselineFullDay) * 100 : 0,
        hours_remaining: 23 - currentHour,
        current_hour: currentHour,
      }
    : null;

  return {
    business_date: businessDate,
    weekday,
    is_current_day,
    points,
    pacing,
  };
}
