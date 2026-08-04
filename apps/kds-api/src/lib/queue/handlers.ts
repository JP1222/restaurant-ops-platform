import { randomUUID } from "node:crypto";
import type { Job } from "bullmq";
import { OrderProvider, ProviderEventStatus, type Prisma } from "@rop/db-kds";
import { runHoldReleaseOnce } from "../../jobs/hold-release.js";
import { runNightlyResetOnce } from "../../jobs/nightly-reset.js";
import { runReconciliationOnce } from "../../jobs/reconciliation.js";
import { contractActionToDb } from "../../domain/state-machine.js";
import { syncDeliverectOrder, syncOrderById, syncSquareOrderById } from "../sync-order.js";
import type { AppServices } from "../services.js";
import { dispatchPendingProviderEvents } from "../provider-ingress.js";
import {
  kdsDeadLetterWriteFailuresTotal,
  kdsQueueWaitSeconds,
  kdsWebhookToBoardSeconds,
  kdsWorkerDurationSeconds
} from "../metrics.js";
import type { RealtimeTrace } from "@rop/contracts";
import { RECONCILE_TICK_MS } from "./bullmq-client.js";
import type { FulfillmentJob, SchedulerJob, SyncOrderJob } from "./bullmq-client.js";

export async function processSyncJob(services: AppServices, job: Job<SyncOrderJob>) {
  const startedAt = Date.now();
  observeQueueWait(job, "sync-order");

  const eventId = job.data.providerEventId;
  if (eventId) {
    await services.prisma.kdsProviderEvent.update({
      where: { id: eventId },
      data: {
        status: ProviderEventStatus.PROCESSING,
        processingStartedAt: new Date(),
        attempts: job.attemptsMade + 1
      }
    });
  }

  try {
    const trace: RealtimeTrace | undefined = job.data.webhookReceivedAt
      ? {
          ...(eventId ? { providerEventId: eventId } : {}),
          webhookReceivedAt: job.data.webhookReceivedAt,
          jobStartedAt: new Date(startedAt).toISOString()
        }
      : undefined;
    const event = await dispatchSyncJob(services, job.data, trace);

    if (eventId) {
      await services.prisma.kdsProviderEvent.update({
        where: { id: eventId },
        data: {
          status: ProviderEventStatus.PROCESSED,
          processedAt: new Date(),
          lastError: null
        }
      });
    }

    if (job.data.webhookReceivedAt) {
      const receivedAt = Date.parse(job.data.webhookReceivedAt);
      if (Number.isFinite(receivedAt)) {
        kdsWebhookToBoardSeconds.observe(
          { provider: job.data.provider.toLowerCase() },
          Math.max(0, Date.now() - receivedAt) / 1000
        );
      }
    }

    kdsWorkerDurationSeconds.observe(
      { queue: job.queueName, job_type: "sync-order", status: "success" },
      (Date.now() - startedAt) / 1000
    );
    return event;
  } catch (error) {
    if (eventId) {
      await services.prisma.kdsProviderEvent.update({
        where: { id: eventId },
        data: {
          status: ProviderEventStatus.FAILED,
          lastError: error instanceof Error ? error.message : "Unknown sync failure"
        }
      });
    }

    kdsWorkerDurationSeconds.observe(
      { queue: job.queueName, job_type: "sync-order", status: "failure" },
      (Date.now() - startedAt) / 1000
    );
    throw error;
  }
}

export async function processFulfillmentJob(services: AppServices, job: Job<FulfillmentJob>) {
  const startedAt = Date.now();
  observeQueueWait(job, "fulfillment");

  const ticket = await services.prisma.kdsTicket.findUnique({
    where: { id: job.data.ticketId },
    select: {
      id: true,
      provider: true,
      merchantId: true,
      cloverOrderId: true,
      sourceOrderId: true,
      status: true,
      lastAction: true,
      lastActor: true,
      updatedAt: true
    }
  });

  if (!ticket || ticket.lastAction !== contractActionToDb(job.data.action)) {
    kdsWorkerDurationSeconds.observe(
      { queue: job.queueName, job_type: "fulfillment", status: "stale" },
      (Date.now() - startedAt) / 1000
    );
    return null;
  }

  try {
    if (ticket.provider === OrderProvider.CLOVER) {
      await services.clover.pushTicketFulfillmentEvent(
        ticket,
        job.data.action,
        new Date(job.data.occurredAt)
      );
    } else if (ticket.provider === OrderProvider.DELIVERECT) {
      await services.deliverect.pushTicketStatus(ticket);
    }

    kdsWorkerDurationSeconds.observe(
      { queue: job.queueName, job_type: "fulfillment", status: "success" },
      (Date.now() - startedAt) / 1000
    );
    return null;
  } catch (error) {
    kdsWorkerDurationSeconds.observe(
      { queue: job.queueName, job_type: "fulfillment", status: "failure" },
      (Date.now() - startedAt) / 1000
    );
    throw error;
  }
}

export async function processSchedulerJob(services: AppServices, job: Job<SchedulerJob>) {
  return withSchedulerLock(services, job.data.task, schedulerLockTtlMs(services, job.data.task), async () => {
    switch (job.data.task) {
      case "reconciliation":
        return runReconciliationOnce(services);
      case "hold-release":
        return runHoldReleaseOnce(services);
      case "nightly-reset":
        return runNightlyResetOnce(services);
      case "dispatch-provider-events":
        return dispatchPendingProviderEvents(services);
      case "dispatch-realtime-events":
        return services.hub.dispatchPending();
      default:
        return null;
    }
  });
}

export async function writeDeadLetterForFailedJob(services: AppServices, job: Job<unknown> | undefined, error: Error) {
  if (!job || job.attemptsMade < (job.opts.attempts ?? 1)) {
    return;
  }

  const data = {
    merchantId: merchantIdForJob(job.data),
    jobType: job.name,
    reason: error.message,
    payload: {
      queue: job.queueName,
      jobId: job.id,
      data: toJsonValue(job.data)
    } as Prisma.InputJsonValue,
    attempts: job.attemptsMade
  };

  // The dead-letter row is the only durable record of a job that exhausted its
  // retries — a single unguarded write would lose it on a transient DB blip
  // (GH #462). Retry a few times, then surface the loss on a metric so it can be
  // alerted rather than vanishing.
  const MAX_ATTEMPTS = 3;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      await services.prisma.deadLetterJob.create({ data });
      return;
    } catch (cause) {
      if (attempt === MAX_ATTEMPTS) {
        kdsDeadLetterWriteFailuresTotal.inc({ job_type: job.name });
        throw cause;
      }
      await new Promise((resolve) => setTimeout(resolve, attempt * 100));
    }
  }
}

// Provider dispatch for a sync job. A switch (not a chain of if/else) so adding a
// provider is one case, not a new branch threaded through processSyncJob.
// `default` = the Clover fetch path (also covers DEMO), preserving prior behavior.
async function dispatchSyncJob(services: AppServices, data: SyncOrderJob, trace: RealtimeTrace | undefined) {
  switch (data.provider) {
    case OrderProvider.DELIVERECT:
      return syncDeliverectJob(services, data);
    case OrderProvider.SQUARE:
      return syncSquareOrderById(
        services,
        data.merchantId,
        data.sourceOrderId,
        data.reason,
        trace ? { trace } : {}
      );
    default:
      return syncOrderById(services, data.merchantId, data.sourceOrderId, data.reason, {
        bucket: data.reason === "reconciliation" ? "recon" : "realtime",
        ...(trace ? { trace } : {})
      });
  }
}

async function syncDeliverectJob(services: AppServices, data: SyncOrderJob) {
  const rawOrder = await resolveRawOrder(services, data);
  return syncDeliverectOrder(services, data.merchantId, rawOrder, data.reason === "manual" ? "manual" : "webhook");
}

async function resolveRawOrder(services: AppServices, data: SyncOrderJob) {
  if (isRecord(data.rawOrder)) {
    return data.rawOrder;
  }
  if (!data.providerEventId) {
    throw new Error("Deliverect sync job is missing raw order payload.");
  }

  const event = await services.prisma.kdsProviderEvent.findUnique({
    where: { id: data.providerEventId },
    select: { raw: true }
  });
  if (!isRecord(event?.raw)) {
    throw new Error("Deliverect provider event is missing raw order payload.");
  }

  return event.raw;
}

function observeQueueWait(job: Job, jobType: string) {
  if (!job.timestamp) {
    return;
  }

  kdsQueueWaitSeconds.observe(
    { queue: job.queueName, job_type: jobType },
    Math.max(0, Date.now() - job.timestamp) / 1000
  );
}

function merchantIdForJob(data: unknown) {
  if (isRecord(data) && typeof data.merchantId === "string") {
    return data.merchantId;
  }
  return null;
}

function toJsonValue(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value ?? null)) as Prisma.InputJsonValue;
}

function schedulerLockTtlMs(services: AppServices, task: SchedulerJob["task"]) {
  switch (task) {
    case "reconciliation":
      // Tick is a fixed floor and each run is short, so keep the crash-recovery
      // TTL small — a crashed reconcile must not block the next tick for long.
      return Math.max(RECONCILE_TICK_MS * 5, 15_000);
    case "nightly-reset":
      return Math.max(services.config.dailyResetCheckIntervalMs * 2, 120_000);
    case "hold-release":
      return 30_000;
    default:
      return 5_000;
  }
}

async function withSchedulerLock<T>(
  services: AppServices,
  task: SchedulerJob["task"],
  ttlMs: number,
  fn: () => Promise<T>
) {
  const key = `kds:scheduler-lock:${task}`;
  const token = randomUUID();
  const acquired = await services.redisPublisher.set(key, token, "PX", ttlMs, "NX");
  if (acquired !== "OK") {
    return null;
  }

  try {
    return await fn();
  } finally {
    const current = await services.redisPublisher.get(key);
    if (current === token) {
      await services.redisPublisher.del(key);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
