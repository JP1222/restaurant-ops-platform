#!/usr/bin/env node
import "./lib/sentry-init.js";
import { loadConfig } from "./config.js";
import { createLogger, errorMessage } from "./lib/log.js";
import { createPool } from "./db.js";
import { runMigrations } from "./migrate.js";
import { CloverClientFactory } from "./clover/client-factory.js";
import { SquareClientFactory } from "./square/client-factory.js";
import { startHttpServer } from "./http/server.js";
import { maintainSyncRunsPartitions } from "./lib/partitions.js";
import { JobRunner } from "./scheduler/job-runner.js";
import { Scheduler } from "./scheduler/scheduler.js";
import { WebhookInboxWorker } from "./scheduler/webhook-inbox-worker.js";
import { MartRefreshWorker } from "./refresh/mart-refresh-worker.js";
import { ActualCogsIngestWorker } from "./refresh/actual-cogs-ingest-worker.js";
import { BackfillMetricsUpdater } from "./metrics/backfill-metrics-updater.js";
import { ReconMetricsUpdater } from "./metrics/recon-metrics-updater.js";
import { SyncFreshnessUpdater } from "./metrics/sync-freshness-updater.js";
import { SyncTargetsRepository } from "./sync-targets/repository.js";

const log = createLogger("service");

async function main() {
  const config = loadConfig();
  const pool = createPool(config);

  await runMigrations(pool);
  await maintainSyncRunsPartitions(pool);

  // Multi-location (ADR-0018 / ADR-0019): the set of stores to sync lives in
  // config.sync_targets, not a single env-pinned merchant. Seed one row from
  // CLOVER_MERCHANT_ID/CLOVER_TOKEN when the table is empty so existing
  // single-store deploys keep working with no config change.
  const syncTargets = new SyncTargetsRepository(pool);
  await syncTargets.seedFromEnvIfEmpty(config);
  const clients = new CloverClientFactory(config, syncTargets);
  const squareClients = new SquareClientFactory(config, syncTargets);

  const server = startHttpServer(pool, config, syncTargets);
  const scheduler = new Scheduler(pool, config, syncTargets);
  const realtimeRunner = new JobRunner(
    pool,
    config,
    clients,
    {
      name: "realtime-runner",
      concurrency: config.realtimeWorkerConcurrency,
      allowedTypes: [
        "webhook_fetch_order",
        "webhook_fetch_payment",
        "reference_data_refresh",
        "mini_rest_sweep",
        "hourly_rest_sweep",
        "square_sweep"
      ]
    },
    squareClients
  );
  const exportRunner = new JobRunner(pool, config, clients, {
    name: "export-runner",
    // Size the pool to at least the historical-backfill concurrency budget (P5)
    // so parallel windows actually run concurrently instead of queueing behind a
    // single worker.
    concurrency: Math.max(config.exportWorkerConcurrency, config.historicalBackfillMaxConcurrentWindows),
    allowedTypes: [
      "export_reconcile",
      "historical_export_backfill",
      "reconciliation_check",
      "external_recon"
    ]
  });
  const hydrationRunner = new JobRunner(pool, config, clients, {
    name: "hydration-runner",
    concurrency: config.hydrationWorkerConcurrency,
    allowedTypes: [
      "order_detail_hydration"
    ]
  });
  const repairRunner = new JobRunner(pool, config, clients, {
    name: "repair-runner",
    concurrency: config.repairWorkerConcurrency,
    allowedTypes: [
      "repair_window"
    ]
  });
  const dqRunner = new JobRunner(pool, config, clients, {
    name: "dq-runner",
    concurrency: config.dqWorkerConcurrency,
    allowedTypes: ["data_quality_check", "forecast_refresh"]
  });
  const martRefreshWorker = new MartRefreshWorker(pool, config, syncTargets);
  const actualCogsIngestWorker = new ActualCogsIngestWorker(pool, config);
  const webhookInboxWorker = new WebhookInboxWorker(pool, config, syncTargets);
  const backfillMetricsUpdater = new BackfillMetricsUpdater(pool, config, syncTargets);
  const syncFreshnessUpdater = new SyncFreshnessUpdater(pool, config, syncTargets);
  const reconMetricsUpdater = new ReconMetricsUpdater(pool, config, syncTargets);

  scheduler.start();
  webhookInboxWorker.start();
  realtimeRunner.start();
  exportRunner.start();
  hydrationRunner.start();
  repairRunner.start();
  dqRunner.start();
  martRefreshWorker.start();
  actualCogsIngestWorker.start();
  backfillMetricsUpdater.start();
  syncFreshnessUpdater.start();
  reconMetricsUpdater.start();

  const shutdown = async () => {
    log.info("Stopping Example Kitchen Intelligence service...");
    scheduler.stop();
    webhookInboxWorker.stop();
    realtimeRunner.stop();
    exportRunner.stop();
    hydrationRunner.stop();
    repairRunner.stop();
    dqRunner.stop();
    martRefreshWorker.stop();
    actualCogsIngestWorker.stop();
    backfillMetricsUpdater.stop();
    syncFreshnessUpdater.stop();
    reconMetricsUpdater.stop();
    server.close();
    await pool.end();
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());

  log.info("Example Kitchen Intelligence service started.");
}

main().catch((error) => {
  log.error(errorMessage(error));
  process.exitCode = 1;
});
