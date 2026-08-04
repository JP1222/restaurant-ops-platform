import client from "prom-client";

// GH #142: the recurring sync jobs (hourly_rest_sweep, export_reconcile,
// square_sweep) are fire-and-forget. /readyz detects staleness but nothing pages — a 3am failure
// can persist silently until a human notices. This gauge exposes "seconds since
// the job last completed" per (job_type, merchant) so a Prometheus rule can
// alert on a stalled recurring sync (analytics-sync.rules.yml). Consistent with
// the repo's observability model (alerts via Prometheus rules, NOT an in-app
// Slack integration — there is no Alertmanager; see backfill.rules.yml).
//
// Registered on the DEFAULT registry (served at GET /metrics), populated on a
// timer by SyncFreshnessUpdater — never in the scrape path, so a slow query
// can't stall a scrape. Mirrors backfill-gauges.ts exactly.
const register = client.register;

const LABELS = ["job_type", "merchant_id"] as const;
type FreshnessGauge = client.Gauge<"job_type" | "merchant_id">;

// The recurring jobs this gauge tracks. Per-job staleness thresholds live in the
// Prometheus rule, not here (hourly vs daily cadence differ). `square_sweep` is
// the Square-provider hourly ingest (a Square store's ONLY ingest path) — only
// Square stores ever complete it, and SyncFreshnessUpdater GROUPs over existing
// audit.sync_runs rows, so a Clover store never gets a (false-stale) square_sweep
// series. Without this entry a stalled Square ingest is invisible to Prometheus.
export const RECURRING_SYNC_JOB_TYPES = ["hourly_rest_sweep", "export_reconcile", "square_sweep"] as const;

let cached: FreshnessGauge | null = null;

// getSingleMetric guard: prom-client throws on duplicate registration under
// `tsx watch` reloads / repeated imports. Same pattern as backfill-gauges.ts.
export function ensureSyncFreshnessGauge(): FreshnessGauge {
  if (cached) {
    return cached;
  }
  cached =
    (register.getSingleMetric("rop_sync_seconds_since_last_success") as FreshnessGauge | undefined) ??
    new client.Gauge({
      name: "rop_sync_seconds_since_last_success",
      help: "Seconds since a recurring sync job (hourly_rest_sweep / export_reconcile / square_sweep) last completed, per merchant. Absent when the job has never completed (a fresh deploy reads 'no data' rather than firing).",
      labelNames: LABELS,
      registers: [register],
    });
  return cached;
}

/** One recurring job's last successful completion for one merchant. */
export interface SyncRunFreshness {
  jobType: string;
  merchantId: string;
  lastCompletedAt: string | null;
}

/**
 * Seconds since the job last completed, or null when no completion is on record
 * (the series is then left absent so the alert reads "no data" — a fresh deploy
 * that has never run the job does not false-fire, matching /readyz's lenient
 * COALESCE(... , true) and the backfill stall gauge).
 */
export function secondsSinceLastSuccess(lastCompletedAt: string | null, now: Date): number | null {
  if (!lastCompletedAt) {
    return null;
  }
  const completed = Date.parse(lastCompletedAt);
  if (Number.isNaN(completed)) {
    return null;
  }
  return Math.max(0, (now.getTime() - completed) / 1000);
}

/** Replace every series from this cycle's rows; absent rows stop reporting. */
export function recordSyncFreshness(rows: SyncRunFreshness[], now: Date): void {
  const gauge = ensureSyncFreshnessGauge();
  // Clear first so a (job_type, merchant) that stops reporting (e.g. a target
  // went inactive) doesn't freeze at its last value forever.
  gauge.reset();
  for (const row of rows) {
    const stale = secondsSinceLastSuccess(row.lastCompletedAt, now);
    if (stale !== null) {
      gauge.set({ job_type: row.jobType, merchant_id: row.merchantId }, stale);
    }
  }
}
