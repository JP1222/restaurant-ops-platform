import { randomUUID } from "node:crypto";
import type { KdsAction, NormalizedOrder, OrderCompletedEvent, RealtimeEvent, RealtimeTrace, TicketItemActionRequest } from "@rop/contracts";
import {
  KdsAction as DbAction,
  KdsEventSource,
  KdsTicketStatus,
  OrderProvider,
  Prisma,
  type KdsTicket as DbTicket,
  type KdsTicketItem as DbTicketItem,
  type KdsTicketOverride as DbTicketOverride
} from "@rop/db-kds";
import { normalizeDeliverectOrder } from "../domain/normalize-deliverect-order.js";
import { buildSearchText, normalizeOrder } from "../domain/normalize-order.js";
import { normalizeSquareOrder, SQUARE_PAYMENT_STATE_PAID } from "../domain/normalize-square-order.js";
import { resolveSquareStoreCredentials } from "./square-menu.js";
import { contractActionToDb, nextStatus, statusEventType } from "../domain/state-machine.js";
import type { CloverRateBucket } from "./clover-rate-limiter.js";
import { kdsOrderBoardRemovedTotal } from "./metrics.js";
import type { AppServices } from "./services.js";
import { serializeTicket, ticketSerializationInclude } from "./ticket-serializer.js";
import { assertTicketOwnership } from "./ticket-access.js";

type TicketRecord = DbTicket & {
  items: DbTicketItem[];
  localEdit?: DbTicketOverride | null;
  order?: { raw: Prisma.JsonValue; normalized?: Prisma.JsonValue | null } | null;
};

async function lockTicketForItemAction(tx: Prisma.TransactionClient, ticketId: string) {
  await tx.$queryRaw`
    SELECT "id"
    FROM "kds_tickets"
    WHERE "id" = ${ticketId}
    FOR UPDATE
  `;
}

async function refreshTicketStatusForItemCompletion(
  tx: Prisma.TransactionClient,
  ticketId: string,
  now: Date,
  actor: string
) {
  await tx.$executeRaw`
    WITH item_state AS (
      SELECT
        EXISTS (
          SELECT 1
          FROM "kds_ticket_items" AS item
          WHERE item."ticketId" = ${ticketId}
            AND item."refunded" = false
        ) AS "hasActiveItems",
        EXISTS (
          SELECT 1
          FROM "kds_ticket_items" AS item
          WHERE item."ticketId" = ${ticketId}
            AND item."refunded" = false
            AND item."completed" = false
        ) AS "hasIncompleteItems"
    )
    UPDATE "kds_tickets" AS ticket
    SET
      "status" = CASE
        WHEN ticket."status" IN ('COMPLETED', 'ON_HOLD') THEN ticket."status"
        WHEN item_state."hasActiveItems" AND NOT item_state."hasIncompleteItems" THEN 'READY'
        WHEN ticket."status" = 'READY' AND item_state."hasIncompleteItems" THEN 'IN_PROGRESS'
        ELSE ticket."status"
      END,
      "readyAt" = CASE
        WHEN ticket."status" IN ('COMPLETED', 'ON_HOLD') THEN ticket."readyAt"
        WHEN item_state."hasActiveItems" AND NOT item_state."hasIncompleteItems" THEN COALESCE(ticket."readyAt", ${now})
        WHEN ticket."status" = 'READY' AND item_state."hasIncompleteItems" THEN NULL
        ELSE ticket."readyAt"
      END,
      "inProgressAt" = CASE
        WHEN ticket."status" = 'READY' AND item_state."hasIncompleteItems" THEN COALESCE(ticket."inProgressAt", ${now})
        ELSE ticket."inProgressAt"
      END,
      "updatedAt" = ${now},
      "lastActor" = ${actor},
      "lastAction" = 'SYNC'
    FROM item_state
    WHERE ticket."id" = ${ticketId}
  `;
}

function isBeforeResetCutoff(createdAtIso: string, cutoffAt: Date | null | undefined) {
  if (!cutoffAt) {
    return false;
  }

  const createdAt = new Date(createdAtIso);
  if (Number.isNaN(createdAt.getTime())) {
    return false;
  }

  return createdAt < cutoffAt;
}

function dbActionFrom(source: "WEBHOOK" | "RECONCILIATION" | "USER" | "SYSTEM", action: KdsAction) {
  void action;
  return source === "USER"
    ? KdsEventSource.USER
    : source === "RECONCILIATION"
      ? KdsEventSource.RECONCILIATION
      : source === "WEBHOOK"
        ? KdsEventSource.WEBHOOK
        : KdsEventSource.SYSTEM;
}

// Map the POS-neutral contract provider tag onto the Prisma enum. Exported so a
// unit test guards every contract provider against the `default` fallthrough —
// a missing case (e.g. "square" silently becoming CLOVER) is a data-integrity
// bug, not a type error.
export function dbProviderFrom(provider: NormalizedOrder["provider"]) {
  switch (provider) {
    case "deliverect":
      return OrderProvider.DELIVERECT;
    case "demo":
      return OrderProvider.DEMO;
    case "square":
      return OrderProvider.SQUARE;
    case "clover":
      return OrderProvider.CLOVER;
    default:
      return assertUnreachableProvider(provider);
  }
}

// Compile-time exhaustiveness: if a new provider is added to the contract tuple
// without a case above, `provider` is no longer `never` here and TypeScript
// errors at build — so the silent CLOVER fallthrough can't reappear.
function assertUnreachableProvider(provider: never): never {
  throw new Error(`Unhandled order provider: ${String(provider)}`);
}

const UNPAID_CLOVER_PAYMENT_STATES = new Set([
  "OPEN",
  "OPEN_TENDER",
  "LOCKED",
  "PARTIALLY_PAID"
]);

export function shouldSkipForUnpaidState(
  provider: NormalizedOrder["provider"],
  paymentState: NormalizedOrder["paymentState"]
): boolean {
  if (provider === "square") {
    // Square is gated on FULL payment: normalize-square-order sets paymentState to
    // "PAID" iff net_amount_due_money == 0. Anything else (unpaid / partial / open)
    // stays off the board — fail closed.
    return paymentState !== SQUARE_PAYMENT_STATE_PAID;
  }
  if (provider !== "clover") {
    return false;
  }
  if (!paymentState) {
    return false;
  }
  return UNPAID_CLOVER_PAYMENT_STATES.has(paymentState.toUpperCase());
}

// Clover paymentState values that mean the money was returned — the loyalty
// REVERSE path. Distinct from UNPAID_CLOVER_PAYMENT_STATES (those are filtered
// out before we ever reach the emit). Partial refunds are NOT modelled yet
// (full-order reverse only) — a Phase-5 follow-up (see apps/crm-api AGENTS.md).
const REFUNDED_CLOVER_PAYMENT_STATES = new Set(["REFUNDED", "FULLY_REFUNDED"]);

export function isLoyaltyRefund(
  provider: NormalizedOrder["provider"],
  paymentState: NormalizedOrder["paymentState"]
): boolean {
  if (provider !== "clover" || !paymentState) {
    return false;
  }
  return REFUNDED_CLOVER_PAYMENT_STATES.has(paymentState.toUpperCase());
}

function buildInternalOrderId(order: Pick<NormalizedOrder, "provider" | "merchantId" | "sourceOrderId">) {
  return `${order.provider}:${order.merchantId}:${order.sourceOrderId}`;
}

async function publishTicketEvent(
  services: AppServices,
  ticket: TicketRecord,
  previousStatus: KdsTicketStatus | null
) {
  const event: RealtimeEvent = {
    type: previousStatus ? statusEventType(previousStatus, ticket.status) : "ticket.updated",
    merchantId: ticket.merchantId,
    occurredAt: new Date().toISOString(),
    ticket: serializeTicket(ticket)
  };

  return services.hub.publish(ticket.merchantId, event);
}

async function enqueueFulfillmentWriteBack(
  services: AppServices,
  ticket: Pick<TicketRecord, "id" | "merchantId" | "provider" | "updatedAt">,
  action: KdsAction,
  occurredAt: Date
) {
  if (ticket.provider !== OrderProvider.CLOVER && ticket.provider !== OrderProvider.DELIVERECT) {
    return;
  }

  try {
    await services.queue.enqueueFulfillment({
      ticketId: ticket.id,
      action,
      occurredAt: occurredAt.toISOString(),
      ticketUpdatedAt: ticket.updatedAt.toISOString()
    });
  } catch (error) {
    await services.prisma.deadLetterJob.create({
      data: {
        merchantId: ticket.merchantId,
        jobType: "provider-fulfillment-enqueue",
        reason: error instanceof Error ? error.message : "Unknown fulfillment enqueue failure",
        payload: {
          ticketId: ticket.id,
          action,
          ticketUpdatedAt: ticket.updatedAt.toISOString()
        } as Prisma.InputJsonValue
      }
    });
  }
}

// NormalizedOrder → the POS-neutral loyalty event (ADR-0025). The earn BASIS is
// recomputed by the crm engine from these line prices, so we only carry the
// charged-cents per line plus the flags that exclude a line from earning.
//
// ── The two flags below are the business-logic seam ────────────────────────
// isGiftCardPurchase / wasRewardRedemption are hard-coded false here because
// online ordering sells neither yet: gift cards are order-web Phase 2, reward
// redemption is crm Phase 5. When either lands, surface it on
// NormalizedOrderItem (a Clover item category, a redemption marker) and read it
// here — do NOT let an ineligible line silently earn.
export function mapToOrderCompletedEvent(order: NormalizedOrder): OrderCompletedEvent {
  return {
    provider: order.provider,
    merchantId: order.merchantId,
    internalOrderId: buildInternalOrderId(order),
    occurredAt: order.modifiedAt, // provider clock, never server time
    phoneE164: order.customer?.phone ?? null, // loose; the crm worker canonicalizes
    isRefund: isLoyaltyRefund(order.provider, order.paymentState),
    items: order.items.map((item) => ({
      chargedCents: item.priceCents ?? 0,
      isGiftCardPurchase: false,
      wasRewardRedemption: false,
      refunded: item.refunded
    }))
  };
}

// Best-effort hand-off to crm-api loyalty accrual (ADR-0022): a crm-api / Redis
// outage must NEVER block or fail Clover order sync, so an enqueue failure is
// captured to the dead-letter table — exactly like the provider fulfillment
// write-back above. Mirrors that function deliberately.
//
// Online-orders-first gate: emit only when a customer phone is attached.
// In-store / anonymous orders carry no customer, so there is nothing to accrue
// against (the consumer would skip them anyway; gating here keeps the queue free
// of no-op jobs). The paid-vs-unpaid gate is already upstream — unpaid Clover
// orders return before this runs (shouldSkipForUnpaidState).
export async function enqueueLoyaltyWriteBack(services: AppServices, order: NormalizedOrder) {
  if (!order.customer?.phone) {
    return;
  }

  const event = mapToOrderCompletedEvent(order);
  try {
    await services.queue.enqueueLoyaltyAccrual(event);
  } catch (error) {
    await services.prisma.deadLetterJob.create({
      data: {
        merchantId: order.merchantId,
        jobType: "crm-loyalty-accrual-enqueue",
        reason: error instanceof Error ? error.message : "Unknown loyalty enqueue failure",
        // No phone / PII in the dead-letter payload — only the idempotency key
        // and direction, enough to re-drive the accrual by hand.
        payload: {
          internalOrderId: event.internalOrderId,
          isRefund: event.isRefund
        } as Prisma.InputJsonValue
      }
    });
  }
}

async function mergeTicketItems(tx: Prisma.TransactionClient, ticketId: string, order: NormalizedOrder) {
  const itemKeys = order.items.map((item) => item.itemKey);

  await tx.kdsTicketItem.deleteMany({
    where: itemKeys.length > 0
      ? {
          ticketId,
          itemKey: { notIn: itemKeys }
        }
      : { ticketId }
  });

  if (order.items.length === 0) {
    return;
  }

  const now = new Date();
  const rows = order.items.map((item) => Prisma.sql`(
    ${randomUUID()},
    ${ticketId},
    ${item.cloverLineItemId},
    ${item.providerLineItemId ?? item.cloverLineItemId},
    ${item.itemKey},
    ${item.itemId},
    ${item.name},
    ${item.alternateName},
    ${item.note},
    CAST(${JSON.stringify(item.modifiers)} AS jsonb),
    ${item.quantity},
    ${item.refunded},
    ${item.printed},
    ${now},
    ${now}
  )`);

  await tx.$executeRaw(Prisma.sql`
    INSERT INTO "kds_ticket_items" (
      "id",
      "ticketId",
      "cloverLineItemId",
      "providerLineItemId",
      "itemKey",
      "itemId",
      "name",
      "alternateName",
      "note",
      "modifiers",
      "quantity",
      "refunded",
      "printed",
      "createdAt",
      "updatedAt"
    )
    VALUES ${Prisma.join(rows)}
    ON CONFLICT ("ticketId", "itemKey") DO UPDATE SET
      "cloverLineItemId" = EXCLUDED."cloverLineItemId",
      "providerLineItemId" = EXCLUDED."providerLineItemId",
      "itemId" = EXCLUDED."itemId",
      "name" = EXCLUDED."name",
      "alternateName" = EXCLUDED."alternateName",
      "note" = EXCLUDED."note",
      "modifiers" = EXCLUDED."modifiers",
      "quantity" = EXCLUDED."quantity",
      "refunded" = EXCLUDED."refunded",
      "printed" = EXCLUDED."printed",
      "updatedAt" = EXCLUDED."updatedAt"
  `);
}

/**
 * Remove any existing board ticket (and its order row) for an order we will not
 * display. Used by both sync skip-paths: payment regressed to unpaid/voided, or
 * the order predates the daily reset cutoff. The delete is intended — but it
 * used to be a silent `deleteMany`, so a paid order misclassified as unpaid
 * would vanish from the kitchen with no trail (GH #461). We emit a metric + a
 * structured warn line ONLY when a ticket was actually on the board
 * (count > 0); a skip that deleted nothing is the routine "never displayed"
 * case and stays quiet to avoid log noise.
 */
async function removeBoardTicketsForSkippedOrder(
  services: AppServices,
  order: NormalizedOrder,
  internalOrderId: string,
  reason: "unpaid" | "reset_cutoff",
  context: Record<string, unknown>
) {
  const removed = await services.prisma.$transaction(async (tx) => {
    const tickets = await tx.kdsTicket.deleteMany({
      where: {
        merchantId: order.merchantId,
        cloverOrderId: internalOrderId
      }
    });
    await tx.cloverOrder.deleteMany({
      where: {
        merchantId: order.merchantId,
        id: internalOrderId
      }
    });
    return tickets.count;
  });

  if (removed > 0) {
    kdsOrderBoardRemovedTotal.inc({ provider: order.provider, reason }, removed);
    // Structured line to Loki. console.warn matches the worker's logging — the
    // sync path runs in the worker process, which has no Fastify/Pino logger
    // (see worker.ts). Routine zero-delete skips never reach this branch.
    console.warn(
      JSON.stringify({
        level: "warn",
        scope: "kds.sync",
        event: "order_pulled_from_board",
        reason,
        provider: order.provider,
        merchantId: order.merchantId,
        orderId: internalOrderId,
        removedTickets: removed,
        ...context
      })
    );
  }

  return removed;
}

export async function syncNormalizedOrder(
  services: AppServices,
  order: NormalizedOrder,
  rawOrder: Record<string, unknown>,
  reason: "webhook" | "reconciliation" | "manual",
  actor: string,
  options: { trace?: RealtimeTrace } = {}
) {
  const internalOrderId = buildInternalOrderId(order);

  if (shouldSkipForUnpaidState(order.provider, order.paymentState)) {
    await removeBoardTicketsForSkippedOrder(services, order, internalOrderId, "unpaid", {
      paymentState: order.paymentState
    });
    return null;
  }

  const merchant = await services.prisma.cloverMerchant.findUnique({
    where: { id: order.merchantId },
    select: { resetCutoffAt: true }
  });

  if (isBeforeResetCutoff(order.createdAt, merchant?.resetCutoffAt)) {
    await removeBoardTicketsForSkippedOrder(services, order, internalOrderId, "reset_cutoff", {
      createdAt: order.createdAt,
      resetCutoffAt: merchant?.resetCutoffAt ?? null
    });
    return null;
  }

  const searchText = buildSearchText(order);
  const provider = dbProviderFrom(order.provider);

  const ticket = await services.prisma.$transaction(async (tx) => {
    await tx.cloverOrder.upsert({
      where: { id: internalOrderId },
      update: {
        provider,
        raw: rawOrder as Prisma.InputJsonValue,
        normalized: order as Prisma.InputJsonValue,
        clientCreatedAt: new Date(order.createdAt),
        modifiedAt: new Date(order.modifiedAt),
        orderType: order.orderType,
        source: order.source,
        paymentState: order.paymentState,
        syncStatus: "SYNCED",
        lastSyncedAt: new Date(),
        lastEventAt: new Date(),
        lastEventId: reason
      },
      create: {
        id: internalOrderId,
        merchantId: order.merchantId,
        provider,
        raw: rawOrder as Prisma.InputJsonValue,
        normalized: order as Prisma.InputJsonValue,
        clientCreatedAt: new Date(order.createdAt),
        modifiedAt: new Date(order.modifiedAt),
        orderType: order.orderType,
        source: order.source,
        paymentState: order.paymentState,
        syncStatus: "SYNCED",
        lastSyncedAt: new Date(),
        lastEventAt: new Date(),
        lastEventId: reason
      }
    });

    const updatedTicket = await tx.kdsTicket.upsert({
      where: {
        merchantId_provider_sourceOrderId: {
          merchantId: order.merchantId,
          provider,
          sourceOrderId: order.sourceOrderId
        }
      },
      update: {
        provider,
        sourceOrderId: order.sourceOrderId,
        orderLabel: order.orderLabel,
        priority: order.priority,
        note: order.note,
        orderType: order.orderType,
        source: order.source,
        paymentState: order.paymentState,
        searchText
      },
      create: {
        merchantId: order.merchantId,
        provider,
        cloverOrderId: internalOrderId,
        sourceOrderId: order.sourceOrderId,
        orderLabel: order.orderLabel,
        priority: order.priority,
        note: order.note,
        orderType: order.orderType,
        source: order.source,
        paymentState: order.paymentState,
        searchText,
        status: KdsTicketStatus.NEW
      }
    });

    await mergeTicketItems(tx, updatedTicket.id, order);

    return tx.kdsTicket.findUniqueOrThrow({
      where: { id: updatedTicket.id },
      include: ticketSerializationInclude
    });
  });

  void services.prisma.kdsTicketEvent.create({
    data: {
      ticketId: ticket.id,
      merchantId: order.merchantId,
      action: DbAction.SYNC,
      source: reason === "reconciliation" ? KdsEventSource.RECONCILIATION : reason === "webhook" ? KdsEventSource.WEBHOOK : KdsEventSource.USER,
      actor,
      payload: order as Prisma.InputJsonValue
    }
  }).catch(() => undefined);

  void services.prisma.cloverMerchant.update({
    where: { id: order.merchantId },
    data: {
      lastSyncAt: new Date()
    }
  }).catch(() => undefined);

  const dbCommittedAt = new Date().toISOString();
  const event: RealtimeEvent = {
    type: ticket.createdAt.getTime() === ticket.updatedAt.getTime() ? "ticket.created" : "ticket.updated",
    merchantId: order.merchantId,
    occurredAt: new Date().toISOString(),
    ...(options.trace ? { trace: { ...options.trace, dbCommittedAt } } : {}),
    ticket: serializeTicket(ticket)
  };

  // Best-effort loyalty accrual (ADR-0022): emitted AFTER the tx commits, never
  // blocks order sync. Awaited only so an enqueue failure is dead-lettered
  // before we return; the helper itself never throws.
  await enqueueLoyaltyWriteBack(services, order);

  return services.hub.publish(order.merchantId, event);
}

export async function syncOrderById(
  services: AppServices,
  merchantId: string,
  orderId: string,
  reason: "webhook" | "reconciliation" | "manual",
  options: { bucket?: CloverRateBucket; trace?: RealtimeTrace } = {}
) {
  const rawOrder = await services.clover.fetchOrder(merchantId, orderId, options);
  const normalized = normalizeOrder(rawOrder, merchantId);
  return syncNormalizedOrder(
    services,
    normalized,
    rawOrder,
    reason,
    "Clover sync",
    options.trace ? { trace: { ...options.trace, cloverFetchedAt: new Date().toISOString() } } : {}
  );
}

export async function syncDeliverectOrder(
  services: AppServices,
  merchantId: string,
  rawOrder: Record<string, unknown>,
  reason: "webhook" | "manual" = "webhook"
) {
  const normalized = normalizeDeliverectOrder(rawOrder, merchantId);
  return syncNormalizedOrder(services, normalized, rawOrder, reason, "Deliverect sync");
}

// Fetch a Square order fresh and sync it onto the board. `posStoreId` is the
// per-store row id (`square:{location_id}`). The token + environment are resolved
// from its PosAccount (encrypted seam, #750). A null fetch (order vanished) is a
// no-op. The normalized order's payment gate keeps an UNPAID order off the board.
export async function syncSquareOrderById(
  services: AppServices,
  posStoreId: string,
  orderId: string,
  reason: "webhook" | "reconciliation" | "manual",
  options: { trace?: RealtimeTrace } = {}
) {
  const { token, environment } = await resolveSquareStoreCredentials(services.prisma, posStoreId);
  const rawOrder = await services.square.fetchOrder(token, environment, orderId);
  if (!rawOrder) {
    return null;
  }
  const normalized = normalizeSquareOrder(rawOrder, posStoreId);
  return syncNormalizedOrder(
    services,
    normalized,
    rawOrder as unknown as Record<string, unknown>,
    reason,
    "Square sync",
    options.trace ? { trace: options.trace } : {}
  );
}

/**
 * Provider fulfillment events must only be emitted on a real state transition.
 * A replayed action (a client outbox re-sending after a reconnect) lands on an
 * already-applied status, so re-emitting would create a duplicate Clover /
 * Deliverect fulfillment event. The status transitions are themselves
 * idempotent, so gating the write-back on an actual status change makes the
 * whole action idempotent against outbox replays. See docs/decisions/0012.
 */
export function shouldWriteBackFulfillment(
  previousStatus: KdsTicketStatus,
  nextStatusValue: KdsTicketStatus
) {
  return previousStatus !== nextStatusValue;
}

export async function applyActionToTicket(
  services: AppServices,
  merchantId: string,
  ticketId: string,
  action: KdsAction,
  actor: string,
  holdForMinutes?: number | null
) {
  const found = await services.prisma.kdsTicket.findUnique({
    where: { id: ticketId },
    include: ticketSerializationInclude
  });

  // Reject acting on another store's ticket before any status write / fulfillment
  // + loyalty fan-out (audit-2026-06-03 #470).
  const ticket = assertTicketOwnership(found, merchantId);

  const next = nextStatus(ticket.status, action);
  const now = new Date();
  const holdUntil = action === "hold" && holdForMinutes ? new Date(now.getTime() + holdForMinutes * 60_000) : null;

  const updated = await services.prisma.$transaction(async (tx) => {
    const updatedTicket = await tx.kdsTicket.update({
      where: { id: ticketId },
      data: {
        status: next,
        lastActor: actor,
        lastAction: contractActionToDb(action),
        heldAt: action === "hold" ? now : action === "fire" ? null : ticket.heldAt,
        holdUntil: action === "hold" ? holdUntil : action === "fire" ? null : ticket.holdUntil,
        acknowledgedAt: action === "acknowledge" ? now : ticket.acknowledgedAt,
        inProgressAt: action === "start" ? now : ticket.inProgressAt,
        readyAt: action === "ready" || action === "recall" ? now : ticket.readyAt,
        completedAt: action === "complete" || action === "bump" ? now : action === "recall" ? null : ticket.completedAt,
        bumpedAt: action === "bump" ? now : ticket.bumpedAt,
        recalledAt: action === "recall" ? now : ticket.recalledAt
      },
      include: ticketSerializationInclude
    });

    await tx.kdsTicketEvent.create({
      data: {
        ticketId,
        merchantId: ticket.merchantId,
        action: contractActionToDb(action),
        source: dbActionFrom("USER", action),
        actor,
        payload: {
          from: ticket.status,
          to: next,
          holdUntil: holdUntil?.toISOString() ?? null
        } as Prisma.InputJsonValue
      }
    });

    return updatedTicket;
  });

  const event = await publishTicketEvent(services, updated, ticket.status);
  if (shouldWriteBackFulfillment(ticket.status, next)) {
    await enqueueFulfillmentWriteBack(services, updated, action, now);
  }
  return event;
}

export async function applyActionToTicketItem(
  services: AppServices,
  merchantId: string,
  ticketId: string,
  itemKey: string,
  action: TicketItemActionRequest["action"],
  actor: string
) {
  const found = await services.prisma.kdsTicket.findUnique({
    where: { id: ticketId },
    include: ticketSerializationInclude
  });

  // Reject per-item toggles on another store's ticket before any write
  // (audit-2026-06-03 #473).
  const ticket = assertTicketOwnership(found, merchantId);

  const item = ticket.items.find((entry) => entry.itemKey === itemKey);
  if (!item) {
    throw new Error("Ticket item not found.");
  }

  const now = new Date();
  const updated = await services.prisma.$transaction(async (tx) => {
    // Serialize item toggles per ticket so status is derived after prior item writes commit.
    await lockTicketForItemAction(tx, ticketId);

    await tx.kdsTicketItem.update({
      where: {
        ticketId_itemKey: {
          ticketId,
          itemKey
        }
      },
      data: {
        completed: action === "complete",
        completedAt: action === "complete" ? now : null,
        completedBy: action === "complete" ? actor : null
      }
    });

    await refreshTicketStatusForItemCompletion(tx, ticketId, now, actor);

    const updatedTicket = await tx.kdsTicket.findUniqueOrThrow({
      where: { id: ticketId },
      include: ticketSerializationInclude
    });

    await tx.kdsTicketEvent.create({
      data: {
        ticketId,
        merchantId: ticket.merchantId,
        action: DbAction.SYNC,
        source: KdsEventSource.USER,
        actor,
        payload: {
          type: "item-action",
          itemKey,
          action,
          from: ticket.status,
          to: updatedTicket.status
        } as Prisma.InputJsonValue
      }
    });

    return updatedTicket;
  });

  return publishTicketEvent(services, updated, ticket.status);
}

export async function releaseHeldTickets(services: AppServices, merchantId?: string) {
  const dueTickets = await services.prisma.kdsTicket.findMany({
    where: {
      status: KdsTicketStatus.ON_HOLD,
      holdUntil: {
        not: null,
        lte: new Date()
      },
      ...(merchantId ? { merchantId } : {})
    },
    include: ticketSerializationInclude
  });

  for (const ticket of dueTickets) {
    const updated = await services.prisma.$transaction(async (tx) => {
      const nextTicket = await tx.kdsTicket.update({
        where: { id: ticket.id },
        data: {
          status: KdsTicketStatus.NEW,
          lastActor: "Hold timer",
          lastAction: DbAction.FIRE,
          heldAt: null,
          holdUntil: null
        }
      });

      await tx.kdsTicketEvent.create({
        data: {
          ticketId: ticket.id,
          merchantId: ticket.merchantId,
          action: DbAction.FIRE,
          source: KdsEventSource.SYSTEM,
          actor: "Hold timer",
          payload: { from: ticket.status, to: KdsTicketStatus.NEW } as Prisma.InputJsonValue
        }
      });

      return tx.kdsTicket.findUniqueOrThrow({
        where: { id: nextTicket.id },
        include: ticketSerializationInclude
      });
    });

    await publishTicketEvent(services, updated, ticket.status);
    await enqueueFulfillmentWriteBack(services, updated, "fire", new Date());
  }

  return dueTickets.length;
}
