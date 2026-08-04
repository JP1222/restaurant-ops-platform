import type { KdsOverview, KdsTicket, KitchenBoardFilter } from "@rop/contracts";
import {
  OrderProvider,
  type CloverMerchant,
  type KdsTicketStatus as DbStatus,
  type KdsFilter,
  type KdsTicket as DbTicket,
  type KdsTicketItem as DbTicketItem,
  type KdsTicketOverride as DbTicketOverride
} from "@rop/db-kds";
import type { Prisma } from "@rop/db-kds";
import { dbStatusToContract } from "../domain/state-machine.js";

type JsonRecord = Record<string, unknown>;
type TicketRecord = DbTicket & {
  items: DbTicketItem[];
  localEdit?: DbTicketOverride | null;
  order?: { raw: Prisma.JsonValue; normalized?: Prisma.JsonValue | null } | null;
};

export const ticketSerializationInclude = {
  items: true,
  localEdit: true,
  order: {
    select: {
      raw: true,
      normalized: true
    }
  }
} satisfies Prisma.KdsTicketInclude;

function asRecord(value: unknown): JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function asString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function providerOrderLabel(ticket: TicketRecord) {
  const raw = asRecord(ticket.order?.raw);
  const normalized = asRecord(ticket.order?.normalized);
  const displayCode =
    asString(raw.displayCode) ??
    asString(raw.title) ??
    asString(raw.orderNumber) ??
    asString(normalized.orderLabel);

  if (!displayCode) {
    return null;
  }

  return `#${displayCode.replace(/^#/, "")}`;
}

function iso(value: Date | null | undefined) {
  return value ? value.toISOString() : null;
}

function sortTicketItems(items: DbTicketItem[]) {
  return [...items].sort((left, right) => {
    const createdAtDelta = left.createdAt.getTime() - right.createdAt.getTime();
    if (createdAtDelta !== 0) {
      return createdAtDelta;
    }

    return left.id.localeCompare(right.id);
  });
}

export function serializeFilter(filter: KdsFilter | null | undefined): KitchenBoardFilter {
  return {
    allowedOrderTypes: Array.isArray(filter?.allowedOrderTypes) ? (filter.allowedOrderTypes as string[]) : [],
    blockedSources: Array.isArray(filter?.blockedSources) ? (filter.blockedSources as string[]) : [],
    paymentStates: Array.isArray(filter?.paymentStates) ? (filter.paymentStates as string[]) : [],
    createdAfterMinutes: filter?.createdAfterMinutes ?? null,
    searchText: filter?.searchText ?? "",
    includeCompleted: filter?.includeCompleted ?? false,
    soundEnabled: filter?.soundEnabled ?? true,
    screenPinEnabled: filter?.screenPinEnabled ?? false
  };
}

export function serializeTicket(ticket: TicketRecord): KdsTicket {
  const createdAt = ticket.createdAt.toISOString();
  const elapsedMinutes = Math.max(0, Math.round((Date.now() - ticket.createdAt.getTime()) / 60_000));
  const fallbackSourceOrderId = ticket.sourceOrderId || ticket.cloverOrderId;
  const fallbackOrderLabel = providerOrderLabel(ticket) ?? ticket.orderLabel ?? `#${fallbackSourceOrderId.slice(-6).toUpperCase()}`;
  const localEdit = ticket.localEdit ?? null;
  const provider = ticket.provider === OrderProvider.DELIVERECT
    ? "deliverect"
    : ticket.provider === OrderProvider.DEMO
      ? "demo"
      : "clover";

  return {
    id: ticket.id,
    merchantId: ticket.merchantId,
    provider,
    cloverOrderId: ticket.cloverOrderId,
    sourceOrderId: ticket.sourceOrderId,
    orderLabel: localEdit?.orderLabel ?? fallbackOrderLabel,
    status: dbStatusToContract(ticket.status),
    priority: ticket.priority,
    source: ticket.source,
    orderType: ticket.orderType,
    paymentState: ticket.paymentState,
    note: localEdit?.note ?? ticket.note,
    lastActor: ticket.lastActor,
    heldAt: iso(ticket.heldAt),
    holdUntil: iso(ticket.holdUntil),
    displayChannelLabel: localEdit?.channelLabel ?? null,
    displayFulfillmentTimeLabel: localEdit?.fulfillmentTimeLabel ?? null,
    hasLocalEdits: Boolean(localEdit),
    createdAt,
    updatedAt: ticket.updatedAt.toISOString(),
    elapsedMinutes,
    items: sortTicketItems(ticket.items).map((item) => ({
      id: item.id,
      cloverLineItemId: item.cloverLineItemId,
      providerLineItemId: item.providerLineItemId,
      itemKey: item.itemKey,
      itemId: item.itemId,
      name: item.name,
      alternateName: item.alternateName,
      note: item.note,
      modifiers: Array.isArray(item.modifiers) ? (item.modifiers as string[]) : [],
      quantity: item.quantity,
      refunded: item.refunded,
      printed: item.printed,
      completed: item.completed,
      completedAt: iso(item.completedAt),
      completedBy: item.completedBy
    }))
  };
}

export function serializeOverview(
  merchant: CloverMerchant | null,
  ticketCounts: Record<DbStatus, number>,
  deadLetterCount: number
): KdsOverview {
  return {
    merchantId: merchant?.id ?? "",
    authStatus: merchant?.authStatus ?? "PENDING",
    lastWebhookAt: iso(merchant?.lastWebhookAt),
    lastSyncAt: iso(merchant?.lastSyncAt),
    lastReconciledAt: iso(merchant?.lastReconciledAt),
    webhookStatus: merchant?.webhookStatus ?? null,
    deadLetterCount,
    ticketCounts: {
      new: ticketCounts.NEW ?? 0,
      on_hold: ticketCounts.ON_HOLD ?? 0,
      acknowledged: ticketCounts.ACKNOWLEDGED ?? 0,
      in_progress: ticketCounts.IN_PROGRESS ?? 0,
      ready: ticketCounts.READY ?? 0,
      completed: ticketCounts.COMPLETED ?? 0
    },
    kdsPin: merchant?.kdsPin ?? null
  };
}

export function whereForFilters(
  merchantId: string,
  filter: KitchenBoardFilter,
  statuses: DbStatus[] | null,
  since: Date | null
): Prisma.KdsTicketWhereInput {
  const where: Prisma.KdsTicketWhereInput = { merchantId };

  if (since) {
    where.updatedAt = { gte: since };
  }
  if (statuses) {
    where.status = { in: statuses };
  }
  if (filter.allowedOrderTypes.length > 0) {
    where.orderType = { in: filter.allowedOrderTypes };
  }
  if (filter.blockedSources.length > 0) {
    where.source = { notIn: filter.blockedSources };
  }
  if (filter.paymentStates.length > 0) {
    where.paymentState = { in: filter.paymentStates };
  }
  if (filter.createdAfterMinutes) {
    where.createdAt = { gte: new Date(Date.now() - filter.createdAfterMinutes * 60_000) };
  }
  if (filter.searchText) {
    where.searchText = {
      contains: filter.searchText.toLowerCase(),
      mode: "insensitive"
    };
  }

  return where;
}
