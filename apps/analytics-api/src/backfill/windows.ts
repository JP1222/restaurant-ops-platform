import type { TimeWindow } from "../types.js";
import { addDays, maxDate, minDate } from "../lib/time.js";

export function sampleWindow(days: number, now = new Date()): TimeWindow[] {
  return [{
    start: addDays(now, -days),
    end: now
  }];
}

export function fullBackfillWindows(start: Date, end = new Date(), windowDays = 30): TimeWindow[] {
  const windows: TimeWindow[] = [];
  let cursor = new Date(start);
  while (cursor.getTime() < end.getTime()) {
    const next = minDate(addDays(cursor, windowDays), end);
    windows.push({
      start: maxDate(cursor, start),
      end: next
    });
    cursor = next;
  }
  return windows;
}

