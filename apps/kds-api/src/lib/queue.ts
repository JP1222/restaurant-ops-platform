import type { OrderCompletedEvent } from "@rop/contracts";
import { OrderProvider } from "@rop/db-kds";
import { KdsQueueClient, type SyncJobReason, type SyncOrderJob } from "./queue/bullmq-client.js";
import type { AppConfig } from "../config.js";

export type { FulfillmentJob, QueueDepths, QueueOldestWaitMs, SchedulerJob, SyncOrderJob } from "./queue/bullmq-client.js";

export class SyncQueue {
  private readonly client: KdsQueueClient;

  constructor(config: AppConfig) {
    this.client = new KdsQueueClient(config);
  }

  get queues() {
    return this.client;
  }

  async enqueue(job: {
    merchantId: string;
    orderId?: string;
    sourceOrderId?: string;
    reason: string;
    attempts?: number;
    provider?: OrderProvider;
    providerEventId?: string;
    rawOrder?: SyncOrderJob["rawOrder"];
    webhookReceivedAt?: string;
    idempotencyKey?: string;
    requestId?: string;
  }) {
    const syncJob: SyncOrderJob = {
      provider: job.provider ?? OrderProvider.CLOVER,
      merchantId: job.merchantId,
      sourceOrderId: job.sourceOrderId ?? job.orderId ?? "",
      reason: normalizeReason(job.reason)
    };
    if (job.requestId) {
      syncJob.requestId = job.requestId;
    }
    if (job.providerEventId) {
      syncJob.providerEventId = job.providerEventId;
    }
    if (job.rawOrder !== undefined) {
      syncJob.rawOrder = job.rawOrder;
    }
    if (job.webhookReceivedAt) {
      syncJob.webhookReceivedAt = job.webhookReceivedAt;
    }
    if (job.idempotencyKey) {
      syncJob.idempotencyKey = job.idempotencyKey;
    }
    await this.client.addSync(syncJob);
  }

  async enqueueBulk(jobs: SyncOrderJob[]) {
    await this.client.addSyncBulk(jobs);
  }

  async enqueueFulfillment(job: Parameters<KdsQueueClient["addFulfillment"]>[0]) {
    await this.client.addFulfillment(job);
  }

  async enqueueLoyaltyAccrual(event: OrderCompletedEvent) {
    await this.client.addLoyaltyAccrual(event);
  }

  async clearForMerchant(merchantId: string) {
    await this.client.clearForMerchant(merchantId);
  }

  async depths() {
    return this.client.depths();
  }

  async oldestWaitMs() {
    return this.client.oldestWaitMs();
  }

  async schedule(config: AppConfig) {
    await this.client.schedule(config);
  }

  async close() {
    await this.client.close();
  }
}

function normalizeReason(reason: string): SyncJobReason {
  return reason === "reconciliation"
    ? "reconciliation"
    : reason === "manual"
      ? "manual"
      : "webhook";
}
