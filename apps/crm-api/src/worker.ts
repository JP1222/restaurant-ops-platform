import "./lib/sentry-init.js";
import { Worker } from "bullmq";
import { Redis } from "ioredis";
import { CRM_LOYALTY_ACCRUAL_QUEUE, type OrderCompletedEvent } from "@rop/contracts";

import { loadConfig } from "./config.js";
import type { AccrualResult } from "./domain/accrual.js";
import { createServices } from "./lib/services.js";
import { deadLetterRowForFailedAccrual, processAccrualJob } from "./worker-handler.js";

// Structured JSON to stdout (one line per event) — container log aggregators
// parse this. NEVER log the event body / phone / PII: only the job id, the
// accrual outcome status, and error messages.
function log(level: "info" | "error", msg: string, fields: Record<string, unknown> = {}) {
  const line = JSON.stringify({ level, time: new Date().toISOString(), service: "crm-worker", msg, ...fields });
  if (level === "error") {
    console.error(line);
  } else {
    console.log(line);
  }
}

// Standalone loyalty-accrual worker. crm-api's HTTP `index.ts` does NOT start
// workers (exactly like kds-api's `index.ts`); this is its own process / compose
// service so an HTTP deploy and a worker deploy scale and fail independently.
async function main() {
  const config = loadConfig();
  if (!config.redisUrl) {
    throw new Error(
      "CRM_REDIS_URL is required to run the loyalty worker — it must point at the same Redis kds-api produces the crm-loyalty-accrual queue to."
    );
  }

  const services = createServices(config);
  const connection = new Redis(config.redisUrl, { maxRetriesPerRequest: null });

  const worker = new Worker<OrderCompletedEvent, AccrualResult>(
    CRM_LOYALTY_ACCRUAL_QUEUE,
    (job) => processAccrualJob(services, job.data),
    { connection, concurrency: config.loyaltyWorkerConcurrency }
  );

  worker.on("completed", (job, result) => {
    log("info", "accrual processed", { jobId: job.id, status: result?.status });
  });
  worker.on("failed", (job, error) => {
    // BullMQ retries per the producer's job options; this fires on each attempt
    // and finally when the job is dead-lettered.
    log("error", "accrual job failed", {
      jobId: job?.id,
      attemptsMade: job?.attemptsMade,
      error: error instanceof Error ? error.message : String(error)
    });

    // GH #467: on the FINAL attempt (no retries left), persist a dead-letter row
    // so a terminally-failed accrual is queryable + replayable instead of being
    // silently lost after queue eviction (a chargeback/fraud forensics gap). The
    // gating + PII-stripping lives in deadLetterRowForFailedAccrual (testable).
    const row = deadLetterRowForFailedAccrual(job, error);
    if (row) {
      void services.prisma.crmDeadLetterJob.create({ data: row }).catch((cause) => {
        // Last-resort visibility: a failed dead-letter write must not crash the
        // worker (it already logged the accrual failure above).
        log("error", "failed to persist crm dead-letter row", {
          jobId: job?.id,
          cause: cause instanceof Error ? cause.message : String(cause)
        });
      });
    }
  });

  log("info", "crm loyalty worker started", {
    queue: CRM_LOYALTY_ACCRUAL_QUEUE,
    concurrency: config.loyaltyWorkerConcurrency
  });

  const shutdown = async () => {
    await worker.close();
    await connection.quit();
    await services.prisma.$disconnect();
  };
  process.on("SIGTERM", () => {
    void shutdown().then(() => process.exit(0));
  });
  process.on("SIGINT", () => {
    void shutdown().then(() => process.exit(0));
  });
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
