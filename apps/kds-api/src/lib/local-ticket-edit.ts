import type { RealtimeEvent, TicketLocalEditRequest } from "@rop/contracts";
import type { Prisma } from "@rop/db-kds";
import {
  KdsAction as DbAction,
  KdsEventSource,
  type KdsTicket as DbTicket,
  type KdsTicketItem as DbTicketItem,
  type KdsTicketOverride as DbTicketOverride
} from "@rop/db-kds";
import type { AppServices } from "./services.js";
import { serializeTicket, ticketSerializationInclude } from "./ticket-serializer.js";
import { assertTicketOwnership } from "./ticket-access.js";

type TicketRecord = DbTicket & {
  items: DbTicketItem[];
  localEdit?: DbTicketOverride | null;
  order?: { raw: Prisma.JsonValue; normalized?: Prisma.JsonValue | null } | null;
};

function trimNullable(value: string) {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function rawOrderChannel(ticket: Pick<TicketRecord, "source" | "orderType">) {
  return ticket.source ?? ticket.orderType ?? "Kitchen queue";
}

function deriveEditableOrderMeta(ticket: Pick<TicketRecord, "source" | "orderType">) {
  const source = ticket.source?.trim() ?? "";
  const orderType = ticket.orderType?.trim() ?? "";

  if (source && orderType && source.toLowerCase().startsWith(orderType.toLowerCase())) {
    const remainder = source.slice(orderType.length).trim();
    const timeMatch = remainder.match(/^at\s+(.+)$/i);
    const fulfillmentTimeLabel = timeMatch?.[1]?.trim();
    if (fulfillmentTimeLabel) {
      return {
        channelLabel: orderType,
        fulfillmentTimeLabel
      };
    }
  }

  return {
    channelLabel: rawOrderChannel(ticket),
    fulfillmentTimeLabel: null as string | null
  };
}

export function buildLocalEditValues(ticket: TicketRecord, body: TicketLocalEditRequest) {
  const orderLabel = body.orderLabel.trim();
  const channelLabel = trimNullable(body.channelLabel);
  const fulfillmentTimeLabel = trimNullable(body.fulfillmentTimeLabel);
  const note = body.note.trim();
  const fallbackSourceOrderId = ticket.sourceOrderId || ticket.cloverOrderId;
  const fallbackOrderLabel = ticket.orderLabel ?? `#${fallbackSourceOrderId.slice(-6).toUpperCase()}`;
  const fallbackMeta = deriveEditableOrderMeta(ticket);
  const fallbackChannelLabel = fallbackMeta.channelLabel;
  const fallbackFulfillmentTimeLabel = fallbackMeta.fulfillmentTimeLabel;
  const fallbackNote = ticket.note ?? "";
  const nextChannelLabel = channelLabel ?? fallbackChannelLabel;

  const needsOverride = orderLabel !== fallbackOrderLabel
    || note !== fallbackNote
    || fulfillmentTimeLabel !== fallbackFulfillmentTimeLabel
    || nextChannelLabel !== fallbackChannelLabel;

  return {
    needsOverride,
    values: {
      orderLabel,
      channelLabel: nextChannelLabel === fallbackChannelLabel && fulfillmentTimeLabel === fallbackFulfillmentTimeLabel ? null : nextChannelLabel,
      fulfillmentTimeLabel: fulfillmentTimeLabel === fallbackFulfillmentTimeLabel ? null : fulfillmentTimeLabel,
      note
    }
  };
}

function createRealtimeTicketUpdate(ticket: TicketRecord): RealtimeEvent {
  return {
    type: "ticket.updated",
    merchantId: ticket.merchantId,
    occurredAt: new Date().toISOString(),
    ticket: serializeTicket(ticket)
  };
}

export async function saveLocalEdit(
  services: AppServices,
  merchantId: string,
  ticketId: string,
  body: TicketLocalEditRequest
) {
  const found = await services.prisma.kdsTicket.findUnique({
    where: { id: ticketId },
    include: ticketSerializationInclude
  });

  // Reject editing another store's ticket metadata before any override write
  // (audit-2026-06-03 #471).
  const ticket = assertTicketOwnership(found, merchantId);

  const next = buildLocalEditValues(ticket, body);

  const updated = await services.prisma.$transaction(async (tx) => {
    if (next.needsOverride) {
      await tx.kdsTicketOverride.upsert({
        where: { ticketId },
        update: {
          orderLabel: next.values.orderLabel,
          channelLabel: next.values.channelLabel,
          fulfillmentTimeLabel: next.values.fulfillmentTimeLabel,
          note: next.values.note
        },
        create: {
          ticketId,
          merchantId: ticket.merchantId,
          orderLabel: next.values.orderLabel,
          channelLabel: next.values.channelLabel,
          fulfillmentTimeLabel: next.values.fulfillmentTimeLabel,
          note: next.values.note
        }
      });
    } else {
      await tx.kdsTicketOverride.deleteMany({
        where: { ticketId }
      });
    }

    await tx.kdsTicket.update({
      where: { id: ticketId },
      data: {
        searchText: ticket.searchText,
        updatedAt: new Date()
      }
    });

    await tx.kdsTicketEvent.create({
      data: {
        ticketId,
        merchantId: ticket.merchantId,
        action: DbAction.SYNC,
        source: KdsEventSource.USER,
        actor: "Kitchen edit",
        payload: {
          type: "local-edit",
          values: next.needsOverride ? next.values : null
        } as Prisma.InputJsonValue
      }
    });

    return tx.kdsTicket.findUniqueOrThrow({
      where: { id: ticketId },
      include: ticketSerializationInclude
    });
  });

  const event = createRealtimeTicketUpdate(updated);
  return services.hub.publish(updated.merchantId, event);
}

export async function resetLocalEdit(services: AppServices, merchantId: string, ticketId: string) {
  const found = await services.prisma.kdsTicket.findUnique({
    where: { id: ticketId },
    include: ticketSerializationInclude
  });

  // Reject clearing another store's ticket override before any delete
  // (audit-2026-06-03 #471).
  const ticket = assertTicketOwnership(found, merchantId);

  if (!ticket.localEdit) {
    return createRealtimeTicketUpdate(ticket);
  }

  const updated = await services.prisma.$transaction(async (tx) => {
    await tx.kdsTicketOverride.delete({
      where: { ticketId }
    });

    await tx.kdsTicket.update({
      where: { id: ticketId },
      data: {
        searchText: ticket.searchText,
        updatedAt: new Date()
      }
    });

    await tx.kdsTicketEvent.create({
      data: {
        ticketId,
        merchantId: ticket.merchantId,
        action: DbAction.SYNC,
        source: KdsEventSource.USER,
        actor: "Kitchen edit",
        payload: {
          type: "local-edit-reset"
        } as Prisma.InputJsonValue
      }
    });

    return tx.kdsTicket.findUniqueOrThrow({
      where: { id: ticketId },
      include: ticketSerializationInclude
    });
  });

  const event = createRealtimeTicketUpdate(updated);
  return services.hub.publish(updated.merchantId, event);
}
