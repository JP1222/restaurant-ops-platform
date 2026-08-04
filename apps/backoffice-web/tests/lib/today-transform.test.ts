import { describe, expect, test } from "vitest";
import { transformToToday } from "@/lib/analytics-api/today-transform";
import type { DailySalesRow } from "@/lib/analytics-api/types";

function row(
  business_date: string,
  net_sales_cents: number,
  order_count: number,
  refund_total_cents = 0,
): DailySalesRow {
  const payment_total_cents = net_sales_cents + refund_total_cents;
  return {
    business_date,
    net_sales_cents,
    payment_total_cents,
    refund_total_cents,
    order_count,
    tax_total_cents: 0,
    tip_total_cents: 0,
    discount_total_cents: 0,
    // Mirror the registry-resolved fields salesSummary now ships (ADR-0030):
    // avg_ticket = net / orders; refund_rate = refund / payment_total. null when
    // the denominator is 0, matching resolveMetric's nullif guard.
    avg_ticket_cents: order_count > 0 ? net_sales_cents / order_count : null,
    refund_rate: payment_total_cents > 0 ? refund_total_cents / payment_total_cents : null,
  };
}

describe("transformToToday", () => {
  test("returns null for empty input", () => {
    expect(transformToToday([])).toBeNull();
  });

  test("recaps the latest closed day when today has no row", () => {
    const result = transformToToday([row("2026-05-05", 100_000, 10)], {
      currentBusinessDate: "2026-05-06",
    });

    expect(result).not.toBeNull();
    expect(result!.mode).toBe("recap");
    expect(result!.business_date).toBe("2026-05-05");
    expect(result!.current_business_date).toBe("2026-05-06");
    expect(result!.is_current_day).toBe(false);
    expect(result!.kpis.net_sales.value).toBe(100_000);
    expect(result!.kpis.net_sales.baseline).toBeNull();
    expect(result!.kpis.net_sales.wow_pct).toBeNull();
    expect(result!.kpis.net_sales.baseline_sample_size).toBe(0);
  });

  test("recap mode computes net-sales baseline from 4 same-weekday observations", () => {
    const rows: DailySalesRow[] = [
      row("2026-05-05", 100_000, 10),
      row("2026-05-04", 200_000, 20),
      row("2026-04-28", 80_000, 8),
      row("2026-04-21", 90_000, 9),
      row("2026-04-14", 110_000, 11),
      row("2026-04-07", 120_000, 12),
    ];

    // currentBusinessDate has no row -> recap of the latest closed day (2026-05-05,
    // a Tuesday); a complete day is compared apples-to-apples against prior Tuesdays.
    const result = transformToToday(rows, { currentBusinessDate: "2026-05-06" });

    expect(result).not.toBeNull();
    expect(result!.mode).toBe("recap");
    expect(result!.business_date).toBe("2026-05-05");
    expect(result!.is_current_day).toBe(false);
    expect(result!.kpis.net_sales.baseline).toBe(100_000);
    expect(result!.kpis.net_sales.wow_pct).toBe(0);
    expect(result!.kpis.net_sales.baseline_sample_size).toBe(4);
  });

  test("live mode suppresses every same-weekday comparison (partial day)", () => {
    const rows: DailySalesRow[] = [
      row("2026-05-05", 100_000, 10),
      row("2026-04-28", 80_000, 8),
      row("2026-04-21", 90_000, 9),
      row("2026-04-14", 110_000, 11),
    ];

    // Today's row exists -> live (partial) day. Comparing in-progress values
    // against full prior days is apples-to-oranges, so all KPIs drop wow_pct;
    // the pacing indicator carries the intraday signal instead.
    const result = transformToToday(rows, { currentBusinessDate: "2026-05-05" });

    expect(result!.mode).toBe("live");
    expect(result!.is_current_day).toBe(true);
    expect(result!.kpis.net_sales.value).toBe(100_000);
    expect(result!.kpis.net_sales.wow_pct).toBeNull();
    expect(result!.kpis.orders.wow_pct).toBeNull();
    expect(result!.kpis.avg_ticket.wow_pct).toBeNull();
    expect(result!.kpis.refund_rate.wow_pct).toBeNull();
  });

  test("recap avg ticket uses each day's own ratio, not aggregate history ratio", () => {
    const rows: DailySalesRow[] = [
      row("2026-05-05", 100_000, 10),
      row("2026-04-28", 100_000, 5),
      row("2026-04-21", 100_000, 20),
    ];

    // recap (currentBusinessDate has no row) so the complete-day comparison runs.
    const result = transformToToday(rows, { currentBusinessDate: "2026-05-06" });

    expect(result!.mode).toBe("recap");
    expect(result!.kpis.avg_ticket.value).toBe(10_000);
    expect(result!.kpis.avg_ticket.baseline).toBe(12_500);
    expect(result!.kpis.avg_ticket.wow_pct).toBe(-20);
  });

  test("recap handles zero denominators without division by zero", () => {
    // No payments and no orders on any day -> avg_ticket (÷0 orders) and
    // refund_rate (÷0 payment_total) both resolve to null and surface as 0,
    // never a division by zero (registry nullif guard, mirrored in the row helper).
    const result = transformToToday(
      [row("2026-05-05", 0, 0, 0), row("2026-04-28", 0, 0, 0), row("2026-04-21", 0, 0, 0)],
      { currentBusinessDate: "2026-05-06" },
    );

    expect(result!.kpis.avg_ticket.value).toBe(0);
    expect(result!.kpis.avg_ticket.baseline).toBe(0);
    expect(result!.kpis.avg_ticket.wow_pct).toBeNull();
    expect(result!.kpis.refund_rate.value).toBe(0);
    expect(result!.kpis.refund_rate.baseline).toBe(0);
    expect(result!.kpis.refund_rate.wow_pct).toBeNull();
  });

  test("a fully-refunded day reads as refund_rate 1.0 under the payment_total 口径", () => {
    // payment_total = net + refund, so a day with net 0 but a refund means
    // everything paid was refunded -> refund / payment_total = 1.0 (100%). The
    // legacy ÷net_sales 口径 wrongly reported 0% here (net was 0), hiding the
    // fully-refunded day — the correction this migration lands.
    const rows: DailySalesRow[] = [
      row("2026-05-05", 50_000, 5, 0), // display (Tue, recap)
      row("2026-04-28", 0, 0, 1_000), // prior Tue, fully refunded -> 1.0
      row("2026-04-21", 0, 0, 2_000), // prior Tue, fully refunded -> 1.0
    ];

    const result = transformToToday(rows, { currentBusinessDate: "2026-05-06" });

    expect(result!.kpis.refund_rate.baseline).toBe(1);
  });

  test("recap computes refund rate baseline over payment_total (registry 口径)", () => {
    const rows: DailySalesRow[] = [
      row("2026-05-05", 100_000, 10, 5_000),
      row("2026-04-28", 200_000, 20, 20_000),
      row("2026-04-21", 100_000, 10, 20_000),
    ];

    const result = transformToToday(rows, { currentBusinessDate: "2026-05-06" });

    expect(result!.kpis.refunds.value).toBe(5_000);
    // refund_rate = refund / payment_total (ADR-0030 registry 口径), NOT refund / net_sales.
    // display: 5_000 / 105_000 = 0.047619 (the legacy ÷net value was 0.05).
    expect(result!.kpis.refund_rate.value).toBeCloseTo(0.047619, 5);
    // baseline = mean(20_000/220_000, 20_000/120_000) = mean(0.090909, 0.166667) = 0.128788.
    expect(result!.kpis.refund_rate.baseline).toBeCloseTo(0.128788, 5);
    expect(result!.kpis.refund_rate.wow_pct).toBeCloseTo(-63.0252, 3);
  });

  test("passes through store timezone and today's open time", () => {
    const result = transformToToday([row("2026-05-05", 100_000, 10)], {
      currentBusinessDate: "2026-05-06",
      storeTimeZone: "America/New_York",
      todayOpen: { hour: 12, minute: 0, time: "12:00", label: "12:00 PM" },
    });

    expect(result!.store_timezone).toBe("America/New_York");
    expect(result!.today_open).toEqual({ hour: 12, minute: 0, time: "12:00", label: "12:00 PM" });
  });

  test("ignores a future-dated row when picking the recap day", () => {
    const rows: DailySalesRow[] = [
      row("2026-05-20", 999_000, 99), // bad/future row (after current)
      row("2026-05-05", 100_000, 10),
    ];

    const result = transformToToday(rows, { currentBusinessDate: "2026-05-06" });

    expect(result!.mode).toBe("recap");
    expect(result!.business_date).toBe("2026-05-05");
    expect(result!.kpis.net_sales.value).toBe(100_000);
  });

  test("weekday is computed in store TZ with Sun=0 through Sat=6", () => {
    const tue = transformToToday([row("2026-05-05", 100, 1)]);
    expect(tue!.weekday).toBe(2);

    const sun = transformToToday([row("2026-05-03", 100, 1)]);
    expect(sun!.weekday).toBe(0);

    const sat = transformToToday([row("2026-05-09", 100, 1)]);
    expect(sat!.weekday).toBe(6);
  });
});
