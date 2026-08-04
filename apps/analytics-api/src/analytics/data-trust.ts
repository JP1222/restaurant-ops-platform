import { DateTime } from "luxon";

import type { DbPool } from "../db.js";

/**
 * Data-trust verdict — "can the operator trust the numbers for this day?".
 *
 * The reconcile job (jobs/reconciliation-check.ts) and the DQ checks
 * (quality/checks.ts) already compute everything we need; they're just never
 * surfaced to the OWNER (only to /ops + Prometheus). This composes their state
 * into a per-day verdict the AI copilot can cite, so an "why were sales low"
 * answer can carry an honest caveat when that day's data is under repair.
 *
 * The hard part is the reconcile LAG, not the data. Reconciliation runs ~5min
 * after the daily export window, over a rolling 7-day window, so the current and
 * most-recent day are NORMALLY un-reconciled — that is settling, not a fault.
 * `classifyDay` encodes that: a missing reconcile row is only "pending" for the
 * latest day and the one before it; older missing rows are "no_data" (unverified
 * / aged out), and only an actual `failed` row is a real break. We never cry wolf
 * on the settling window.
 */

export type DayTrustStatus = "reconciled" | "failed" | "pending" | "no_data";
export type OverallTrust = "ok" | "caution" | "degraded";

export interface DayTrust {
  business_date: string;
  status: DayTrustStatus;
}

export interface DataQualitySummary {
  unresolved_failures: number;
  critical_failures: number;
  checks: { check_name: string; severity: string; created_at: string | null }[];
}

export interface DataTrustResult {
  /** The day evaluated: the requested date, else the latest day with sales. "" when no data exists. */
  as_of: string;
  /** Overall rating for the recent window. `pending`/settling days never push this off `ok`. */
  overall: OverallTrust;
  /** The verdict for `as_of` specifically — the headline the caller asked about. */
  asked_day: DayTrust;
  /** Newest-first verdicts for the lookback window ending on `as_of`. */
  recent_days: DayTrust[];
  reconciliation: {
    unresolved_break_days: number;
    oldest_unresolved_break_day: string | null;
  };
  data_quality: DataQualitySummary;
  freshness: {
    last_hourly_sweep_at: string | null;
    last_export_reconcile_at: string | null;
  };
  /** false only when `as_of`'s own data failed reconciliation (under repair) — hedge answers about it. */
  sufficient: boolean;
  /** Ready-to-surface English caveat for `as_of`; null when nothing to warn about. The model translates. */
  caveat: string | null;
}

const DEFAULT_LOOKBACK_DAYS = 7;

/** Pure: D minus N days, in ISO yyyy-MM-dd (UTC date math — business_date is a calendar date). */
export function isoMinusDays(date: string, days: number): string {
  return DateTime.fromISO(date, { zone: "utc" }).minus({ days }).toFormat("yyyy-MM-dd");
}

/**
 * Pure: classify one day. A `failed`/`passed` reconcile row is authoritative. A
 * MISSING row is only "pending" (normal settling) for the latest day and the one
 * before it — relative to the latest day WITH DATA, not the asked date, so an
 * explicitly-asked old day with no record reads as "no_data" (unverified), never
 * a falsely reassuring "still settling".
 */
export function classifyDay(
  businessDate: string,
  latestDay: string,
  reconStatus: "passed" | "failed" | undefined,
): DayTrustStatus {
  if (reconStatus === "failed") return "failed";
  if (reconStatus === "passed") return "reconciled";
  const yesterday = isoMinusDays(latestDay, 1);
  if (businessDate === latestDay || businessDate === yesterday) return "pending";
  return "no_data";
}

/**
 * Pure: an overall rating from the unresolved counts. Only genuine breaks move it:
 * a failed reconcile day or a critical DQ failure is `degraded`; a warning-level DQ
 * failure is `caution`; otherwise `ok`. Settling (`pending`) days contribute nothing
 * here — they aren't in these counts.
 */
export function summarizeOverall(
  unresolvedBreakDays: number,
  criticalDqFailures: number,
  warningDqFailures: number,
): OverallTrust {
  if (unresolvedBreakDays > 0 || criticalDqFailures > 0) return "degraded";
  if (warningDqFailures > 0) return "caution";
  return "ok";
}

/** Pure: the English caveat for the asked day's status (null when reconciled/clean). */
export function buildCaveat(askedDay: DayTrust): string | null {
  switch (askedDay.status) {
    case "failed":
      return `Reconciliation for ${askedDay.business_date} FAILED: the raw POS records and the analytics totals disagree and an automatic repair is queued. Figures for this day may be incomplete — surface this caveat before drawing conclusions about it.`;
    case "pending":
      return `${askedDay.business_date} has not finished reconciling yet — its data is still settling, which is normal for the current/most-recent day. Exact figures may shift slightly later; mention this if the user leans on precise numbers.`;
    case "no_data":
      return `No reconciliation record exists for ${askedDay.business_date}, so its data integrity is unverified. Treat exact figures with mild caution.`;
    case "reconciled":
      return null;
  }
}

/**
 * Pure: assemble the full verdict from already-fetched primitives. Kept free of
 * the pool so the whole classification/caveat/overall logic is unit-testable with
 * hand-built inputs (no Postgres).
 */
export function assembleTrust(input: {
  latestDay: string;
  asOf: string;
  lookbackDays: number;
  reconStatusByDate: Map<string, "passed" | "failed">;
  unresolvedBreakDaysAsc: string[];
  dqChecks: { check_name: string; severity: string; created_at: string | null }[];
  freshness: { last_hourly_sweep_at: string | null; last_export_reconcile_at: string | null };
}): DataTrustResult {
  const recentDays: DayTrust[] = [];
  for (let i = 0; i < input.lookbackDays; i++) {
    const d = isoMinusDays(input.asOf, i);
    recentDays.push({ business_date: d, status: classifyDay(d, input.latestDay, input.reconStatusByDate.get(d)) });
  }
  const askedDay = recentDays[0]!; // i=0 is as_of

  const criticalDq = input.dqChecks.filter((c) => c.severity === "critical").length;
  const warningDq = input.dqChecks.filter((c) => c.severity === "warning").length;

  return {
    as_of: input.asOf,
    overall: summarizeOverall(input.unresolvedBreakDaysAsc.length, criticalDq, warningDq),
    asked_day: askedDay,
    recent_days: recentDays,
    reconciliation: {
      unresolved_break_days: input.unresolvedBreakDaysAsc.length,
      oldest_unresolved_break_day: input.unresolvedBreakDaysAsc[0] ?? null,
    },
    data_quality: {
      unresolved_failures: input.dqChecks.length,
      critical_failures: criticalDq,
      checks: input.dqChecks,
    },
    freshness: input.freshness,
    sufficient: askedDay.status !== "failed",
    caveat: buildCaveat(askedDay),
  };
}

function emptyTrust(): DataTrustResult {
  return {
    as_of: "",
    overall: "ok",
    asked_day: { business_date: "", status: "no_data" },
    recent_days: [],
    reconciliation: { unresolved_break_days: 0, oldest_unresolved_break_day: null },
    data_quality: { unresolved_failures: 0, critical_failures: 0, checks: [] },
    freshness: { last_hourly_sweep_at: null, last_export_reconcile_at: null },
    sufficient: true,
    caveat: null,
  };
}

function toIso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export async function computeDataTrust(
  pool: DbPool,
  opts: { merchantId: string; date?: string; lookbackDays?: number },
): Promise<DataTrustResult> {
  const lookbackDays = opts.lookbackDays ?? DEFAULT_LOOKBACK_DAYS;

  // Anchor on the latest day WITH DATA (mirrors metric-drivers), so the
  // settling-window exemption tracks real data, not wall-clock.
  const latest = await pool.query<{ d: string | null }>(
    `SELECT max(business_date)::text AS d FROM mart.sales_daily_mv WHERE merchant_id = $1`,
    [opts.merchantId],
  );
  const latestDay = latest.rows[0]?.d ?? null;
  if (!latestDay) return emptyTrust();

  const asOf = opts.date ?? latestDay;
  const windowStart = isoMinusDays(asOf, lookbackDays - 1);

  const [reconWindow, reconBreaks, dq, health] = await Promise.all([
    // Latest reconcile status per business_date in the window.
    pool.query<{ business_date: string; status: string }>(
      `WITH latest AS (
         SELECT DISTINCT ON (business_date) business_date, status
         FROM audit.reconciliation_results
         WHERE merchant_id = $1 AND business_date BETWEEN $2::date AND $3::date
         ORDER BY business_date, created_at DESC
       )
       SELECT to_char(business_date, 'YYYY-MM-DD') AS business_date, status FROM latest`,
      [opts.merchantId, windowStart, asOf],
    ),
    // All currently-unresolved breaks (latest row per date is failed), oldest first.
    pool.query<{ business_date: string }>(
      `WITH latest AS (
         SELECT DISTINCT ON (business_date) business_date, status
         FROM audit.reconciliation_results
         WHERE merchant_id = $1
         ORDER BY business_date, created_at DESC
       )
       SELECT to_char(business_date, 'YYYY-MM-DD') AS business_date
       FROM latest WHERE status = 'failed' ORDER BY business_date ASC`,
      [opts.merchantId],
    ),
    // Unresolved data-quality failures (mirrors the ops overview's status<>'passed').
    pool.query<{ check_name: string; severity: string | null; created_at: Date | null }>(
      `SELECT check_name, severity, created_at
       FROM audit.data_quality_checks
       WHERE merchant_id = $1 AND status <> 'passed'
       ORDER BY created_at DESC
       LIMIT 20`,
      [opts.merchantId],
    ),
    pool.query<{ last_hourly_sweep_at: Date | null; last_export_reconcile_at: Date | null }>(
      `SELECT last_hourly_sweep_at, last_export_reconcile_at
       FROM audit.sync_health WHERE merchant_id = $1`,
      [opts.merchantId],
    ),
  ]);

  const reconStatusByDate = new Map<string, "passed" | "failed">();
  for (const row of reconWindow.rows) {
    if (row.status === "passed" || row.status === "failed") {
      reconStatusByDate.set(row.business_date, row.status);
    }
  }

  return assembleTrust({
    latestDay,
    asOf,
    lookbackDays,
    reconStatusByDate,
    unresolvedBreakDaysAsc: reconBreaks.rows.map((r) => r.business_date),
    dqChecks: dq.rows.map((r) => ({
      check_name: r.check_name,
      severity: r.severity ?? "unknown",
      created_at: toIso(r.created_at),
    })),
    freshness: {
      last_hourly_sweep_at: toIso(health.rows[0]?.last_hourly_sweep_at),
      last_export_reconcile_at: toIso(health.rows[0]?.last_export_reconcile_at),
    },
  });
}
