import { DateTime } from "luxon";
import type { TodayResponse } from "./today-shape";

// Fallback only — the real per-store timezone rides on TodayResponse.store_timezone
// (sourced from the store's Location). Kept so a malformed/missing tz still renders.
export const STORE_TZ = "America/Chicago";

// A recap is treated as "stale" (likely closure / ingest outage) once the most
// recent day with data is this many days behind the real current day.
const STALE_GAP_DAYS = 2;

export function formatBusinessDate(businessDate: string, zone: string = STORE_TZ): string {
  return DateTime.fromISO(businessDate, { zone }).toFormat("ccc, LLL d");
}

function gapDays(today: TodayResponse): number {
  const zone = today.store_timezone || STORE_TZ;
  const display = DateTime.fromISO(today.business_date, { zone });
  const current = DateTime.fromISO(today.current_business_date, { zone });
  return Math.round(current.diff(display, "days").days);
}

export interface RecapLabel {
  badge: string;
  badgeVariant: "secondary" | "destructive";
  stale: boolean;
}

/** Badge shown alongside recap KPIs so the numbers are never read as "today". */
export function recapLabel(today: TodayResponse): RecapLabel {
  const gap = gapDays(today);
  if (gap >= STALE_GAP_DAYS) {
    return { badge: "Stale data", badgeVariant: "destructive", stale: true };
  }
  return {
    badge: gap === 1 ? "Yesterday" : "Latest closed day",
    badgeVariant: "secondary",
    stale: false,
  };
}

/**
 * Recap subtitle copy that tells the truth about WHY today is missing, using the
 * store's real per-weekday open time (TodayResponse.today_open):
 *  - a multi-day gap reads as a pipeline/closure problem, not a routine morning;
 *  - closed today says so;
 *  - before open it is genuinely pre-open (with the correct open time — e.g. a
 *    noon Sunday, not 10am);
 *  - after open the day's data simply hasn't loaded yet (ingest lag or no orders),
 *    so we must NOT assert "no sales recorded" while the store is actively selling.
 * `now` is injected so the copy is deterministic and unit-testable.
 */
export function recapSubtitle(today: TodayResponse, now: DateTime): string {
  const zone = today.store_timezone || STORE_TZ;
  const date = formatBusinessDate(today.business_date, zone);
  const gap = gapDays(today);

  if (gap >= STALE_GAP_DAYS) {
    return `Latest data is from ${date} — analytics may be behind`;
  }
  const open = today.today_open;
  if (!open) {
    return `Closed today — showing ${date}`;
  }
  const nowLocal = now.setZone(zone);
  const beforeOpen =
    nowLocal.hour < open.hour || (nowLocal.hour === open.hour && nowLocal.minute < open.minute);
  if (beforeOpen) {
    return `No sales recorded yet today (opens ${open.label}) — showing ${date}`;
  }
  return `Today's data hasn't loaded yet — showing ${date}`;
}
