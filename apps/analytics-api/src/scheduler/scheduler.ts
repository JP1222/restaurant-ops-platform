import type { AppConfig } from "../config.js";
import type { DbPool } from "../db.js";
import { createLogger, errorMessage } from "../lib/log.js";
import { maintainSyncRunsPartitions } from "../lib/partitions.js";
import { addDays } from "../lib/time.js";
import { fullBackfillWindows } from "../backfill/windows.js";
import { completenessCtes, SUSPECT_MISSING_PREDICATE } from "../quality/completeness-sql.js";
import type { SyncTargetsReader } from "../sync-targets/repository.js";
import { Heartbeat } from "./heartbeat.js";
import { JobRepository } from "./job-repository.js";
import { SyncWindowRepository, type SyncWindowState } from "./sync-window-repository.js";

const log = createLogger("scheduler");

export class Scheduler {
  private stopped = false;
  private readonly jobs: JobRepository;
  private readonly syncWindows: SyncWindowRepository;
  private readonly heartbeat: Heartbeat;
  private lastPartitionMaintenanceDay: string | null = null;
  // Per-merchant epoch-ms of the last external-recon candidate scan that came back
  // EMPTY. Used to back the full-history spine+UNION scan off to
  // externalReconScanMinIntervalMinutes once a store's backlog has drained, instead
  // of re-running it every ~60s tick. An active drain never sets this, so it keeps
  // full tick speed.
  private readonly lastExternalReconEmptyScan = new Map<string, number>();

  constructor(
    private readonly pool: DbPool,
    private readonly config: AppConfig,
    private readonly syncTargets: SyncTargetsReader
  ) {
    this.jobs = new JobRepository(pool);
    this.syncWindows = new SyncWindowRepository(pool);
    this.heartbeat = new Heartbeat(pool, "scheduler");
  }

  start() {
    this.heartbeat.start();
    void this.loop();
  }

  stop() {
    this.stopped = true;
    this.heartbeat.stop();
  }

  private async loop() {
    while (!this.stopped) {
      try {
        await this.tick(new Date());
      } catch (error) {
        log.error(`Scheduler failed: ${errorMessage(error)}`);
      }
      await sleep(60_000);
    }
  }

  async tick(now: Date) {
    await this.maintainPartitions(now);
    // Multi-location (ADR-0018): enqueue per active store. Partition/cleanup
    // maintenance above is global and runs once per tick.
    const targets = await this.syncTargets.loadActive();
    for (const target of targets) {
      try {
        if (target.provider === "square") {
          // Square's only ingest path is the polling sweep — it has no Clover-style
          // bulk export (so no export_reconcile / historical_export_backfill) and
          // no Clover control-total external recon. DQ + forecast are mart-level
          // (provider-agnostic) so they still run.
          await this.enqueueSquareSweep(now, target.merchantId);
          await this.enqueueDataQuality(now, target.merchantId);
          await this.enqueueForecastRefresh(now, target.merchantId);
        } else {
          await this.enqueueHourlySweep(now, target.merchantId);
          await this.enqueueExportReconcile(now, target.merchantId);
          await this.enqueueHistoricalBackfill(now, target.merchantId);
          await this.enqueueDataQuality(now, target.merchantId);
          await this.enqueueForecastRefresh(now, target.merchantId);
          await this.enqueueExternalRecon(now, target.merchantId);
        }
      } catch (error) {
        // Per-store fault isolation: one store's enqueue failure (a malformed
        // window, a tz lookup that rejects, a transient DB error) must not skip
        // the remaining stores this tick. Mirrors the per-target try/catch in
        // backfill-metrics-updater.ts. Without it, a single bad merchant freezes
        // every later store's sweep until the next tick.
        log.error(
          `Scheduler tick failed for ${target.merchantId}: ${errorMessage(error)}`,
          { merchantId: target.merchantId },
        );
      }
    }
  }

  private async maintainPartitions(now: Date) {
    const day = now.toISOString().slice(0, 10);
    if (day === this.lastPartitionMaintenanceDay) {
      return;
    }
    await maintainSyncRunsPartitions(this.pool, now);
    await cleanupWebhookInbox(this.pool);
    this.lastPartitionMaintenanceDay = day;
  }

  private async enqueueHourlySweep(now: Date, merchantId: string) {
    if (now.getUTCMinutes() < this.config.hourlySweepOffsetMinutes) {
      return;
    }
    const hourStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), now.getUTCHours()));
    const end = new Date(hourStart.getTime() + this.config.hourlySweepOffsetMinutes * 60_000);
    const start = new Date(end.getTime() - this.config.syncOverlapHours * 60 * 60_000);
    await this.jobs.enqueueOnce({
      jobType: "hourly_rest_sweep",
      merchantId,
      windowStart: start,
      windowEnd: end,
      dedupeKey: `${merchantId}:hourly_rest_sweep:${hourStart.toISOString()}`,
      payload: {
        start: start.toISOString(),
        end: end.toISOString(),
        reason: "hourly_rest_sweep"
      }
    });
  }

  private async enqueueSquareSweep(now: Date, merchantId: string) {
    if (now.getUTCMinutes() < this.config.hourlySweepOffsetMinutes) {
      return;
    }
    const hourStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), now.getUTCHours()));
    const end = new Date(hourStart.getTime() + this.config.hourlySweepOffsetMinutes * 60_000);
    const start = new Date(end.getTime() - this.config.syncOverlapHours * 60 * 60_000);
    await this.jobs.enqueueOnce({
      jobType: "square_sweep",
      merchantId,
      windowStart: start,
      windowEnd: end,
      dedupeKey: `${merchantId}:square_sweep:${hourStart.toISOString()}`,
      payload: {
        start: start.toISOString(),
        end: end.toISOString(),
        reason: "square_sweep"
      }
    });
  }

  private async enqueueExportReconcile(now: Date, merchantId: string) {
    if (!isWithinExportWindow(now, this.config)) {
      return;
    }
    const day = now.toISOString().slice(0, 10);
    const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const start = addDays(end, -this.config.exportReconcileLookbackDays);
    await this.jobs.enqueueOnce({
      jobType: "export_reconcile",
      merchantId,
      windowStart: start,
      windowEnd: end,
      dedupeKey: `${merchantId}:export_reconcile:${day}`,
      payload: {
        start: start.toISOString(),
        end: end.toISOString(),
        reason: "export_reconcile"
      }
    });
  }

  private async enqueueHistoricalBackfill(now: Date, merchantId: string) {
    if (!isHistoricalBackfillWindow(now, this.config)) {
      return;
    }
    // Bounded parallelism (P5): keep up to N windows in flight at once instead of
    // a strict one-at-a-time serial. `slots` is the remaining concurrency budget;
    // we fill it this tick. Kept conservative (default 2) to respect Clover's
    // "handles a few exports concurrently" limit — over-parallelizing just earns
    // 503s, which the P11 fix parks as retryable rather than blocking.
    const active = await this.jobs.activeJobCount(merchantId, "historical_export_backfill");
    let slots = this.config.historicalBackfillMaxConcurrentWindows - active;
    if (slots <= 0) {
      return;
    }
    const windows = fullBackfillWindows(this.config.backfillStartDate, now, this.config.backfillWindowDays);
    for (const window of windows) {
      if (slots <= 0) {
        break;
      }
      const state = await this.syncWindows.historicalBackfillWindowState({
        merchantId,
        windowStart: window.start,
        windowEnd: window.end
      });
      // Skip-and-continue, never return: one stuck early window must not wedge the
      // whole multi-year backfill (the head-of-line block this fixes).
      if (!this.shouldEnqueueHistoricalWindow(state, now)) {
        continue;
      }
      const dedupeKey = `${merchantId}:historical_export_backfill:${window.start.toISOString()}:${window.end.toISOString()}`;
      // Guards the parallel case: a window already pending/running (its live job
      // counted in `active`) is skipped so the budget can't be double-spent.
      if (await this.jobs.existsByDedupeKey(dedupeKey, ["pending", "running", "completed"])) {
        continue;
      }
      await this.jobs.enqueue({
        jobType: "historical_export_backfill",
        merchantId,
        windowStart: window.start,
        windowEnd: window.end,
        dedupeKey,
        payload: {
          start: window.start.toISOString(),
          end: window.end.toISOString(),
          reason: "historical_export_backfill"
        }
      });
      await this.syncWindows.markStage({
        merchantId,
        windowType: "historical_export_backfill",
        windowStart: window.start,
        windowEnd: window.end,
        stage: "scheduled",
        status: "pending"
      });
      slots -= 1;
    }
  }

  // Decides whether a historical window is eligible to be (re)enqueued this tick.
  // Anything not eligible is skipped (the caller `continue`s past it) so a parked
  // window never blocks progress on the rest of the grid.
  private shouldEnqueueHistoricalWindow(state: SyncWindowState | null, now: Date): boolean {
    if (!state) {
      return true;
    }
    switch (state.status) {
      case "completed":
      case "warning":
        return false;
      case "pending":
        // activeJobCount above already returned if any backfill job is in flight,
        // so a pending row here has no live job — an orphan (P14) or an operator
        // requeue. Re-enqueue it.
        return true;
      case "running":
        // A running row with no live job is stale; leave it for recoverStaleRunning
        // rather than risk a concurrent re-run.
        return false;
      case "failed":
        return !state.retryAfter || state.retryAfter.getTime() <= now.getTime();
      case "blocked":
        return this.canAutoUnblockHistoricalWindow(state, now);
      default:
        return false;
    }
  }

  // A blocked window auto-recovers after a backoff, up to a hard ceiling beyond
  // which it is permanently parked for manual intervention (P2). This turns a
  // misclassified-transient block into a self-healing retry instead of requiring
  // raw SQL, while a genuinely-dead window still stops looping.
  private canAutoUnblockHistoricalWindow(state: SyncWindowState, now: Date): boolean {
    const ceiling =
      this.config.historicalBackfillMaxWindowFailures +
      this.config.historicalBackfillMaxAutoUnblockAttempts;
    if (state.failureCount >= ceiling) {
      return false;
    }
    if (!state.blockedAt) {
      return false;
    }
    const eligibleAt =
      state.blockedAt.getTime() + this.config.historicalBackfillBlockedRetryAfterMinutes * 60_000;
    return eligibleAt <= now.getTime();
  }

  // P4 external correctness: enqueue the oldest never-verified business days for a
  // Clover re-fetch + control-total diff. Bounded three ways: an in-flight cap
  // (externalReconMaxConcurrentDays), the per-merchant Clover rate limiter inside
  // each job, and a skip during the export window so it never contends with the
  // daily export-reconcile for Clover request budget. A day is verified once;
  // re-verification after a repair (dirtiest-first) is P4b.
  private async enqueueExternalRecon(now: Date, merchantId: string) {
    if (this.config.externalReconMaxConcurrentDays <= 0 || isWithinExportWindow(now, this.config)) {
      return;
    }
    const active = await this.jobs.activeJobCount(merchantId, "external_recon");
    const slots = this.config.externalReconMaxConcurrentDays - active;
    if (slots <= 0) {
      return;
    }
    // Throttle the full-history candidate scan once the backlog has drained: if the
    // last scan for this merchant found nothing and was less than
    // externalReconScanMinIntervalMinutes ago, skip the (whole-calendar) scan this
    // tick. New candidates appear at most ~one/day (the calendar advancing, or a
    // freed recon_daily slot after a repair), so a few minutes' latency on this
    // background sweep is immaterial. An active drain never marks the scan empty, so
    // it is never throttled — only steady-state idling is.
    const lastEmpty = this.lastExternalReconEmptyScan.get(merchantId);
    if (
      lastEmpty !== undefined &&
      now.getTime() - lastEmpty < this.config.externalReconScanMinIntervalMinutes * 60_000
    ) {
      return;
    }
    // Candidates = days WITH mart data (confirm they match Clover) UNION the
    // suspect-MISSING days (open days with zero activity — let Clover adjudicate
    // closure vs real loss). Both filtered to days not yet in recon_daily, oldest
    // first. This is what turns the completeness check's holiday noise into a
    // cross-stream verdict: a missing day Clover also has zero for lands 'ok'
    // (confirmed closure), one Clover has data for lands a 'fail' break.
    //
    // P4b note: candidacy is gated on NOT EXISTS recon_daily, so a day is verified
    // exactly ONCE — any persisted verdict is terminal until re-verification (P4b)
    // lands. Two invariants that gate must preserve: (1) a transient fetch failure
    // must NOT persist a row (today runExternalReconJob throws on a hard failure,
    // leaving the day re-eligible — do not "catch and write fail"); (2) when P4b adds
    // re-verification, a transient failure on re-check must record source_unavailable
    // (re-checkable) rather than a sticky 'fail' that this gate would never revisit.
    const { rows } = await this.pool.query<{ business_date: string }>(
      `
        WITH ${completenessCtes("bounds.last_data_date")},
        candidates AS (
          SELECT business_date FROM activity
          UNION
          SELECT s.business_date
          FROM spine s
          LEFT JOIN activity a ON a.business_date = s.business_date
          WHERE ${SUSPECT_MISSING_PREDICATE}
        )
        SELECT to_char(c.business_date, 'YYYY-MM-DD') AS business_date
        FROM candidates c
        WHERE c.business_date < current_date
          AND NOT EXISTS (
            SELECT 1 FROM audit.recon_daily rd
            WHERE rd.merchant_id = $1
              AND rd.business_date = c.business_date
          )
        ORDER BY c.business_date ASC
        LIMIT $2
      `,
      [merchantId, slots]
    );
    if (rows.length === 0) {
      // Backlog drained: remember the empty scan so the next ticks skip the
      // full-history scan until the throttle window elapses.
      this.lastExternalReconEmptyScan.set(merchantId, now.getTime());
      return;
    }
    // Found work — drop any empty marker so the drain runs at full tick speed.
    this.lastExternalReconEmptyScan.delete(merchantId);
    for (const row of rows) {
      await this.jobs.enqueueOnce({
        jobType: "external_recon",
        merchantId,
        dedupeKey: `${merchantId}:external_recon:${row.business_date}`,
        payload: { businessDate: row.business_date, reason: "scheduled_rotation" }
      });
    }
  }

  private async enqueueDataQuality(now: Date, merchantId: string) {
    const day = now.toISOString().slice(0, 10);
    await this.jobs.enqueueOnce({
      jobType: "data_quality_check",
      merchantId,
      dedupeKey: `${merchantId}:data_quality_check:${day}`,
      payload: {}
    });
  }

  // Daily demand-forecast recompute (ADR-0032). Gated to fire once per UTC day at or
  // after the configured hour (default 16:00 UTC, just after the export-reconcile
  // window) so the freshest reconciled day feeds the model. The date-keyed dedupe
  // makes the gate a one-shot: it enqueues on the first tick past the hour, not every
  // tick after. Before that hour, nothing is enqueued.
  private async enqueueForecastRefresh(now: Date, merchantId: string) {
    if (!isForecastRefreshHour(now, this.config)) {
      return;
    }
    const day = now.toISOString().slice(0, 10);
    await this.jobs.enqueueOnce({
      jobType: "forecast_refresh",
      merchantId,
      dedupeKey: `${merchantId}:forecast_refresh:${day}`,
      payload: { reason: "scheduled_daily" }
    });
  }
}

export async function cleanupWebhookInbox(pool: DbPool, retentionDays = 30) {
  await pool.query(
    `
      DELETE FROM audit.webhook_inbox
      WHERE status IN ('processed', 'ignored')
        AND processed_at < now() - ($1::text)::interval
    `,
    [`${retentionDays} days`]
  );
}

export function isWithinExportWindow(now: Date, config: AppConfig) {
  const start = parseUtcMinutes(config.exportWindowStartUtc);
  const end = parseUtcMinutes(config.exportWindowEndUtc);
  const current = now.getUTCHours() * 60 + now.getUTCMinutes();
  return start <= end
    ? current >= start && current < end
    : current >= start || current < end;
}

export function isForecastRefreshHour(now: Date, config: AppConfig) {
  return now.getUTCHours() >= config.forecastRefreshHourUtc;
}

export function isHistoricalBackfillWindow(now: Date, config: AppConfig) {
  if (!isWithinExportWindow(now, config)) {
    return false;
  }
  const start = parseUtcMinutes(config.exportWindowStartUtc);
  const end = parseUtcMinutes(config.exportWindowEndUtc);
  const duration = end >= start ? end - start : 24 * 60 - start + end;
  const historicalStartOffset = duration * (1 - config.exportHistoricalBackfillWindowShare);
  const current = now.getUTCHours() * 60 + now.getUTCMinutes();
  const currentOffset = current >= start ? current - start : current + 24 * 60 - start;
  return currentOffset >= historicalStartOffset;
}

export function nextHistoricalBackfillWindowAt(now: Date, config: AppConfig) {
  if (config.exportHistoricalBackfillWindowShare <= 0) {
    return null;
  }
  if (isHistoricalBackfillWindow(now, config)) {
    return now;
  }

  const start = parseUtcMinutes(config.exportWindowStartUtc);
  const end = parseUtcMinutes(config.exportWindowEndUtc);
  const duration = end >= start ? end - start : 24 * 60 - start + end;
  const historicalStart = start + duration * (1 - config.exportHistoricalBackfillWindowShare);
  const dayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const todayCandidate = new Date(dayStart + historicalStart * 60_000);

  if (todayCandidate.getTime() > now.getTime()) {
    return todayCandidate;
  }
  return new Date(todayCandidate.getTime() + 24 * 60 * 60_000);
}

function parseUtcMinutes(value: string) {
  const [hourRaw, minuteRaw] = value.split(":");
  return Number(hourRaw) * 60 + Number(minuteRaw);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
