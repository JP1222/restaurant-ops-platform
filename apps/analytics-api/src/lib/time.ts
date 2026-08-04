import { DateTime } from "luxon";
import type { LocalTimeParts } from "../types.js";

export function parseCloverTimestamp(value: unknown): Date | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value;
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    const milliseconds = Math.abs(value) < 100_000_000_000 ? value * 1000 : value;
    const date = new Date(milliseconds);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  if (typeof value === "string" && value.trim().length > 0) {
    const asNumber = Number(value);
    if (Number.isFinite(asNumber)) {
      return parseCloverTimestamp(asNumber);
    }
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  return null;
}

export function toLocalParts(date: Date | null, timezone: string): LocalTimeParts {
  const local = DateTime.fromJSDate(date ?? new Date(0), { zone: "utc" }).setZone(timezone);
  return {
    businessDate: local.toISODate() ?? "1970-01-01",
    localHour: local.hour,
    weekday: local.weekday,
    yearMonth: local.toFormat("yyyy-MM"),
    isoWeek: local.weekNumber
  };
}

export function toIso(date: Date): string {
  return date.toISOString();
}

export function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

export function maxDate(left: Date, right: Date): Date {
  return left.getTime() >= right.getTime() ? left : right;
}

export function minDate(left: Date, right: Date): Date {
  return left.getTime() <= right.getTime() ? left : right;
}

