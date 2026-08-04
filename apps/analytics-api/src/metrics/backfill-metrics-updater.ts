import type { AppConfig } from "../config.js";
import type { DbPool } from "../db.js";
import { historicalBackfillSummary } from "../http/dashboard.js";
import { createLogger, errorMessage } from "../lib/log.js";
import type { SyncTargetsReader } from "../sync-targets/repository.js";
import {
  ensureBackfillGauges,
  recordBackfillSummary,
  resetBackfillGauges,
} from "./backfill-gauges.js";

const log = createLogger("backfill-metrics");

/**
 * Periodically recomputes the rop_backfill_* Prometheus gauges from
 * historicalBackfillSummary(), one series per active sync target. Runs on a
 * timer (default 5 min) — deliberately OUT of the /metrics scrape path so a slow
 * query can never stall a scrape. Mirrors the start/stop + setInterval().unref()
 * shape of the other analytics-api background workers (e.g. Heartbeat).
 */
export class BackfillMetricsUpdater {
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private readonly intervalMs: number;

  constructor(
    private readonly pool: DbPool,
    private readonly config: AppConfig,
    private readonly syncTargets: SyncTargetsReader,
  ) {
    this.intervalMs = config.backfillMetricsRefreshSeconds * 1000;
  }

  start(): void {
    this.stopped = false;
    // Register up front so GET /metrics lists the gauges (HELP/TYPE lines) even
    // before the first cycle populates any per-merchant series.
    ensureBackfillGauges();
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
      const targets = await this.syncTargets.loadActive();
      // Clear first so a target that went inactive stops reporting a frozen
      // value; only the active targets below are re-populated this cycle.
      resetBackfillGauges();
      for (const target of targets) {
        try {
          const summary = await historicalBackfillSummary(
            this.pool,
            this.config,
            target.merchantId,
            now,
          );
          recordBackfillSummary(target.merchantId, summary, now);
        } catch (error) {
          // One store's failure must not abort the others' gauges for this cycle.
          log.error(
            `Backfill gauge refresh failed for ${target.merchantId}: ${errorMessage(error)}`,
            { merchantId: target.merchantId },
          );
        }
      }
    } catch (error) {
      log.error(`Backfill gauge refresh failed: ${errorMessage(error)}`);
    }
  }
}
