import client from "prom-client";

// Domain gauges for the daily raw-vs-mart reconciliation (reconcileWindow in
// src/jobs/reconciliation-check.ts). Registered on prom-client's DEFAULT
// registry — the same `client.register` that src/http/metrics.ts serves at GET
// /metrics — so they surface alongside the process + backfill gauges with no
// extra route. Populated out-of-band by ReconMetricsUpdater on a timer, never
// inside the scrape handler (which must stay fast + DB-free).
//
// WHY this module exists: reconciliation writes audit.reconciliation_results on
// every export reconcile, but until now nothing READ that table — a failed day
// was operationally invisible (no gauge, no panel, no alert). These gauges close
// that blind spot. Every series is labelled by `merchant_id` only (ADR-0018
// multi-location); NEVER by business_date — a per-day label would blow up the
// Prometheus TSDB across thousands of historical days.
const register = client.register;

const LABELS = ["merchant_id"] as const;
type ReconGauge = client.Gauge<"merchant_id">;

export interface ReconGauges {
  unresolvedBreakDays: ReconGauge;
  oldestUnresolvedBreakDay: ReconGauge;
  lastRunTimestamp: ReconGauge;
}

// One reconciliation_results row is written per (merchant, business_date) per
// reconcile run — INSERT-only, status 'passed' | 'failed', no resolved_at. So
// "the latest row per business_date" IS the current truth, and a day is an
// unresolved break when its newest row is 'failed'. The updater computes this
// summary; the gauge module stays DB-free.
export interface ReconSummaryForGauges {
  // Count of business_dates whose most-recent reconcile is 'failed'.
  unresolvedBreakDays: number;
  // The oldest such business_date as 'YYYY-MM-DD', or null when there are none.
  oldestUnresolvedBreakDay: string | null;
  // MAX(created_at) across this merchant's reconciliation_results, as an ISO
  // string — the meta-freshness clock. null when the checker has never run, so a
  // silently-dead checker is itself detectable (ReconCheckerStalled).
  lastRunAt: string | null;
}

let cached: ReconGauges | null = null;

// prom-client throws if a metric name is registered twice (tsx watch reloads,
// repeated imports), so reuse an already-registered instance. Mirrors the guard
// in backfill-gauges.ts / src/http/metrics.ts.
function gauge(name: string, help: string): ReconGauge {
  return (
    (register.getSingleMetric(name) as ReconGauge | undefined) ??
    new client.Gauge({ name, help, labelNames: LABELS, registers: [register] })
  );
}

export function ensureReconGauges(): ReconGauges {
  if (cached) {
    return cached;
  }
  cached = {
    unresolvedBreakDays: gauge(
      "rop_recon_unresolved_break_days",
      "Business dates whose most-recent raw-vs-mart reconciliation is 'failed' (an unresolved data-integrity break).",
    ),
    oldestUnresolvedBreakDay: gauge(
      "rop_recon_oldest_unresolved_break_day",
      "Unix timestamp (UTC midnight) of the oldest business date with an unresolved reconciliation break. Absent when there are none.",
    ),
    lastRunTimestamp: gauge(
      "rop_recon_last_run_timestamp",
      "Unix timestamp of the most recent reconciliation_results row for the merchant (meta-freshness: a stalled value means the reconciler stopped running). Absent when it has never run.",
    ),
  };
  return cached;
}

/**
 * Epoch SECONDS for an ISO date/timestamp string, or null when the input is
 * absent or unparseable (so the series is left absent rather than set to a
 * fabricated 0 that an alert could misread). Mirrors the null-discipline in
 * secondsSinceLastProgress (backfill-gauges.ts).
 */
export function epochSecondsOrNull(iso: string | null): number | null {
  if (!iso) {
    return null;
  }
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms / 1000;
}

function setOrRemove(g: ReconGauge, labels: { merchant_id: string }, value: number | null): void {
  if (value === null) {
    g.remove(labels);
  } else {
    g.set(labels, value);
  }
}

/** Set every gauge for one merchant from its reconciliation summary. */
export function recordReconSummary(
  merchantId: string,
  summary: ReconSummaryForGauges,
): void {
  const gauges = ensureReconGauges();
  const labels = { merchant_id: merchantId };

  gauges.unresolvedBreakDays.set(labels, Math.max(0, summary.unresolvedBreakDays));
  setOrRemove(
    gauges.oldestUnresolvedBreakDay,
    labels,
    epochSecondsOrNull(summary.oldestUnresolvedBreakDay),
  );
  setOrRemove(gauges.lastRunTimestamp, labels, epochSecondsOrNull(summary.lastRunAt));
}

/**
 * Clear every per-merchant series. The updater calls this at the start of each
 * cycle so a sync target that goes inactive stops reporting a frozen value.
 */
export function resetReconGauges(): void {
  const gauges = ensureReconGauges();
  for (const g of Object.values(gauges)) {
    g.reset();
  }
}
