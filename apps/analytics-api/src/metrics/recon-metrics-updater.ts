import type { AppConfig } from "../config.js";
import type { DbPool } from "../db.js";
import { createLogger, errorMessage } from "../lib/log.js";
import type { SyncTargetsReader } from "../sync-targets/repository.js";
import {
  ensureReconGauges,
  recordReconSummary,
  resetReconGauges,
  type ReconSummaryForGauges,
} from "./recon-gauges.js";

const log = createLogger("recon-metrics");

interface ReconSummaryRow {
  unresolved_break_days: number;
  oldest_unresolved_break_day: string | null;
  last_run_at: Date | string | null;
}

/**
 * Periodically recomputes the rop_recon_* Prometheus gauges from
 * audit.reconciliation_results, one series per active sync target. Runs on a
 * timer (shared BACKFILL_METRICS_REFRESH_SECONDS cadence, default 5 min) —
 * deliberately OUT of the /metrics scrape path so a slow query can never stall a
 * scrape. Mirrors BackfillMetricsUpdater's start/stop + per-target try/catch.
 */
export class ReconMetricsUpdater {
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
    ensureReconGauges();
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

  async refresh(): Promise<void> {
    if (this.stopped) {
      return;
    }
    try {
      const targets = await this.syncTargets.loadActive();
      // Clear first so a target that went inactive stops reporting a frozen
      // value; only the active targets below are re-populated this cycle.
      resetReconGauges();
      for (const target of targets) {
        try {
          const summary = await this.reconSummary(target.merchantId);
          recordReconSummary(target.merchantId, summary);
        } catch (error) {
          // One store's failure must not abort the others' gauges for this cycle.
          log.error(
            `Recon gauge refresh failed for ${target.merchantId}: ${errorMessage(error)}`,
            { merchantId: target.merchantId },
          );
        }
      }
    } catch (error) {
      log.error(`Recon gauge refresh failed: ${errorMessage(error)}`);
    }
  }

  // Latest-status-per-business_date over reconciliation_results: a day is an
  // unresolved break when its newest row is 'failed'. business_date is forced to
  // a 'YYYY-MM-DD' string via to_char so it bypasses node-postgres' date parser
  // (the global DATE parser has bitten this codebase before with off-by-one).
  private async reconSummary(merchantId: string): Promise<ReconSummaryForGauges> {
    const { rows } = await this.pool.query<ReconSummaryRow>(
      `
      WITH latest AS (
        SELECT DISTINCT ON (business_date) business_date, status
        FROM audit.reconciliation_results
        WHERE merchant_id = $1
        ORDER BY business_date, created_at DESC
      )
      SELECT
        count(*) FILTER (WHERE status = 'failed')::int AS unresolved_break_days,
        to_char(
          min(business_date) FILTER (WHERE status = 'failed'),
          'YYYY-MM-DD'
        ) AS oldest_unresolved_break_day,
        (
          SELECT max(created_at)
          FROM audit.reconciliation_results
          WHERE merchant_id = $1
        ) AS last_run_at
      FROM latest
      `,
      [merchantId],
    );
    const row = rows[0];
    return {
      unresolvedBreakDays: row?.unresolved_break_days ?? 0,
      oldestUnresolvedBreakDay: row?.oldest_unresolved_break_day ?? null,
      lastRunAt: toIso(row?.last_run_at ?? null),
    };
  }
}

function toIso(value: Date | string | null): string | null {
  if (value === null) {
    return null;
  }
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
