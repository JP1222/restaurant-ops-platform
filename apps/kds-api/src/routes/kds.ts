import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { KdsTicketStatus, type Prisma } from "@rop/db-kds";
import {
  KitchenBoardFilterSchema,
  KitchenBoardSettingsSchema,
  TicketActionRequestSchema,
  TicketItemActionRequestSchema,
  TicketLocalEditRequestSchema
} from "@rop/contracts";
import type { AppServices } from "../lib/services.js";
import { seedDemoOrders } from "../lib/demo-orders.js";
import { deleteLocalTicket } from "../lib/local-ticket-delete.js";
import { resetLocalEdit, saveLocalEdit } from "../lib/local-ticket-edit.js";
import { resolveDefaultCloverMerchantId } from "../lib/clover-runtime.js";
import { resolveDisplayMerchant } from "../lib/kds-auth.js";
import { applyActionToTicket, applyActionToTicketItem } from "../lib/sync-order.js";
import { TicketAccessError } from "../lib/ticket-access.js";
import { serializeBoardSettings } from "../lib/board-settings.js";
import { loadBoardSettings, saveBoardSettings } from "../lib/board-settings-service.js";
import { serializeFilter, serializeTicket, ticketSerializationInclude, whereForFilters } from "../lib/ticket-serializer.js";
import { toDisplayTicket } from "../lib/display.js";

type QueryShape = {
  merchantId?: string;
  status?: string;
  since?: string;
  afterSeq?: string;
  limit?: string;
};
type DisplaySnapshotResponse = {
  merchantId: string;
  serverTime: string;
  serverSeq: number;
  display: ReturnType<typeof serializeBoardSettings>["display"];
  tickets: ReturnType<typeof toDisplayTicket>[];
};
type DisplaySnapshotCacheEntry = {
  expiresAt: number;
  value?: DisplaySnapshotResponse;
  pending?: Promise<DisplaySnapshotResponse>;
};

const DISPLAY_SNAPSHOT_CACHE_TTL_MS = 1_000;
// Recently-completed orders stay on the customer pickup display for a few minutes
// (kds-web PICKUP_DISPLAY_WINDOW_MS = 5 min). The snapshot must include them so a
// display reconnect / snapshot refresh doesn't drop pickup orders the realtime
// feed was showing; the extra minute of grace keeps the client window (not this
// server cutoff) the authority on exactly when a tile clears.
const DISPLAY_PICKUP_WINDOW_MS = 6 * 60_000;

function parseStatuses(input: string | undefined) {
  if (!input) {
    return null;
  }

  const statusMap: Record<string, KdsTicketStatus> = {
    new: KdsTicketStatus.NEW,
    on_hold: KdsTicketStatus.ON_HOLD,
    acknowledged: KdsTicketStatus.ACKNOWLEDGED,
    in_progress: KdsTicketStatus.IN_PROGRESS,
    ready: KdsTicketStatus.READY,
    completed: KdsTicketStatus.COMPLETED
  };

  const statuses = input
    .split(",")
    .map((part) => statusMap[part.trim()])
    .filter((status): status is KdsTicketStatus => Boolean(status));

  return statuses.length > 0 ? statuses : null;
}

async function getMerchantId(services: AppServices, requested: string | undefined) {
  return resolveDefaultCloverMerchantId(services.prisma, services.config, requested);
}

// The store a /api/kds/* route operates on.
//
// In production this is ALWAYS `request.kdsMerchantId`, set by the app-level
// preHandler (app.ts → resolveKdsRequestMerchant), which is the authorization
// boundary: a session is pinned to its authorized merchant and a device to its
// bound store. SECURITY (audit-2026-06-03 #470/#471/#472/#473): the query-param
// fallback below is reached ONLY when a test registers this route module
// standalone (no preHandler). It is NOT a production trust path — never rely on
// it to authorize a caller; the preHandler must run for every real /api/kds/*
// request (it does, gated on the `/api/kds/` URL prefix).
async function resolveMerchantId(
  services: AppServices,
  request: FastifyRequest<{ Querystring: QueryShape }>
): Promise<string | null> {
  if (request.kdsMerchantId) {
    return request.kdsMerchantId;
  }
  return getMerchantId(
    services,
    typeof request.query.merchantId === "string" ? request.query.merchantId : undefined
  );
}

// The ticket mutators throw TicketAccessError (404 missing / 403 cross-merchant)
// instead of letting a bare Error bubble to a 500. Map it onto the reply so the
// IDOR rejection is a clean, intentional status. Re-throw anything else.
function replyTicketAccessError(reply: FastifyReply, error: unknown): { error: string } {
  if (error instanceof TicketAccessError) {
    reply.code(error.statusCode);
    return { error: error.message };
  }
  throw error;
}

export async function registerKdsRoutes(app: FastifyInstance, services: AppServices) {
  const displaySnapshotCache = new Map<string, DisplaySnapshotCacheEntry>();

  app.get<{ Querystring: QueryShape }>("/api/kds/tickets", async (request, reply) => {
    const merchantId = await resolveMerchantId(services, request);

    if (!merchantId) {
      reply.code(400);
      return { error: "merchantId is required." };
    }

    const [storedFilter, serverSeq] = await Promise.all([
      services.prisma.kdsFilter.findUnique({
        where: { merchantId }
      }),
      services.hub.currentSeq(merchantId)
    ]);
    const filter = serializeFilter(storedFilter);
    const statuses = parseStatuses(typeof request.query.status === "string" ? request.query.status : undefined);
    const sinceValue = typeof request.query.since === "string" ? new Date(request.query.since) : null;
    const where = whereForFilters(merchantId, filter, statuses, sinceValue);

    if (!filter.includeCompleted) {
      where.status = statuses ? { in: statuses } : { not: KdsTicketStatus.COMPLETED };
    }

    const tickets = await services.prisma.kdsTicket.findMany({
      where: where as Prisma.KdsTicketWhereInput,
      include: ticketSerializationInclude,
      orderBy: [{ priority: "desc" }, { createdAt: "asc" }]
    });

    return {
      merchantId,
      serverTime: new Date().toISOString(),
      serverSeq,
      tickets: tickets.map(serializeTicket),
      filter
    };
  });

  app.get<{ Querystring: QueryShape }>("/api/kds/events", async (request, reply) => {
    const merchantId = await resolveMerchantId(services, request);
    if (!merchantId) {
      reply.code(400);
      return { error: "merchantId is required." };
    }

    const afterSeq = Number(request.query.afterSeq ?? 0);
    const limit = Math.min(
      services.config.kdsRealtimeBackfillLimit,
      Math.max(1, Number(request.query.limit ?? services.config.kdsRealtimeBackfillLimit))
    );
    if (!Number.isInteger(afterSeq) || afterSeq < 0) {
      reply.code(400);
      return { error: "afterSeq must be a non-negative integer." };
    }

    const [state, firstEvent, rows] = await Promise.all([
      services.prisma.kdsRealtimeState.findUnique({
        where: { merchantId },
        select: { seq: true }
      }),
      services.prisma.kdsRealtimeEvent.findFirst({
        where: { merchantId },
        orderBy: { seq: "asc" },
        select: { seq: true }
      }),
      services.prisma.kdsRealtimeEvent.findMany({
        where: {
          merchantId,
          seq: { gt: BigInt(afterSeq) }
        },
        orderBy: { seq: "asc" },
        take: limit
      })
    ]);

    const currentSeq = Number(state?.seq ?? 0n);
    const snapshotRequired = afterSeq > currentSeq
      || Boolean(firstEvent && afterSeq > 0 && BigInt(afterSeq) < firstEvent.seq - 1n);
    return {
      merchantId,
      fromSeq: afterSeq + 1,
      toSeq: currentSeq,
      events: snapshotRequired ? [] : rows.map((row) => row.payload),
      snapshotRequired
    };
  });

  app.post<{ Params: { ticketId: string }; Querystring: QueryShape }>("/api/kds/tickets/:ticketId/actions", async (request, reply) => {
    const merchantId = await resolveMerchantId(services, request);
    if (!merchantId) {
      reply.code(400);
      return { error: "merchantId is required." };
    }
    const body = TicketActionRequestSchema.parse(request.body);
    try {
      return await applyActionToTicket(
        services,
        merchantId,
        request.params.ticketId,
        body.action,
        body.actor,
        body.holdForMinutes ?? null
      );
    } catch (error) {
      return replyTicketAccessError(reply, error);
    }
  });

  app.post<{ Params: { ticketId: string; itemKey: string }; Querystring: QueryShape }>("/api/kds/tickets/:ticketId/items/:itemKey/actions", async (request, reply) => {
    const merchantId = await resolveMerchantId(services, request);
    if (!merchantId) {
      reply.code(400);
      return { error: "merchantId is required." };
    }
    const body = TicketItemActionRequestSchema.parse(request.body);
    try {
      return await applyActionToTicketItem(
        services,
        merchantId,
        request.params.ticketId,
        request.params.itemKey,
        body.action,
        body.actor
      );
    } catch (error) {
      return replyTicketAccessError(reply, error);
    }
  });

  app.put<{ Params: { ticketId: string }; Querystring: QueryShape }>("/api/kds/tickets/:ticketId/local-edit", async (request, reply) => {
    const merchantId = await resolveMerchantId(services, request);
    if (!merchantId) {
      reply.code(400);
      return { error: "merchantId is required." };
    }
    const body = TicketLocalEditRequestSchema.parse(request.body);
    try {
      return await saveLocalEdit(services, merchantId, request.params.ticketId, body);
    } catch (error) {
      return replyTicketAccessError(reply, error);
    }
  });

  app.delete<{ Params: { ticketId: string }; Querystring: QueryShape }>("/api/kds/tickets/:ticketId/local-edit", async (request, reply) => {
    const merchantId = await resolveMerchantId(services, request);
    if (!merchantId) {
      reply.code(400);
      return { error: "merchantId is required." };
    }
    try {
      return await resetLocalEdit(services, merchantId, request.params.ticketId);
    } catch (error) {
      return replyTicketAccessError(reply, error);
    }
  });

  app.delete<{ Params: { ticketId: string }; Querystring: QueryShape }>("/api/kds/tickets/:ticketId", async (request, reply) => {
    const merchantId = await resolveMerchantId(services, request);
    if (!merchantId) {
      reply.code(400);
      return { error: "merchantId is required." };
    }

    let deleted;
    try {
      deleted = await deleteLocalTicket(services, merchantId, request.params.ticketId);
    } catch (error) {
      return replyTicketAccessError(reply, error);
    }

    await services.hub.publishSnapshotRequired(deleted.merchantId, "ticket-deleted");
    return deleted;
  });

  app.get<{ Querystring: QueryShape }>("/api/kds/config", async (request, reply) => {
    const merchantId = await resolveMerchantId(services, request);

    if (!merchantId) {
      reply.code(400);
      return { error: "merchantId is required." };
    }

    const filter = await services.prisma.kdsFilter.findUnique({
      where: { merchantId }
    });

    return serializeFilter(filter);
  });

  app.get<{ Querystring: QueryShape }>("/api/kds/settings", async (request, reply) => {
    const merchantId = await resolveMerchantId(services, request);

    if (!merchantId) {
      reply.code(400);
      return { error: "merchantId is required." };
    }

    return loadBoardSettings(services, merchantId);
  });

  app.put<{ Querystring: QueryShape }>("/api/kds/config", async (request, reply) => {
    const merchantId = await resolveMerchantId(services, request);

    if (!merchantId) {
      reply.code(400);
      return { error: "merchantId is required." };
    }

    const body = KitchenBoardFilterSchema.parse(request.body);

    const saved = await services.prisma.kdsFilter.upsert({
      where: { merchantId },
      update: {
        allowedOrderTypes: body.allowedOrderTypes,
        blockedSources: body.blockedSources,
        paymentStates: body.paymentStates,
        createdAfterMinutes: body.createdAfterMinutes,
        searchText: body.searchText,
        includeCompleted: body.includeCompleted,
        soundEnabled: body.soundEnabled,
        screenPinEnabled: body.screenPinEnabled
      },
      create: {
        merchantId,
        allowedOrderTypes: body.allowedOrderTypes,
        blockedSources: body.blockedSources,
        paymentStates: body.paymentStates,
        createdAfterMinutes: body.createdAfterMinutes,
        searchText: body.searchText,
        includeCompleted: body.includeCompleted,
        soundEnabled: body.soundEnabled,
        screenPinEnabled: body.screenPinEnabled
      }
    });

    return serializeFilter(saved);
  });

  app.put<{ Querystring: QueryShape }>("/api/kds/settings", async (request, reply) => {
    const merchantId = await resolveMerchantId(services, request);

    if (!merchantId) {
      reply.code(400);
      return { error: "merchantId is required." };
    }

    const body = KitchenBoardSettingsSchema.parse(request.body);
    // Iron Law #4 (Floor vs Backoffice): this endpoint has no auth at the
    // kds-api boundary — it is the Floor session's write path identified
    // solely by which route was hit. The internal-bearer Backoffice path
    // is /api/admin/kds/board-settings (admin tier). Pass "floor" so
    // saveBoardSettings strips operator-config + Deliverect fields and
    // never persists them through this entry point.
    return saveBoardSettings(services, merchantId, body, "floor");
  });

  app.post<{ Querystring: QueryShape }>("/api/kds/demo/orders", async (request, reply) => {
    const merchantId = await resolveMerchantId(services, request);

    if (!merchantId) {
      reply.code(400);
      return { error: "merchantId is required." };
    }

    const created = await seedDemoOrders(services, merchantId);
    return {
      ok: true,
      count: created.length
    };
  });

  app.get<{ Querystring: QueryShape }>("/api/display/tickets", async (request, reply) => {
    // Staged on MULTITENANT_MODE (resolveDisplayMerchant): off/observe keep the
    // public ?merchantId= snapshot; enforce requires the paired device token
    // (same-origin cookie) and rejects a mismatched store — closing the IDOR.
    const resolved = await resolveDisplayMerchant(services, request);
    if (resolved.rejected) {
      reply.code(resolved.code);
      return { error: resolved.code === 403 ? "Forbidden" : "Unauthorized" };
    }
    const merchantId = resolved.merchantId;

    if (!merchantId) {
      reply.code(400);
      return { error: "merchantId is required." };
    }

    const now = Date.now();
    const cached = displaySnapshotCache.get(merchantId);
    if (cached?.value && cached.expiresAt > now) {
      return cached.value;
    }
    if (cached?.pending) {
      return cached.pending;
    }

    const pending = (async (): Promise<DisplaySnapshotResponse> => {
      const [tickets, filter, serverSeq] = await Promise.all([
        services.prisma.kdsTicket.findMany({
          where: {
            merchantId,
            OR: [
              { status: { not: KdsTicketStatus.COMPLETED } },
              { status: KdsTicketStatus.COMPLETED, completedAt: { gte: new Date(now - DISPLAY_PICKUP_WINDOW_MS) } }
            ]
          },
          include: {
            items: {
              select: {
                itemKey: true,
                name: true,
                alternateName: true,
                quantity: true,
                refunded: true,
                completed: true
              }
            }
          },
          orderBy: [{ priority: "desc" }, { createdAt: "asc" }]
        }),
        services.prisma.kdsFilter.findUnique({
          where: { merchantId }
        }),
        services.hub.currentSeq(merchantId)
      ]);
      const settings = serializeBoardSettings(filter, null, services.config);

      return {
        merchantId,
        serverTime: new Date().toISOString(),
        serverSeq,
        display: settings.display,
        tickets: tickets.map(toDisplayTicket)
      };
    })();

    displaySnapshotCache.set(merchantId, {
      expiresAt: now + DISPLAY_SNAPSHOT_CACHE_TTL_MS,
      pending
    });

    try {
      const snapshot = await pending;
      displaySnapshotCache.set(merchantId, {
        expiresAt: Date.now() + DISPLAY_SNAPSHOT_CACHE_TTL_MS,
        value: snapshot
      });
      return snapshot;
    } catch (cause) {
      displaySnapshotCache.delete(merchantId);
      throw cause;
    }
  });
}
