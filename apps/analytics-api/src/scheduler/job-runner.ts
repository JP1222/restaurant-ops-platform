import type { AppConfig } from "../config.js";
import type { DbPool } from "../db.js";
import { CloverClientFactory } from "../clover/client-factory.js";
import { SquareClientFactory } from "../square/client-factory.js";
import { createLogger, errorMessage } from "../lib/log.js";
import { runDataQualityJob } from "../jobs/data-quality-check.js";
import { runForecastRefreshJob } from "../jobs/forecast-refresh.js";
import { runExportWindowJob } from "../jobs/export-reconcile.js";
import { runRestSweepJob } from "../jobs/hourly-rest-sweep.js";
import { runSquareSweepJob } from "../jobs/square-sweep.js";
import { runOrderDetailHydrationJob } from "../jobs/order-detail-hydration.js";
import { runReconciliationCheckJob } from "../jobs/reconciliation-check.js";
import { runExternalReconJob } from "../jobs/external-recon.js";
import { runReferenceDataRefreshJob } from "../jobs/reference-data-refresh.js";
import { runWebhookFetchJob } from "../jobs/webhook-fetch.js";
import { AdvisoryNamespace, advisoryKey, withSessionAdvisoryLock } from "./advisory-lock.js";
import { Heartbeat } from "./heartbeat.js";
import { JobRepository, type SyncJob } from "./job-repository.js";
import { SyncWindowRepository, type SyncWindowFailurePolicy } from "./sync-window-repository.js";
import type { JobType } from "./job-types.js";

type JobRunnerOptions = {
  allowedTypes?: JobType[];
  concurrency: number;
  name: string;
};

const log = createLogger("scheduler.job-runner");

export class JobRunner {
  private stopped = false;
  private readonly repository: JobRepository;
  private readonly syncWindows: SyncWindowRepository;
  private readonly heartbeat: Heartbeat;

  constructor(
    private readonly pool: DbPool,
    private readonly config: AppConfig,
    private readonly clients: CloverClientFactory,
    private readonly options: JobRunnerOptions,
    // Only the runner whose allowedTypes include "square_sweep" needs this; an
    // optional trailing param keeps the other four JobRunner constructions
    // untouched.
    private readonly squareClients?: SquareClientFactory
  ) {
    this.repository = new JobRepository(pool);
    this.syncWindows = new SyncWindowRepository(pool);
    this.heartbeat = new Heartbeat(pool, options.name);
  }

  start() {
    this.heartbeat.start();
    for (let index = 0; index < this.options.concurrency; index += 1) {
      void this.workerLoop(index);
    }
  }

  stop() {
    this.stopped = true;
    this.heartbeat.stop();
  }

  private async workerLoop(workerIndex: number) {
    while (!this.stopped) {
      try {
        await this.repository.recoverStaleRunning(this.config.jobStaleAfterMinutes);
        const job = await this.repository.claimNext(`${this.heartbeat.id()}-${workerIndex}`, this.options.allowedTypes);
        if (!job) {
          await sleep(1000);
          continue;
        }
        await this.runClaimedJob(job);
      } catch (error) {
        log.error(`Job runner ${this.options.name} failed: ${errorMessage(error)}`, { runner: this.options.name });
        await sleep(2000);
      }
    }
  }

  private async runClaimedJob(job: SyncJob) {
    const startedAt = new Date();
    const lock = this.lockForJob(job);
    try {
      const metrics = await withSessionAdvisoryLock(
        this.pool,
        lock.namespace,
        lock.key,
        async () => {
          await this.syncWindows.markJobRunning(job);
          return this.dispatch(job);
        }
      );
      if (metrics === null) {
        await this.repository.requeue(job.id, 5000, "Advisory lock busy.");
        return;
      }
      await this.repository.complete(job.id);
      await this.syncWindows.markJobCompleted(job, metrics);
      await this.repository.insertRun({ job, status: "completed", startedAt, ...metrics });
    } catch (error) {
      const failurePolicy = this.failurePolicy(job, error);
      await this.repository.fail(job, error, { terminal: job.jobType === "historical_export_backfill" });
      await this.syncWindows.markJobFailed(job, error, failurePolicy);
      await this.repository.insertRun({ job, status: "failed", startedAt, error });
    }
  }

  private failurePolicy(job: SyncJob, error: unknown): SyncWindowFailurePolicy {
    if (job.jobType !== "historical_export_backfill") {
      return {};
    }

    const classification = classifyBackfillError(error);
    return {
      blocked: classification.blocked,
      errorClass: classification.errorClass,
      maxFailures: this.config.historicalBackfillMaxWindowFailures,
      retryAfter: classification.blocked
        ? null
        : new Date(Date.now() + this.config.historicalBackfillRetryCooldownMinutes * 60_000)
    };
  }

  private lockForJob(job: SyncJob) {
    if (job.windowStart && job.windowEnd) {
      return {
        namespace: AdvisoryNamespace.MerchantWindow,
        key: advisoryKey(`${job.merchantId}:${job.windowStart.toISOString()}:${job.windowEnd.toISOString()}`)
      };
    }
    return {
      namespace: AdvisoryNamespace.MerchantGlobal,
      key: advisoryKey(`${job.merchantId}:${job.jobType}`)
    };
  }

  private async dispatch(job: SyncJob) {
    switch (job.jobType) {
      case "webhook_fetch_order":
      case "webhook_fetch_payment":
        return runWebhookFetchJob(this.pool, this.config, await this.clients.get(job.merchantId), job);
      case "mini_rest_sweep":
      case "hourly_rest_sweep":
      case "repair_window":
        return runRestSweepJob(this.pool, this.config, await this.clients.get(job.merchantId), job);
      case "reference_data_refresh":
        return runReferenceDataRefreshJob(this.pool, await this.clients.get(job.merchantId), job);
      case "export_reconcile":
      case "historical_export_backfill":
        return runExportWindowJob(this.pool, this.config, await this.clients.get(job.merchantId), job);
      case "order_detail_hydration":
        return runOrderDetailHydrationJob(this.pool, this.config, await this.clients.get(job.merchantId), job);
      case "reconciliation_check":
        return runReconciliationCheckJob(this.pool, this.config, job);
      case "data_quality_check":
        return runDataQualityJob(this.pool, job);
      case "forecast_refresh":
        return runForecastRefreshJob(this.pool, job);
      case "external_recon":
        return runExternalReconJob(this.pool, this.config, await this.clients.get(job.merchantId), job);
      case "square_sweep": {
        if (!this.squareClients) {
          throw new Error("square_sweep dispatched to a runner with no SquareClientFactory");
        }
        return runSquareSweepJob(this.pool, this.config, await this.squareClients.get(job.merchantId), job);
      }
    }
  }
}

export function classifyBackfillError(error: unknown): { blocked: boolean; errorClass: string } {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  if (/\b(400|401|403|404)\b/.test(normalized)
    || normalized.includes("unauthorized")
    || normalized.includes("forbidden")
    || normalized.includes("invalid token")
    || normalized.includes("permission")
    || normalized.includes("unsupported")
    || normalized.includes("invalid payload")
    || normalized.includes("schema")) {
    return { blocked: true, errorClass: "manual_attention" };
  }
  if (/\b(429|500|502|503|504)\b/.test(normalized)
    || normalized.includes("rate limit")
    || normalized.includes("timeout")
    || normalized.includes("timed out")
    || normalized.includes("econn")
    || normalized.includes("network")
    || normalized.includes("fetch failed")
    || normalized.includes("temporary")) {
    return { blocked: false, errorClass: "retryable" };
  }
  return { blocked: false, errorClass: "retryable_unknown" };
}


function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
