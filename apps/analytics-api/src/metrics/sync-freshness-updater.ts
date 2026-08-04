import type { AppConfig } from "../config.js";
import type { DbPool } from "../db.js";
import { createLogger, errorMessage } from "../lib/log.js";
import type { SyncTargetsReader } from "../sync-targets/repository.js";
import {
  ensureSyncFreshnessGauge,
  recordSyncFreshness,
  RECURRING_SYNC_JOB_TYPES,
  type SyncRunFreshness,
} from "./sync-freshness-gauges.js";

const log = createLogger("sync-freshness-metrics");

/**
 * GH #142: periodically recomputes rop_sync_seconds_since_last_success from
 * audit.sync_runs so a Prometheus rule can page when a recurring sync (hourly /
 * daily) stalls. Runs on a timer (reuses backfillMetricsRefreshSeconds, default
 * 5 min — staleness is alerted at hour/day granularity, so sub-5-min refresh is
 * unnecessary) — deliberately OUT of the /metrics scrape path. Mirrors
 * BackfillMetricsUpdater's start/stop + setInterval().unref() shape.
 */
export class SyncFreshnessUpdater {
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private readonly intervalMs: number;

  constructor(
    private readonly pool: DbPool,
    config: AppConfig,
    private readonly syncTargets: SyncTargetsReader,
  ) {
    this.intervalMs = config.backfillMetricsRefreshSeconds * 1000;
  }

  start(): void {
    this.stopped = false;
    // Register up front so GET /metrics lists the gauge (HELP/TYPE) before the
    // first cycle populates any series.
    ensureSyncFreshnessGauge();
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async refresh(now = new Date()): Promise<void> {
    if (this.stopped) {
      return;
    }
    try {
      // Scope to active sync targets so a decommissioned merchant's frozen
      // last-completion can't keep climbing and false-fire forever.
      const targets = await this.syncTargets.loadActive();
      if (targets.length === 0) {
        recordSyncFreshness([], now);
        return;
      }
      const merchantIds = targets.map((t) => t.merchantId);
      const result = await this.pool.query<{
        merchant_id: string;
        job_type: string;
        last_completed_at: string | null;
      }>(
        `
          SELECT merchant_id, job_type, max(completed_at) AS last_completed_at
          FROM audit.sync_runs
          WHERE status = 'completed'
            AND job_type = ANY($1::text[])
            AND merchant_id = ANY($2::text[])
          GROUP BY merchant_id, job_type
        `,
        [RECURRING_SYNC_JOB_TYPES as unknown as string[], merchantIds],
      );
      const rows: SyncRunFreshness[] = result.rows.map((r) => ({
        jobType: r.job_type,
        merchantId: r.merchant_id,
        lastCompletedAt: r.last_completed_at,
      }));
      recordSyncFreshness(rows, now);
    } catch (error) {
      log.error(`Sync-freshness gauge refresh failed: ${errorMessage(error)}`);
    }
  }
}
