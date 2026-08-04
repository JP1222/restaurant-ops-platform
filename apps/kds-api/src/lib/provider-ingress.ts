import { OrderProvider, ProviderEventStatus, type KdsProviderEvent, type Prisma } from "@rop/db-kds";
import type { AppServices } from "./services.js";
import type { SyncOrderJob } from "./queue.js";

export type ProviderIngressEvent = {
  provider: OrderProvider;
  merchantId: string;
  sourceOrderId: string;
  fingerprint: string;
  topic?: string | null;
  raw: Prisma.InputJsonValue;
  receivedAt?: Date;
};

export async function createProviderEvents(services: AppServices, events: ProviderIngressEvent[]) {
  if (events.length === 0) {
    return [];
  }

  await services.prisma.kdsProviderEvent.createMany({
    data: events.map((event) => ({
      provider: event.provider,
      merchantId: event.merchantId,
      sourceOrderId: event.sourceOrderId,
      fingerprint: event.fingerprint,
      topic: event.topic ?? null,
      raw: event.raw,
      receivedAt: event.receivedAt ?? new Date(),
      status: ProviderEventStatus.RECEIVED
    })),
    skipDuplicates: true
  });

  return services.prisma.kdsProviderEvent.findMany({
    where: {
      fingerprint: {
        in: events.map((event) => event.fingerprint)
      }
    }
  });
}

export async function enqueueProviderEvents(services: AppServices, events: KdsProviderEvent[]) {
  const enqueueable = events.filter((event) =>
    event.status !== ProviderEventStatus.PROCESSED
      && event.status !== ProviderEventStatus.PROCESSING
      && !event.queuedAt
  );
  if (enqueueable.length === 0) {
    return 0;
  }

  const jobs: SyncOrderJob[] = enqueueable.map((event) => {
    const job: SyncOrderJob = {
      provider: event.provider,
      merchantId: event.merchantId,
      sourceOrderId: event.sourceOrderId,
      reason: "webhook",
      providerEventId: event.id,
      webhookReceivedAt: event.receivedAt.toISOString(),
      idempotencyKey: event.id
    };
    if (event.provider === OrderProvider.DELIVERECT) {
      job.rawOrder = event.raw;
    }
    return job;
  });

  await services.queue.enqueueBulk(jobs);
  await services.prisma.kdsProviderEvent.updateMany({
    where: {
      id: {
        in: enqueueable.map((event) => event.id)
      },
      status: ProviderEventStatus.RECEIVED,
      queuedAt: null
    },
    data: {
      status: ProviderEventStatus.QUEUED,
      queuedAt: new Date(),
      lastError: null
    }
  });

  return enqueueable.length;
}

export async function dispatchPendingProviderEvents(services: AppServices, limit = 100) {
  const pending = await services.prisma.kdsProviderEvent.findMany({
    where: {
      queuedAt: null,
      status: ProviderEventStatus.RECEIVED
    },
    orderBy: [{ receivedAt: "asc" }],
    take: limit
  });

  return enqueueProviderEvents(services, pending);
}

export function deliverectFingerprint(merchantId: string, sourceOrderId: string, raw: Record<string, unknown>) {
  const updatedAt = raw.updatedAt ?? raw.createdAt ?? raw.created ?? "unknown";
  return [OrderProvider.DELIVERECT, merchantId, sourceOrderId, updatedAt].join(":");
}
