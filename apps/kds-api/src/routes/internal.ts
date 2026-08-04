import { RealtimeReceiptRequestSchema } from "@rop/contracts";
import { OrderProvider, Prisma } from "@rop/db-kds";
import type { FastifyInstance } from "fastify";
import { createAdminBearerGuard } from "../lib/admin-bearer-auth.js";
import { resolveDefaultCloverMerchantId } from "../lib/clover-runtime.js";
import { isTrustedWriteOrigin } from "../lib/kds-auth.js";
import {
  kdsBoardRenderSeconds,
  kdsCloverPosToBoardSeconds,
  kdsRealtimeToBrowserSeconds
} from "../lib/metrics.js";
import type { AppServices } from "../lib/services.js";
import { calculateRealtimeReceiptDurations } from "../lib/system-status.js";

function parseDate(value: string | null | undefined) {
  if (!value) {
    return null;
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function traceFromPayload(payload: Prisma.JsonValue) {
  const trace = asRecord(asRecord(payload).trace);
  return {
    providerEventId: typeof trace.providerEventId === "string" ? trace.providerEventId : null,
    webhookReceivedAt: typeof trace.webhookReceivedAt === "string" ? trace.webhookReceivedAt : null,
    realtimePublishedAt: typeof trace.realtimePublishedAt === "string" ? trace.realtimePublishedAt : null
  };
}

export async function registerInternalRoutes(app: FastifyInstance, services: AppServices) {
  // Server-to-server trigger: gate behind the internal admin bearer token, the
  // same guard used across /api/admin/kds/*. The global preHandler in app.ts
  // only authenticates /api/kds/*, so /api/internal/* is otherwise open (GH #455).
  const adminBearer = createAdminBearerGuard(services.config.kdsInternalAdminToken);

  app.post<{ Params: { orderId: string }; Querystring: { merchantId?: string } }>(
    "/api/internal/sync/orders/:orderId",
    { preHandler: adminBearer },
    async (request, reply) => {
      const orderId = request.params.orderId;
      const merchantId = await resolveDefaultCloverMerchantId(
        services.prisma,
        services.config,
        typeof request.query.merchantId === "string" ? request.query.merchantId : undefined
      );
      if (!merchantId) {
        reply.code(400);
        return { error: "merchantId is required." };
      }

      await services.queue.enqueue({
        provider: OrderProvider.CLOVER,
        merchantId,
        sourceOrderId: orderId,
        reason: "manual",
        idempotencyKey: `manual:${merchantId}:${orderId}:${Date.now()}`,
        requestId: request.id
      });
      return {
        ok: true,
        enqueued: true
      };
    }
  );

  app.post("/api/internal/realtime-receipts", async (request, reply) => {
    const origin = isTrustedWriteOrigin(request, services.config.appBaseUrl);
    if (!origin.ok) {
      reply.code(403);
      return { error: "Untrusted origin.", expectedOrigin: origin.expected };
    }

    const parsed = RealtimeReceiptRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "Invalid realtime receipt." };
    }

    const body = parsed.data;
    const browserReceivedAt = parseDate(body.browserReceivedAt);
    const renderCommittedAt = parseDate(body.renderCommittedAt);
    if (!browserReceivedAt || !renderCommittedAt) {
      reply.code(400);
      return { error: "Invalid receipt timestamps." };
    }

    const realtimeEvent = await services.prisma.kdsRealtimeEvent.findUnique({
      where: { id: body.eventId },
      select: {
        payload: true
      }
    });
    const trace = realtimeEvent ? traceFromPayload(realtimeEvent.payload) : {
      providerEventId: null,
      webhookReceivedAt: null,
      realtimePublishedAt: null
    };
    const webhookReceivedAt = parseDate(trace.webhookReceivedAt);
    const realtimePublishedAt = parseDate(trace.realtimePublishedAt);
    const durations = calculateRealtimeReceiptDurations({
      webhookReceivedAt,
      realtimePublishedAt,
      browserReceivedAt,
      renderCommittedAt
    });

    try {
      await services.prisma.kdsRealtimeReceipt.create({
        data: {
          eventId: body.eventId,
          merchantId: body.merchantId,
          ticketId: body.ticketId,
          providerEventId: trace.providerEventId,
          webhookReceivedAt,
          realtimePublishedAt,
          browserReceivedAt,
          renderCommittedAt,
          ...durations
        }
      });
    } catch (cause) {
      if (cause instanceof Prisma.PrismaClientKnownRequestError && cause.code === "P2002") {
        return { ok: true, duplicate: true };
      }
      throw cause;
    }

    if (durations.webhookToRenderMs !== null) {
      kdsCloverPosToBoardSeconds.observe({ provider: "clover" }, durations.webhookToRenderMs / 1000);
    }
    if (durations.realtimeToBrowserMs !== null) {
      kdsRealtimeToBrowserSeconds.observe({ provider: "clover" }, durations.realtimeToBrowserMs / 1000);
    }
    kdsBoardRenderSeconds.observe({ provider: "clover" }, durations.browserRenderMs / 1000);

    return { ok: true };
  });
}
