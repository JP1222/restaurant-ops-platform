import client from "prom-client";

// Domain gauges for the historical-export backfill. Registered on prom-client's
// DEFAULT registry (the same `client.register` that src/http/metrics.ts serves
// at GET /metrics) so they surface alongside the process metrics with no extra
// route. They are populated out-of-band by BackfillMetricsUpdater on a timer —
// never inside the scrape handler, which must stay fast and DB-free so a slow
// query can't stall Prometheus (or, worse, time the whole scrape out).
//
// Every series is labelled by `merchant_id` because the scheduler runs the
// backfill per sync target (ADR-0018 multi-location); a fleet of stores each
// reports its own progress and stall state.
const register = client.register;

const LABELS = ["merchant_id"] as const;
type BackfillGauge = client.Gauge<"merchant_id">;

export interface BackfillGauges {
  expectedWindows: BackfillGauge;
  completedWindows: BackfillGauge;
  blockedWindows: BackfillGauge;
  failedWindows: BackfillGauge;
  remainingWindows: BackfillGauge;
  progressPct: BackfillGauge;
  secondsSinceLastCompleted: BackfillGauge;
}

// Minimal view of historicalBackfillSummary() — kept local so this module does
// not import the HTTP layer (avoids a cycle and keeps the gauges unit-testable
// without a DbPool).
export interface BackfillSummaryForGauges {
  expectedWindows: number;
  completedWindows: number;
  blockedWindows: number;
  failedWindows: number;
  progressPct: number;
  lastCompletedAt: string | null;
  oldestWindowUpdatedAt: string | null;
}

let cached: BackfillGauges | null = null;

// prom-client throws if a metric name is registered twice — which happens under
// `tsx watch` reloads and any repeated import — so reuse an already-registered
// instance instead of constructing a new one. Mirrors the guard in
// src/http/metrics.ts (collectDefaultMetrics).
function gauge(name: string, help: string): BackfillGauge {
  return (
    (register.getSingleMetric(name) as BackfillGauge | undefined) ??
    new client.Gauge({ name, help, labelNames: LABELS, registers: [register] })
  );
}

export function ensureBackfillGauges(): BackfillGauges {
  if (cached) {
    return cached;
  }
  cached = {
    expectedWindows: gauge(
      "rop_backfill_expected_windows",
      "Total historical-export backfill windows expected for the configured range.",
    ),
    completedWindows: gauge(
      "rop_backfill_completed_windows",
      "Historical-export backfill windows in a terminal-good state (completed or warning).",
    ),
    blockedWindows: gauge(
      "rop_backfill_blocked_windows",
      "Historical-export backfill windows parked in 'blocked' status — the backfill cannot advance without manual intervention.",
    ),
    failedWindows: gauge(
      "rop_backfill_failed_windows",
      "Historical-export backfill windows in 'failed' status (retryable; not yet blocked).",
    ),
    remainingWindows: gauge(
      "rop_backfill_remaining_windows",
      "Historical-export backfill windows not yet complete (expected minus completed).",
    ),
    progressPct: gauge(
      "rop_backfill_progress_pct",
      "Historical-export backfill completion percentage (0-100).",
    ),
    secondsSinceLastCompleted: gauge(
      "rop_backfill_seconds_since_last_completed",
      "Seconds since the backfill last made forward progress while windows remain. Absent when the backfill is complete or nothing has been observed yet.",
    ),
  };
  return cached;
}

/**
 * Seconds since the backfill last made forward progress, or null when no stall
 * is meaningful (the series is then left absent so the alert reads "no data"
 * rather than firing on a fabricated value).
 *
 * THE JUDGMENT CALL lives here — how to represent "staleness" when nothing has
 * ever completed:
 *   - remaining <= 0  → null. A finished backfill can never be "stalled"; if we
 *     reported `now - lastCompletedAt` it would climb forever and false-fire.
 *   - lastCompletedAt present → anchor on it (the true forward-progress clock).
 *   - never completed but windows exist → fall back to the OLDEST window's
 *     updated_at, i.e. roughly when the backfill started trying. This catches
 *     "windows were enqueued but the export runner never advanced them" (frozen
 *     updated_at → age grows → stall fires at the threshold) while a fresh
 *     deploy that started minutes ago stays well under it (no false positive).
 *   - no timestamp at all (zero windows ever created) → null. That's scheduler-
 *     down territory, better caught by the scheduler heartbeat, not here.
 */
export function secondsSinceLastProgress(
  input: {
    lastCompletedAt: string | null;
    oldestWindowUpdatedAt: string | null;
    remainingWindows: number;
  },
  now: Date,
): number | null {
  if (input.remainingWindows <= 0) {
    return null;
  }
  const anchorIso = input.lastCompletedAt ?? input.oldestWindowUpdatedAt;
  if (!anchorIso) {
    return null;
  }
  const anchor = Date.parse(anchorIso);
  if (Number.isNaN(anchor)) {
    return null;
  }
  return Math.max(0, (now.getTime() - anchor) / 1000);
}

/** Set every gauge for one merchant from its summary. */
export function recordBackfillSummary(
  merchantId: string,
  summary: BackfillSummaryForGauges,
  now: Date,
): void {
  const gauges = ensureBackfillGauges();
  const labels = { merchant_id: merchantId };
  const remaining = Math.max(0, summary.expectedWindows - summary.completedWindows);

  gauges.expectedWindows.set(labels, summary.expectedWindows);
  gauges.completedWindows.set(labels, summary.completedWindows);
  gauges.blockedWindows.set(labels, summary.blockedWindows);
  gauges.failedWindows.set(labels, summary.failedWindows);
  gauges.remainingWindows.set(labels, remaining);
  gauges.progressPct.set(labels, summary.progressPct);

  const stale = secondsSinceLastProgress(
    {
      lastCompletedAt: summary.lastCompletedAt,
      oldestWindowUpdatedAt: summary.oldestWindowUpdatedAt,
      remainingWindows: remaining,
    },
    now,
  );
  if (stale === null) {
    // Leave the series absent (rather than 0) so BackfillStalled reads "no data"
    // for this merchant instead of a value that could look healthy or stuck.
    gauges.secondsSinceLastCompleted.remove(labels);
  } else {
    gauges.secondsSinceLastCompleted.set(labels, stale);
  }
}

/**
 * Clear every per-merchant series. The updater calls this at the start of each
 * cycle so a sync target that goes inactive (or is removed) stops reporting
 * stale gauge values instead of freezing at its last reading forever.
 */
export function resetBackfillGauges(): void {
  const gauges = ensureBackfillGauges();
  for (const g of Object.values(gauges)) {
    g.reset();
  }
}
