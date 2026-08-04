import type { CloverMerchant } from "@rop/db-kds";
import type { AppServices } from "./services.js";
import { readActiveWorkerHeartbeats } from "./worker-heartbeat.js";

const LATENCY_WINDOW_MS = 30 * 60_000;
const LATENCY_SAMPLE_LIMIT = 100;

type TimedProbe = {
  ok: boolean;
  pingMs: number | null;
};

function iso(value: Date | null | undefined) {
  return value ? value.toISOString() : null;
}

function percentile(values: number[], percentileValue: number) {
  if (values.length === 0) {
    return null;
  }

  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((percentileValue / 100) * sorted.length) - 1)
  );
  return sorted[index] ?? null;
}

function percentileSet(values: Array<number | null>) {
  const numeric = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  return {
    p50Ms: percentile(numeric, 50),
    p95Ms: percentile(numeric, 95),
    p99Ms: percentile(numeric, 99)
  };
}

async function timedProbe(fn: () => Promise<unknown>): Promise<TimedProbe> {
  const startedAt = performance.now();
  try {
    await fn();
    return {
      ok: true,
      pingMs: Math.round(performance.now() - startedAt)
    };
  } catch {
    return {
      ok: false,
      pingMs: null
    };
  }
}

function healthFromSignals({
  dbOk,
  redisOk,
  workerCount,
  activeQueueDepth,
  deadLettersTotal,
  webhookToBoardP95Ms
}: {
  dbOk: boolean;
  redisOk: boolean;
  workerCount: number;
  activeQueueDepth: number;
  deadLettersTotal: number;
  webhookToBoardP95Ms: number | null;
}) {
  if (
    !dbOk
    || !redisOk
    || workerCount === 0
    || activeQueueDepth > 20
    || deadLettersTotal > 20
    || (webhookToBoardP95Ms !== null && webhookToBoardP95Ms > 10_000)
  ) {
    return "attention" as const;
  }

  if (
    activeQueueDepth > 0
    || deadLettersTotal > 0
    || (webhookToBoardP95Ms !== null && webhookToBoardP95Ms > 3_000)
  ) {
    return "degraded" as const;
  }

  return "healthy" as const;
}

function maxWait(values: Record<string, number | null>) {
  return Object.values(values).reduce<number | null>((current, value) => {
    if (typeof value !== "number") {
      return current;
    }
    return current === null ? value : Math.max(current, value);
  }, null);
}

export async function buildAdminSystemStatus(
  services: AppServices,
  merchant: CloverMerchant | null
) {
  const merchantId = merchant?.id ?? null;
  const latencySince = new Date(Date.now() - LATENCY_WINDOW_MS);
  const dbProbe = await timedProbe(() => services.prisma.$queryRawUnsafe("SELECT 1"));
  const redisProbe = await timedProbe(() => services.redisPublisher.ping());

  const [
    queueDepths,
    oldestWaitMs,
    deadLetterRows,
    recentDeadLetter,
    latencySamples,
    workerHeartbeats
  ] = await Promise.all([
    services.queue.depths(),
    services.queue.oldestWaitMs(),
    services.prisma.deadLetterJob.groupBy({
      by: ["jobType"],
      _count: { _all: true },
      where: {
        ...(merchantId ? { merchantId } : {}),
        resolvedAt: null
      }
    }),
    services.prisma.deadLetterJob.findFirst({
      where: {
        ...(merchantId ? { merchantId } : {}),
        resolvedAt: null
      },
      orderBy: { createdAt: "desc" },
      select: {
        jobType: true,
        reason: true,
        createdAt: true
      }
    }),
    merchantId
      ? services.prisma.kdsRealtimeReceipt.findMany({
          where: {
            merchantId,
            createdAt: { gte: latencySince },
            webhookToRenderMs: { not: null }
          },
          orderBy: { createdAt: "desc" },
          take: LATENCY_SAMPLE_LIMIT,
          select: {
            webhookToRenderMs: true,
            realtimeToBrowserMs: true,
            browserRenderMs: true,
            createdAt: true
          }
        })
      : Promise.resolve([]),
    readActiveWorkerHeartbeats(services.redisPublisher)
  ]);

  const deadLettersTotal = deadLetterRows.reduce((total, row) => total + row._count._all, 0);
  const activeQueueDepth = queueDepths.syncHi + queueDepths.syncLo + queueDepths.fulfillment;
  const webhookToBoard = percentileSet(latencySamples.map((sample) => sample.webhookToRenderMs));
  const realtimeToBrowser = percentileSet(latencySamples.map((sample) => sample.realtimeToBrowserMs));
  const boardRender = percentileSet(latencySamples.map((sample) => sample.browserRenderMs));
  const status = healthFromSignals({
    dbOk: dbProbe.ok,
    redisOk: redisProbe.ok,
    workerCount: workerHeartbeats.length,
    activeQueueDepth,
    deadLettersTotal,
    webhookToBoardP95Ms: webhookToBoard.p95Ms
  });

  return {
    generatedAt: new Date().toISOString(),
    overall: {
      status,
      label: status === "healthy" ? "Healthy" : status === "degraded" ? "Degraded" : "Attention"
    },
    health: {
      api: {
        ok: true,
        uptimeSeconds: Math.round(process.uptime())
      },
      db: dbProbe,
      redis: redisProbe,
      workers: {
        online: workerHeartbeats.length,
        heartbeats: workerHeartbeats
      }
    },
    sync: {
      merchantId,
      authStatus: merchant?.authStatus ?? null,
      webhookStatus: merchant?.webhookStatus ?? null,
      lastWebhookAt: iso(merchant?.lastWebhookAt),
      lastSyncAt: iso(merchant?.lastSyncAt),
      lastReconciledAt: iso(merchant?.lastReconciledAt)
    },
    queues: {
      depths: queueDepths,
      oldestWaitMs
    },
    latency: {
      windowMinutes: 30,
      sampleCount: latencySamples.length,
      empty: latencySamples.length === 0,
      webhookToBoard,
      realtimeToBrowser,
      boardRender
    },
    load: {
      memoryRssMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
      activeQueueDepth,
      oldestQueueWaitMs: maxWait(oldestWaitMs)
    },
    risk: {
      deadLettersTotal,
      deadLettersByType: Object.fromEntries(deadLetterRows.map((row) => [row.jobType, row._count._all])),
      recentDeadLetter: recentDeadLetter
        ? {
            jobType: recentDeadLetter.jobType,
            reason: recentDeadLetter.reason,
            createdAt: recentDeadLetter.createdAt.toISOString()
          }
        : null
    }
  };
}

export function calculateRealtimeReceiptDurations(input: {
  webhookReceivedAt?: Date | null;
  realtimePublishedAt?: Date | null;
  browserReceivedAt: Date;
  renderCommittedAt: Date;
}) {
  return {
    webhookToRenderMs: input.webhookReceivedAt
      ? Math.max(0, input.renderCommittedAt.getTime() - input.webhookReceivedAt.getTime())
      : null,
    realtimeToBrowserMs: input.realtimePublishedAt
      ? Math.max(0, input.browserReceivedAt.getTime() - input.realtimePublishedAt.getTime())
      : null,
    browserRenderMs: Math.max(0, input.renderCommittedAt.getTime() - input.browserReceivedAt.getTime())
  };
}
