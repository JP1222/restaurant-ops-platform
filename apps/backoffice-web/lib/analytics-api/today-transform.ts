import { DateTime } from "luxon";
import type { TodayOpen } from "@rop/contracts";
import type { DailySalesRow } from "./types";
import type { KpiNumeric, TodayMode, TodayResponse } from "./today-shape";

const STORE_TZ = "America/Chicago";

interface ComputeKpiInput {
  todayValue: number;
  sameWeekdayHistory: number[];
  unit: KpiNumeric["unit"];
  /**
   * Drop the same-weekday comparison even when history exists. Set for every KPI
   * on a live (partial) day, where comparing in-progress values against full
   * prior days would read as a misleading deficit; the pacing indicator carries
   * the elapsed-time-normalized intraday comparison instead.
   */
  suppressComparison?: boolean;
}

interface TransformToTodayOptions {
  /** YYYY-MM-DD in store time. Route handlers should pass the current store date. */
  currentBusinessDate?: string;
  storeTimeZone?: string;
  /** When the store opens on the real current weekday, or null if closed today. */
  todayOpen?: TodayOpen | null;
}

function toNumber(value: number | string | null | undefined): number {
  const parsed = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function weekdayForBusinessDate(businessDate: string, storeTimeZone: string): number {
  const dt = DateTime.fromISO(businessDate, { zone: storeTimeZone });
  return dt.weekday % 7;
}

function computeKpi({
  todayValue,
  sameWeekdayHistory,
  unit,
  suppressComparison = false,
}: ComputeKpiInput): KpiNumeric {
  const sample = sameWeekdayHistory.slice(0, 4);

  if (suppressComparison || sample.length < 2) {
    return {
      value: todayValue,
      unit,
      baseline: null,
      wow_pct: null,
      baseline_sample_size: sample.length,
    };
  }

  const baseline = sample.reduce((sum, value) => sum + value, 0) / sample.length;
  const wow_pct = baseline === 0 ? null : ((todayValue - baseline) / baseline) * 100;

  return {
    value: todayValue,
    unit,
    baseline,
    wow_pct,
    baseline_sample_size: sample.length,
  };
}

export function getCurrentBusinessDate(storeTimeZone = STORE_TZ): string {
  return DateTime.now().setZone(storeTimeZone).toFormat("yyyy-MM-dd");
}

/**
 * Transform the analytics-api 30-day sales response into the Today shape used
 * by the UI.
 *
 * "Today" is anchored on the real store-current business date (currentBusinessDate),
 * NOT on whichever row happens to be newest in the data. If today's row exists we
 * show it live; otherwise we fall back to the most recent CLOSED day as an
 * explicitly-labeled recap (mode: "recap") rather than mislabeling stale data as
 * "Today". When currentBusinessDate is omitted, the newest row is treated as the
 * current day to keep callers/tests that don't supply a clock deterministic.
 */
export function transformToToday(
  rows: DailySalesRow[],
  options: TransformToTodayOptions = {},
): TodayResponse | null {
  if (rows.length === 0) return null;

  const storeTimeZone = options.storeTimeZone ?? STORE_TZ;
  const sorted = [...rows].sort((a, b) =>
    a.business_date < b.business_date ? 1 : a.business_date > b.business_date ? -1 : 0,
  );

  const latest = sorted[0];
  if (!latest) return null;

  const currentBusinessDate = options.currentBusinessDate ?? latest.business_date;

  // Anchor on the real store-current day. Live when today's row is present;
  // otherwise recap the most recent day that is not in the future (guards against
  // a clock-skewed / bad future-dated mart row being shown as the "latest closed
  // day"). Recap covers pre-open / no orders yet / ingest lag.
  const todayRow = sorted.find((row) => row.business_date === currentBusinessDate);
  const recapRow = sorted.find((row) => row.business_date <= currentBusinessDate) ?? latest;
  const mode: TodayMode = todayRow ? "live" : "recap";
  const display = todayRow ?? recapRow;
  const isLive = mode === "live";

  const weekday = weekdayForBusinessDate(display.business_date, storeTimeZone);

  // Same-weekday baseline: prior days (excluding the displayed day) on its weekday.
  // For a complete recap day this is complete-vs-complete; for a live day the
  // accumulating metrics are partial, so their comparison is suppressed below.
  const sameWeekdayRows = sorted.filter(
    (row) =>
      row.business_date !== display.business_date &&
      weekdayForBusinessDate(row.business_date, storeTimeZone) === weekday,
  );

  return {
    mode,
    business_date: display.business_date,
    current_business_date: currentBusinessDate,
    weekday,
    is_current_day: isLive,
    store_timezone: storeTimeZone,
    today_open: options.todayOpen ?? null,
    kpis: {
      net_sales: computeKpi({
        todayValue: toNumber(display.net_sales_cents),
        sameWeekdayHistory: sameWeekdayRows.map((row) => toNumber(row.net_sales_cents)),
        unit: "cents",
        suppressComparison: isLive,
      }),
      orders: computeKpi({
        todayValue: toNumber(display.order_count),
        sameWeekdayHistory: sameWeekdayRows.map((row) => toNumber(row.order_count)),
        unit: "count",
        suppressComparison: isLive,
      }),
      // avg_ticket and refund_rate are resolved per business_date through the
      // governed metric registry (ADR-0030) by analytics-api salesSummary; read
      // them here instead of recomputing so pages + AI share ONE definition.
      // refund_rate is the registry 口径 (refund_total / payment_total), which
      // differs from the legacy refund_total / net_sales. toNumber maps a null
      // (no-orders / no-payment day) to 0, matching the prior guard.
      avg_ticket: computeKpi({
        todayValue: toNumber(display.avg_ticket_cents),
        sameWeekdayHistory: sameWeekdayRows.map((row) => toNumber(row.avg_ticket_cents)),
        unit: "cents",
        suppressComparison: isLive,
      }),
      refunds: computeKpi({
        todayValue: toNumber(display.refund_total_cents),
        sameWeekdayHistory: sameWeekdayRows.map((row) => toNumber(row.refund_total_cents)),
        unit: "cents",
        suppressComparison: isLive,
      }),
      refund_rate: computeKpi({
        todayValue: toNumber(display.refund_rate),
        sameWeekdayHistory: sameWeekdayRows.map((row) => toNumber(row.refund_rate)),
        unit: "rate",
        suppressComparison: isLive,
      }),
    },
  };
}
