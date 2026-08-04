/**
 * KPI shape returned by GET /api/today.
 *
 * The view anchors on the real store-current business date:
 *  - mode "live"   — today's row exists in the mart; KPIs are the day's running
 *                    total. Every KPI suppresses its same-weekday comparison
 *                    because comparing a partial day against full prior days is
 *                    apples-to-oranges — the hourly pulse / pacing indicator
 *                    carries the (elapsed-time-normalized) intraday signal.
 *  - mode "recap"  — today has no data yet (pre-open or no orders); we show the
 *                    most recent CLOSED day, explicitly labeled, with full
 *                    same-weekday comparisons (complete-vs-complete, valid).
 *
 * Comparison baseline = average of the same weekday over the previous 4 weeks.
 * If fewer than 2 same-weekday observations exist in the 30-day window,
 * baseline is null and wow_pct is null.
 */
import type { TodayOpen } from "@rop/contracts";

export type TodayMode = "live" | "recap";

export interface KpiNumeric {
  /** Currency or count value as raw number (cents for money, integer for counts). */
  value: number;
  /** Display unit so the UI knows how to format. */
  unit: "cents" | "count" | "rate";
  /** 4-week same-weekday avg, same units. null if insufficient history. */
  baseline: number | null;
  /** Percentage delta vs baseline. Positive means the raw metric is higher. */
  wow_pct: number | null;
  /** Number of same-weekday observations contributing to baseline (0-4). */
  baseline_sample_size: number;
}

export interface TodayResponse {
  /** "live" = business_date is the real store-today; "recap" = a fallback to the latest closed day. */
  mode: TodayMode;
  /** business_date (YYYY-MM-DD) of the day whose KPIs are shown. */
  business_date: string;
  /** The real store-current business date (YYYY-MM-DD), regardless of mode. */
  current_business_date: string;
  /** 0=Sun ... 6=Sat, derived from business_date. */
  weekday: number;
  /** True when mode === "live" (business_date is the real store-current day). */
  is_current_day: boolean;
  /** The store's IANA timezone (from its Location), e.g. "America/Chicago". */
  store_timezone: string;
  /**
   * When the store opens on the real current weekday (store-local), or null when
   * closed today. Drives the recap subtitle's "opens 10:00 AM" vs "12:00 PM"
   * (Sunday) framing. null in live mode (irrelevant once today has data).
   */
  today_open: TodayOpen | null;
  kpis: {
    net_sales: KpiNumeric;
    orders: KpiNumeric;
    avg_ticket: KpiNumeric;
    refunds: KpiNumeric;
    /** Refund rate (0..1) = refund_total / net_sales. */
    refund_rate: KpiNumeric;
  };
}
