import { DateTime } from "luxon";
import { describe, expect, test } from "vitest";
import { transformToHourlyPulse } from "@/lib/analytics-api/hourly-transform";
import type { HourlyRow } from "@/lib/analytics-api/types";

const TZ = "America/Chicago";

function row(
  business_date: string,
  hour: number,
  net_sales_cents: number,
  order_count = 1,
): HourlyRow {
  return {
    business_date,
    hour,
    net_sales_cents,
    order_count,
    payment_total_cents: net_sales_cents,
  };
}

describe("transformToHourlyPulse", () => {
  test("returns null for empty input", () => {
    const now = DateTime.fromISO("2026-05-05T10:00:00", { zone: TZ });
    expect(transformToHourlyPulse([], now)).toBeNull();
  });

  test("produces 24 points and identifies today plus weekday", () => {
    const now = DateTime.fromISO("2026-05-05T10:00:00", { zone: TZ });
    const rows: HourlyRow[] = Array.from({ length: 24 }, (_, hour) =>
      row("2026-05-05", hour, 1000),
    );

    const result = transformToHourlyPulse(rows, now);

    expect(result).not.toBeNull();
    expect(result!.points).toHaveLength(24);
    expect(result!.business_date).toBe("2026-05-05");
    expect(result!.weekday).toBe(2);
    expect(result!.is_current_day).toBe(true);
  });

  test("future hours are null when the latest business date is current", () => {
    const now = DateTime.fromISO("2026-05-05T10:00:00", { zone: TZ });
    const rows: HourlyRow[] = Array.from({ length: 11 }, (_, hour) =>
      row("2026-05-05", hour, 1000),
    );

    const result = transformToHourlyPulse(rows, now);

    expect(result!.points[10]!.today_cumulative).toBe(11_000);
    expect(result!.points[11]!.today_cumulative).toBeNull();
    expect(result!.points[23]!.today_cumulative).toBeNull();
  });

  test("computes baseline mean and population sigma from same-weekday history", () => {
    const now = DateTime.fromISO("2026-05-05T10:00:00", { zone: TZ });
    const rows: HourlyRow[] = Array.from({ length: 11 }, (_, hour) =>
      row("2026-05-05", hour, 1000),
    );

    for (const date of ["2026-04-28", "2026-04-21"]) {
      for (let hour = 0; hour < 24; hour += 1) {
        rows.push(row(date, hour, date === "2026-04-28" ? 1000 : 3000));
      }
    }

    const result = transformToHourlyPulse(rows, now);

    expect(result!.points[23]!.baseline_mean).toBe(48_000);
    expect(result!.points[23]!.baseline_stddev).toBe(24_000);
    expect(result!.points[23]!.baseline_lower).toBe(24_000);
    expect(result!.points[23]!.baseline_upper).toBe(72_000);
    expect(result!.points[23]!.baseline_sample_size).toBe(2);
  });

  test("pacing is null when latest business date is not current", () => {
    const now = DateTime.fromISO("2026-05-06T10:00:00", { zone: TZ });
    const rows: HourlyRow[] = Array.from({ length: 24 }, (_, hour) =>
      row("2026-05-05", hour, 1000),
    );

    const result = transformToHourlyPulse(rows, now);

    expect(result!.is_current_day).toBe(false);
    expect(result!.pacing).toBeNull();
  });

  test("pacing computes progress relative to baseline full day", () => {
    const now = DateTime.fromISO("2026-05-05T10:00:00", { zone: TZ });
    const rows: HourlyRow[] = Array.from({ length: 11 }, (_, hour) =>
      row("2026-05-05", hour, 1000),
    );

    for (const date of ["2026-04-28", "2026-04-21"]) {
      for (let hour = 0; hour < 24; hour += 1) {
        rows.push(row(date, hour, 2000));
      }
    }

    const result = transformToHourlyPulse(rows, now);

    expect(result!.pacing!.today_cumulative).toBe(11_000);
    expect(result!.pacing!.baseline_full_day).toBe(48_000);
    expect(result!.pacing!.progress_pct).toBeCloseTo(22.92, 1);
    expect(result!.pacing!.hours_remaining).toBe(13);
    expect(result!.pacing!.current_hour).toBe(10);
  });

  test("buckets the current hour in the passed store zone, not a hardcoded America/Chicago", () => {
    // 15:00 in New York is 14:00 in Chicago. The transform must honor the zone the
    // caller set on `now` (the per-store timezone), not re-zone to a hardcoded one.
    const nowNy = DateTime.fromISO("2026-05-05T15:00:00", { zone: "America/New_York" });
    const rows: HourlyRow[] = Array.from({ length: 16 }, (_, hour) => row("2026-05-05", hour, 1000));

    const result = transformToHourlyPulse(rows, nowNy);

    expect(result!.is_current_day).toBe(true);
    expect(result!.pacing!.current_hour).toBe(15); // NY hour, not 14 (Chicago)
    expect(result!.points[15]!.today_cumulative).toBe(16_000);
  });

  test("a store past midnight in its own zone reads as current even when Chicago is on the prior day", () => {
    // 00:30 in New York = 23:30 the PREVIOUS day in Chicago. With the NY business
    // date, the store's day must read as current; the old hardcoded re-zone to
    // Chicago saw the prior date -> is_current_day false, pacing null.
    const nowNy = DateTime.fromISO("2026-05-06T00:30:00", { zone: "America/New_York" });
    const rows: HourlyRow[] = [row("2026-05-06", 0, 1000)];

    const result = transformToHourlyPulse(rows, nowNy);

    expect(result!.business_date).toBe("2026-05-06");
    expect(result!.is_current_day).toBe(true);
    expect(result!.pacing!.current_hour).toBe(0);
  });
});
