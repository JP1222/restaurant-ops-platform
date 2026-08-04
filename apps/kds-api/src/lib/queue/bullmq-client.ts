import { Queue, QueueEvents, type JobsOptions } from "bullmq";
import { Redis } from "ioredis";
import { CRM_LOYALTY_ACCRUAL_QUEUE, type KdsAction, type OrderCompletedEvent } from "@rop/contracts";
import type { OrderProvider, Prisma } from "@rop/db-kds";
import type { AppConfig } from "../../config.js";

export const KDS_QUEUE_NAMES = {
  syncHi: "kds-sync-hi",
  syncLo: "kds-sync-lo",
  fulfillment: "kds-fulfillment",
  scheduler: "kds-scheduler"
} as const;

// Reconciliation fires at this fixed floor; the actual per-merchant cadence is
// gated inside runReconciliationOnce from the operator-tuned board setting
// (read every tick → live, no restart). Must equal RECONCILE_INTERVAL_MIN_SECONDS
// (board-settings.ts) * 1000 so the UI's 3s minimum is reachable.
export const RECONCILE_TICK_MS = 3_000;

export type SyncJobReason = "webhook" | "reconciliation" | "manual";

export type SyncOrderJob = {
  provider: OrderProvider;
  merchantId: string;
  sourceOrderId: string;
  reason: SyncJobReason;
  providerEventId?: string;
  rawOrder?: Prisma.JsonValue;
  webhookReceivedAt?: string;
  idempotencyKey?: string;
  // Correlation id carried from the request that enqueued this job (the
  // backoffice/internal x-request-id), surfaced on the worker's failure log so
  // a failed sync ties back to its origin in Loki. Absent for jobs enqueued
  // outside a request (scheduler dispatch, reconciliation).
  requestId?: string;
};

export type FulfillmentJob = {
  ticketId: string;
  action: KdsAction;
  occurredAt: string;
  ticketUpdatedAt: string;
};

export type SchedulerJob = {
  task: "reconciliation" | "hold-release" | "nightly-reset" | "dispatch-provider-events" | "dispatch-realtime-events";
};

export type QueueDepths = Record<keyof typeof KDS_QUEUE_NAMES, number>;
export type QueueOldestWaitMs = Record<keyof typeof KDS_QUEUE_NAMES, number | null>;

export function createBullMqConnection(redisUrl: string) {
  return new Redis(redisUrl, {
    maxRetriesPerRequest: null
  });
}

export function defaultJobOptions(): JobsOptions {
  return {
    attempts: 5,
    backoff: {
      type: "exponential",
      delay: 500
    },
    removeOnComplete: 1000,
    removeOnFail: 5000
  };
}

export function syncJobId(job: SyncOrderJob) {
  return bullMqSafeId(job.idempotencyKey
    ?? job.providerEventId
    ?? `${job.provider}:${job.merchantId}:${job.sourceOrderId}:${job.reason}`);
}

export function bullMqSafeId(value: string) {
  return value.replaceAll(":", "|");
}

export class KdsQueueClient {
  readonly syncHi: Queue<SyncOrderJob>;
  readonly syncLo: Queue<SyncOrderJob>;
  readonly fulfillment: Queue<FulfillmentJob>;
  readonly scheduler: Queue<SchedulerJob>;
  // Cross-app egress bus: kds-api produces order-completed events here; the
  // crm-api worker consumes them (ADR-0022). Deliberately NOT in
  // KDS_QUEUE_NAMES — it's a write-only hand-off, not a monitored KDS worker
  // queue, so it stays out of depths() / oldestWaitMs() / the QueueEvents loop.
  readonly crmLoyaltyAccrual: Queue<OrderCompletedEvent>;
  readonly events: QueueEvents[];
  private readonly connections: Redis[];

  constructor(config: AppConfig) {
    // BullMQ does NOT take ownership of a connection passed as an ioredis
    // instance — Queue.close() / QueueEvents.close() leave the socket open.
    // Track every connection handed out so close() can quit them explicitly;
    // otherwise they linger and, once the Redis host/container goes away, spam
    // ECONNRESET reconnect attempts forever (maxRetriesPerRequest: null).
    const connections: Redis[] = [];
    const queueConnection = () => {
      const connection = createBullMqConnection(config.redisUrl);
      connections.push(connection);
      return connection;
    };
    this.syncHi = new Queue<SyncOrderJob>(KDS_QUEUE_NAMES.syncHi, { connection: queueConnection() });
    this.syncLo = new Queue<SyncOrderJob>(KDS_QUEUE_NAMES.syncLo, { connection: queueConnection() });
    this.fulfillment = new Queue<FulfillmentJob>(KDS_QUEUE_NAMES.fulfillment, { connection: queueConnection() });
    this.scheduler = new Queue<SchedulerJob>(KDS_QUEUE_NAMES.scheduler, { connection: queueConnection() });
    this.crmLoyaltyAccrual = new Queue<OrderCompletedEvent>(CRM_LOYALTY_ACCRUAL_QUEUE, { connection: queueConnection() });
    this.events = Object.values(KDS_QUEUE_NAMES).map((name) =>
      new QueueEvents(name, { connection: queueConnection() })
    );
    this.connections = connections;
  }

  queueForSyncReason(reason: SyncJobReason) {
    return reason === "reconciliation" ? this.syncLo : this.syncHi;
  }

  async addSync(job: SyncOrderJob, opts: JobsOptions = {}) {
    const queue = this.queueForSyncReason(job.reason);
    await queue.add("sync-order", job, {
      ...defaultJobOptions(),
      jobId: syncJobId(job),
      priority: job.reason === "reconciliation" ? 10 : 1,
      ...opts
    });
  }

  async addSyncBulk(jobs: SyncOrderJob[]) {
    const hiJobs = jobs.filter((job) => job.reason !== "reconciliation");
    const loJobs = jobs.filter((job) => job.reason === "reconciliation");

    await Promise.all([
      hiJobs.length > 0
        ? this.syncHi.addBulk(hiJobs.map((job) => ({
            name: "sync-order",
            data: job,
            opts: {
              ...defaultJobOptions(),
              jobId: syncJobId(job),
              priority: 1
            }
          })))
        : Promise.resolve(),
      loJobs.length > 0
        ? this.syncLo.addBulk(loJobs.map((job) => ({
            name: "sync-order",
            data: job,
            opts: {
              ...defaultJobOptions(),
              jobId: syncJobId(job),
              priority: 10
            }
          })))
        : Promise.resolve()
    ]);
  }

  async addFulfillment(job: FulfillmentJob, opts: JobsOptions = {}) {
    await this.fulfillment.add("push-fulfillment", job, {
      ...defaultJobOptions(),
      jobId: bullMqSafeId(`fulfillment:${job.ticketId}:${job.ticketUpdatedAt}:${job.action}`),
      ...opts
    });
  }

  async addLoyaltyAccrual(event: OrderCompletedEvent) {
    // jobId dedupes a re-emit of the same order + direction while the job is
    // retained; the crm-api consumer's DB UNIQUE(source,sourceId,type) is the
    // durable idempotency guard behind it.
    await this.crmLoyaltyAccrual.add("accrue", event, {
      ...defaultJobOptions(),
      jobId: bullMqSafeId(`loyalty:${event.internalOrderId}:${event.isRefund ? "reverse" : "earn"}`)
    });
  }

  async schedule(config: AppConfig) {
    await Promise.all([
      this.scheduler.add("reconciliation", { task: "reconciliation" }, {
        jobId: "scheduler-reconciliation",
        repeat: { every: RECONCILE_TICK_MS },
        removeOnComplete: true,
        removeOnFail: 100
      }),
      this.scheduler.add("hold-release", { task: "hold-release" }, {
        jobId: "scheduler-hold-release",
        repeat: { every: 5_000 },
        removeOnComplete: true,
        removeOnFail: 100
      }),
      this.scheduler.add("nightly-reset", { task: "nightly-reset" }, {
        jobId: "scheduler-nightly-reset",
        repeat: { every: config.dailyResetCheckIntervalMs },
        removeOnComplete: true,
        removeOnFail: 100
      }),
      this.scheduler.add("dispatch-provider-events", { task: "dispatch-provider-events" }, {
        jobId: "scheduler-dispatch-provider-events",
        repeat: { every: 1_000 },
        removeOnComplete: true,
        removeOnFail: 100
      }),
      this.scheduler.add("dispatch-realtime-events", { task: "dispatch-realtime-events" }, {
        jobId: "scheduler-dispatch-realtime-events",
        repeat: { every: 1_000 },
        removeOnComplete: true,
        removeOnFail: 100
      })
    ]);
  }

  async depths(): Promise<QueueDepths> {
    const [syncHi, syncLo, fulfillment, scheduler] = await Promise.all([
      this.syncHi.count(),
      this.syncLo.count(),
      this.fulfillment.count(),
      this.scheduler.count()
    ]);

    return { syncHi, syncLo, fulfillment, scheduler };
  }

  async oldestWaitMs(): Promise<QueueOldestWaitMs> {
    const oldestForQueue = async (queue: Queue<unknown>) => {
      const jobs = await queue.getJobs(["waiting", "delayed", "prioritized"], 0, 20, true);
      const oldest = jobs.reduce<number | null>((current, job) => {
        if (!job.timestamp) {
          return current;
        }
        const age = Math.max(0, Date.now() - job.timestamp);
        return current === null ? age : Math.max(current, age);
      }, null);
      return oldest;
    };

    const [syncHi, syncLo, fulfillment, scheduler] = await Promise.all([
      oldestForQueue(this.syncHi as Queue<unknown>),
      oldestForQueue(this.syncLo as Queue<unknown>),
      oldestForQueue(this.fulfillment as Queue<unknown>),
      oldestForQueue(this.scheduler as Queue<unknown>)
    ]);

    return { syncHi, syncLo, fulfillment, scheduler };
  }

  async clearForMerchant(merchantId: string) {
    const clearQueue = async (queue: Queue<SyncOrderJob>) => {
      const jobs = await queue.getJobs(["waiting", "delayed", "prioritized", "paused"], 0, 1000);
      await Promise.all(
        jobs
          .filter((job) => job.data.merchantId === merchantId)
          .map((job) => job.remove())
      );
    };

    await Promise.all([clearQueue(this.syncHi), clearQueue(this.syncLo)]);
  }

  async close() {
    await Promise.all([
      this.syncHi.close(),
      this.syncLo.close(),
      this.fulfillment.close(),
      this.scheduler.close(),
      this.crmLoyaltyAccrual.close(),
      ...this.events.map((events) => events.close())
    ]);
    // BullMQ leaves instance-provided connections open (see constructor), so
    // quit them here. quit() drains gracefully; swallow the late error if a
    // connection is already gone so teardown never rejects.
    await Promise.all(this.connections.map((connection) => connection.quit().catch(() => undefined)));
  }
}
