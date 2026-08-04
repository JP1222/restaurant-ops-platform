import type { RealtimeEvent } from "@rop/contracts";
import type { KdsTicketItem, KdsTicketStatus as DbStatus } from "@rop/db-kds";
import { dbStatusToContract } from "../domain/state-machine.js";

export type DisplayTicketItem = {
  itemKey: string;
  name: string;
  alternateName: string | null;
  quantity: number;
  refunded: boolean;
  completed: boolean;
};

export type DisplayTicket = {
  id: string;
  merchantId: string;
  orderLabel: string;
  sourceOrderId: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  items: DisplayTicketItem[];
};

export type DisplayEvent = {
  id?: string;
  type: RealtimeEvent["type"];
  merchantId: string;
  occurredAt: string;
  seq?: number;
  publishedAt?: string;
  ticket: DisplayTicket;
};

export function toDisplayTicket(ticket: {
  id: string;
  merchantId: string;
  orderLabel: string | null;
  sourceOrderId: string;
  status: DbStatus;
  createdAt: Date;
  updatedAt: Date;
  items: Pick<KdsTicketItem, "itemKey" | "name" | "alternateName" | "quantity" | "refunded" | "completed">[];
}): DisplayTicket {
  return {
    id: ticket.id,
    merchantId: ticket.merchantId,
    orderLabel: ticket.orderLabel ?? ticket.sourceOrderId,
    sourceOrderId: ticket.sourceOrderId,
    status: dbStatusToContract(ticket.status),
    createdAt: ticket.createdAt.toISOString(),
    updatedAt: ticket.updatedAt.toISOString(),
    items: ticket.items.map((item) => ({
      name: item.name,
      alternateName: item.alternateName ?? null,
      itemKey: item.itemKey,
      quantity: item.quantity,
      refunded: item.refunded,
      completed: item.completed
    }))
  };
}

export function toDisplayEvent(event: RealtimeEvent): DisplayEvent {
  return {
    ...(event.id ? { id: event.id } : {}),
    type: event.type,
    merchantId: event.merchantId,
    occurredAt: event.occurredAt,
    ...(typeof event.seq === "number" ? { seq: event.seq } : {}),
    ...(event.publishedAt ? { publishedAt: event.publishedAt } : {}),
    ticket: {
      id: event.ticket.id,
      merchantId: event.ticket.merchantId,
      orderLabel: event.ticket.orderLabel,
      sourceOrderId: event.ticket.sourceOrderId,
      status: event.ticket.status,
      createdAt: event.ticket.createdAt,
      updatedAt: event.ticket.updatedAt,
      items: event.ticket.items.map((item) => ({
        itemKey: item.itemKey,
        name: item.name,
        alternateName: item.alternateName,
        quantity: item.quantity,
        refunded: item.refunded,
        completed: item.completed
      }))
    }
  };
}
