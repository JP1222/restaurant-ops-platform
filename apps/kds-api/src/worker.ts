import "./lib/sentry-init.js";
import { Worker } from "bullmq";
import { loadConfig } from "./config.js";
import { assertAiTokenEncryptionKey } from "./lib/crypto/encryption.js";
import { canBootstrapCloverMerchantFromEnv } from "./lib/clover-runtime.js";
import { createServices, type AppServices } from "./lib/services.js";
import {
  KDS_QUEUE_NAMES,
  createBullMqConnection,
  type FulfillmentJob,
  type SchedulerJob,
  type SyncOrderJob
} from "./lib/queue/bullmq-client.js";
import {
  processFulfillmentJob,
  processSchedulerJob,
  processSyncJob,
  writeDeadLetterForFailedJob
} from "./lib/queue/handlers.js";
import { startWorkerHeartbeat } from "./lib/worker-heartbeat.js";

async function main() {
  const config = loadConfig();
  // Fail fast at boot if the at-rest master key is missing/malformed — the
  // worker also encrypts on bootstrap, so it must gate exactly like index.ts.
  assertAiTokenEncryptionKey();
  const services = createServices(config);
  const workers = startWorkers(services);
  const stopHeartbeat = startWorkerHeartbeat(services.redisPublisher);

  if (canBootstrapCloverMerchantFromEnv(config)) {
    await services.clover.bootstrapMerchantFromEnv();
  }
  await services.queue.schedule(config);

  const shutdown = async () => {
    stopHeartbeat();
    await Promise.all(workers.map((worker) => worker.close()));
    await Promise.all([
      services.queue.close(),
      services.redisPublisher.quit(),
      services.redisSubscriber.quit(),
      services.prisma.$disconnect()
    ]);
  };

  process.on("SIGTERM", () => {
    void shutdown().then(() => process.exit(0));
  });
  process.on("SIGINT", () => {
    void shutdown().then(() => process.exit(0));
  });
}

export function startWorkers(services: AppServices) {
  const connection = () => createBullMqConnection(services.config.redisUrl);
  const workers = [
    new Worker<SyncOrderJob>(
      KDS_QUEUE_NAMES.syncHi,
      (job) => processSyncJob(services, job),
      { connection: connection(), concurrency: services.config.kdsWorkerConcurrency }
    ),
    new Worker<SyncOrderJob>(
      KDS_QUEUE_NAMES.syncLo,
      (job) => processSyncJob(services, job),
      { connection: connection(), concurrency: Math.max(1, Math.floor(services.config.kdsWorkerConcurrency / 2)) }
    ),
    new Worker<FulfillmentJob>(
      KDS_QUEUE_NAMES.fulfillment,
      (job) => processFulfillmentJob(services, job),
      { connection: connection(), concurrency: services.config.kdsFulfillmentWorkerConcurrency }
    ),
    new Worker<SchedulerJob>(
      KDS_QUEUE_NAMES.scheduler,
      (job) => processSchedulerJob(services, job),
      { connection: connection(), concurrency: 4 }
    )
  ];

  for (const worker of workers) {
    worker.on("failed", (job, error) => {
      // Structured failure line to Loki. kds-api workers previously surfaced
      // failures only in the dead_letter_jobs table — and only on the final
      // attempt — so retries and the failure stream were invisible in logs.
      // requestId ties a request-originated job back to its caller's logs;
      // queue/jobId/jobType/merchantId enable DB lookup for dispatch-originated
      // jobs. console.error matches the worker's existing top-level handler
      // (this process has no Fastify/Pino logger).
      const data = (job?.data ?? {}) as { requestId?: string; merchantId?: string };
      console.error(
        JSON.stringify({
          level: "error",
          scope: "kds.worker",
          event: "job_failed",
          queue: job?.queueName,
          jobId: job?.id,
          jobType: job?.name,
          attemptsMade: job?.attemptsMade,
          requestId: data.requestId,
          merchantId: data.merchantId,
          error: error.message
        })
      );
      // Observe the rejection: a bare `void` turned a failed dead-letter write
      // into a silent unhandled rejection (GH #462). The retry + metric live in
      // writeDeadLetterForFailedJob; this is the last line of visibility.
      void writeDeadLetterForFailedJob(services, job, error).catch((cause: unknown) => {
        console.error("Failed to persist dead-letter row for failed job", {
          jobId: job?.id,
          jobType: job?.name,
          cause
        });
      });
    });
  }

  return workers;
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
