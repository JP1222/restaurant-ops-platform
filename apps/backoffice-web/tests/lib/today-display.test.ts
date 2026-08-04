import { DateTime } from "luxon";
import { describe, expect, test } from "vitest";
import type { TodayOpen } from "@rop/contracts";
import { recapLabel, recapSubtitle } from "@/lib/analytics-api/today-display";
import type { TodayResponse } from "@/lib/analytics-api/today-shape";

const TZ = "America/Chicago";
const OPEN_10AM: TodayOpen = { hour: 10, minute: 0, time: "10:00", label: "10:00 AM" };

function recap(
  business_date: string,
  current_business_date: string,
  today_open: TodayOpen | null = OPEN_10AM,
): TodayResponse {
  const kpi = {
    value: 0,
    unit: "cents" as const,
    baseline: null,
    wow_pct: null,
    baseline_sample_size: 0,
  };
  return {
    mode: "recap",
    business_date,
    current_business_date,
    weekday: 1,
    is_current_day: false,
    store_timezone: TZ,
    today_open,
    kpis: { net_sales: kpi, orders: kpi, avg_ticket: kpi, refunds: kpi, refund_rate: kpi },
  };
}

describe("recapLabel", () => {
  test("a one-day gap is 'Yesterday' (secondary)", () => {
    expect(recapLabel(recap("2026-06-15", "2026-06-16"))).toEqual({
      badge: "Yesterday",
      badgeVariant: "secondary",
      stale: false,
    });
  });

  test("a multi-day gap is flagged stale (destructive)", () => {
    expect(recapLabel(recap("2026-06-13", "2026-06-16"))).toEqual({
      badge: "Stale data",
      badgeVariant: "destructive",
      stale: true,
    });
  });
});

describe("recapSubtitle", () => {
  test("before open: pre-open wording with the store's actual open time", () => {
    const now = DateTime.fromISO("2026-06-16T09:00:00", { zone: TZ });
    expect(recapSubtitle(recap("2026-06-15", "2026-06-16"), now)).toBe(
      "No sales recorded yet today (opens 10:00 AM) — showing Mon, Jun 15",
    );
  });

  test("uses the real per-weekday open time (noon Sunday, not 10am)", () => {
    const now = DateTime.fromISO("2026-06-14T11:00:00", { zone: TZ }); // Sunday 11am
    const noon: TodayOpen = { hour: 12, minute: 0, time: "12:00", label: "12:00 PM" };
    expect(recapSubtitle(recap("2026-06-13", "2026-06-14", noon), now)).toBe(
      "No sales recorded yet today (opens 12:00 PM) — showing Sat, Jun 13",
    );
  });

  test("respects the open minute (10:15 is still before a 10:30 open)", () => {
    const now = DateTime.fromISO("2026-06-16T10:15:00", { zone: TZ });
    const open1030: TodayOpen = { hour: 10, minute: 30, time: "10:30", label: "10:30 AM" };
    expect(recapSubtitle(recap("2026-06-15", "2026-06-16", open1030), now)).toBe(
      "No sales recorded yet today (opens 10:30 AM) — showing Mon, Jun 15",
    );
  });

  test("after open: does NOT claim 'no sales' (could be ingest lag during service)", () => {
    const now = DateTime.fromISO("2026-06-16T14:00:00", { zone: TZ });
    expect(recapSubtitle(recap("2026-06-15", "2026-06-16"), now)).toBe(
      "Today's data hasn't loaded yet — showing Mon, Jun 15",
    );
  });

  test("closed today: says so", () => {
    const now = DateTime.fromISO("2026-06-16T09:00:00", { zone: TZ });
    expect(recapSubtitle(recap("2026-06-15", "2026-06-16", null), now)).toBe(
      "Closed today — showing Mon, Jun 15",
    );
  });

  test("multi-day gap: surfaces a staleness warning regardless of time of day", () => {
    const now = DateTime.fromISO("2026-06-16T09:00:00", { zone: TZ });
    expect(recapSubtitle(recap("2026-06-13", "2026-06-16"), now)).toBe(
      "Latest data is from Sat, Jun 13 — analytics may be behind",
    );
  });
});
