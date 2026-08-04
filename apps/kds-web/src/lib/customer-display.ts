import type { KdsTicket } from "@rop/contracts";

export type DisplayLikeTicket = Pick<KdsTicket, "id" | "merchantId" | "orderLabel" | "sourceOrderId" | "status" | "createdAt" | "updatedAt"> & {
  items: Array<Pick<KdsTicket["items"][number], "itemKey" | "alternateName" | "name" | "refunded" | "completed" | "quantity">>;
};
export type DisplayLikeRealtimeEvent = {
  occurredAt: string;
  ticket: DisplayLikeTicket;
  merchantId: string;
  type: string;
};

export type CustomerAnnouncement = {
  id: string;
  itemKeys: string[];
  orderLabel: string;
  itemNames: string[];
  spokenText: string;
  occurredAt: string;
  status: DisplayLikeTicket["status"];
};

export type CustomerDisplayItemGroup = {
  name: string;
  total: number;
  ready: number;
  pending: number;
};

// Statuses that mean "still being prepared" — shown in the Preparing column with
// no time limit (until the kitchen finishes the order).
const preparingStatuses = new Set<DisplayLikeTicket["status"]>(["new", "on_hold", "acknowledged", "in_progress"]);

// A ready/completed order lingers in the "Ready for Pickup" column for this long
// — measured from when THIS display first saw it become ready, not the server
// `updatedAt` (which can be old on a snapshot/reconnect). The kds-api display
// snapshot keeps a comparable server-side window so a reconnect doesn't drop
// pickup orders the realtime feed was showing.
export const PICKUP_DISPLAY_WINDOW_MS = 5 * 60_000;

function itemDisplayName(item: DisplayLikeTicket["items"][number]) {
  const name = item.name.trim();
  const alternateName = item.alternateName?.trim() ?? "";

  if (alternateName && !/^special\s*#?\s*\d+$/i.test(alternateName)) {
    return alternateName;
  }

  return name || alternateName;
}

function itemAnnouncementKey(ticketId: string, item: Pick<DisplayLikeTicket["items"][number], "itemKey">) {
  return `${ticketId}:${item.itemKey}`;
}

export function completedItemAnnouncementKeys(ticket: Pick<DisplayLikeTicket, "id" | "items">) {
  return ticket.items
    .filter((item) => !item.refunded && item.completed)
    .map((item) => itemAnnouncementKey(ticket.id, item));
}

export function releaseStaleAnnouncementKeys(
  ticket: Pick<DisplayLikeTicket, "id" | "items" | "status">,
  announcedItemKeys: Set<string>
) {
  for (const item of ticket.items) {
    if (item.refunded || !item.completed) {
      announcedItemKeys.delete(itemAnnouncementKey(ticket.id, item));
    }
  }
}

export function isPickupReady(ticket: Pick<DisplayLikeTicket, "items" | "status">) {
  const activeItems = ticket.items.filter((item) => !item.refunded);
  if (activeItems.length === 0) {
    return false;
  }

  return activeItems.every((item) => item.completed);
}

// A ticket is "ready for pickup" once the kitchen finishes it. The board's
// done/bump action sets status → "completed" (the "ready" status exists in the
// state machine but the board doesn't surface a separate button), so "completed"
// is the primary signal here; we also honor an explicit "ready" status and the
// all-items-checked path so either kitchen workflow lights up the pickup column.
export function isReadyForPickup(ticket: Pick<DisplayLikeTicket, "items" | "status">) {
  return ticket.status === "ready" || ticket.status === "completed" || isPickupReady(ticket);
}

// True once a ready-for-pickup order has been on screen past the pickup window
// and should be cleared. `readySinceMs` is the client-clock time the display
// first saw the order become ready (see customer-display-screen.tsx); we expire
// on time-on-screen rather than server `updatedAt` so an order with an old
// timestamp (snapshot/reconnect, fixed test fixtures) still shows when it lands.
export function pickupWindowExpired(readySinceMs: number, now: number) {
  return now - readySinceMs >= PICKUP_DISPLAY_WINDOW_MS;
}

export function pickCustomerVisibleTickets(tickets: DisplayLikeTicket[], limit = 8) {
  return tickets
    .filter((ticket) => isReadyForPickup(ticket) || preparingStatuses.has(ticket.status))
    .toSorted((left, right) => {
      const leftReady = isReadyForPickup(left);
      const rightReady = isReadyForPickup(right);
      if (leftReady !== rightReady) {
        return leftReady ? -1 : 1; // ready-for-pickup orders lead
      }

      if (leftReady) {
        // Most-recently-finished first, so a just-bumped order lands at the top.
        return right.updatedAt.localeCompare(left.updatedAt);
      }

      // Preparing: oldest first, so the longest-waiting order leads.
      return left.createdAt.localeCompare(right.createdAt);
    })
    .slice(0, limit);
}

export function customerDisplayItemGroups(ticket: Pick<DisplayLikeTicket, "items">) {
  const groups = new Map<string, CustomerDisplayItemGroup>();

  for (const item of ticket.items) {
    if (item.refunded) {
      continue;
    }

    const name = itemDisplayName(item);
    if (!name) {
      continue;
    }

    const quantity = Math.max(1, item.quantity);
    const current = groups.get(name) ?? {
      name,
      total: 0,
      ready: 0,
      pending: 0
    };

    current.total += quantity;
    if (item.completed) {
      current.ready += quantity;
    } else {
      current.pending += quantity;
    }
    groups.set(name, current);
  }

  return [...groups.values()];
}

export function itemNamesForAnnouncement(
  ticket: Pick<DisplayLikeTicket, "items">,
  limit = 3,
  includeIncomplete = false
) {
  const names: string[] = [];

  for (const item of ticket.items) {
    if (item.refunded || (!includeIncomplete && !item.completed)) {
      continue;
    }

    const name = itemDisplayName(item);
    if (!name || names.includes(name)) {
      continue;
    }

    names.push(name);
    if (names.length >= limit) {
      break;
    }
  }

  return names;
}

export function buildAnnouncementText(
  ticket: Pick<DisplayLikeTicket, "orderLabel" | "items">,
  includeIncompleteItems = false
) {
  const orderLabel = ticket.orderLabel || "your order";
  const itemNames = itemNamesForAnnouncement(ticket, 3, includeIncompleteItems);
  const itemText = itemNames.length > 0 ? ` ${itemNames.join(", ")}.` : "";
  return `Order ${orderLabel} is ready.${itemText}`;
}

export function announcementFromEvent(
  event: DisplayLikeRealtimeEvent,
  announcedItemKeys: ReadonlySet<string>
): CustomerAnnouncement | null {
  const announceCompletedOrder = event.ticket.status === "completed";
  const newlyReadyItems = event.ticket.items.filter((item) => {
    if (item.refunded || announcedItemKeys.has(itemAnnouncementKey(event.ticket.id, item))) {
      return false;
    }

    return announceCompletedOrder || item.completed;
  });

  if (newlyReadyItems.length === 0) {
    return null;
  }

  const itemNames = itemNamesForAnnouncement({ items: newlyReadyItems }, 3, announceCompletedOrder);

  return {
    id: event.ticket.id,
    itemKeys: newlyReadyItems.map((item) => itemAnnouncementKey(event.ticket.id, item)),
    orderLabel: event.ticket.orderLabel || event.ticket.sourceOrderId,
    itemNames,
    spokenText: buildAnnouncementText(
      {
        orderLabel: event.ticket.orderLabel || event.ticket.sourceOrderId,
        items: newlyReadyItems
      },
      announceCompletedOrder
    ),
    occurredAt: event.occurredAt,
    status: event.ticket.status
  };
}

export function splitPreparingVsReady(tickets: DisplayLikeTicket[]) {
  const preparing: DisplayLikeTicket[] = [];
  const ready: DisplayLikeTicket[] = [];

  for (const ticket of tickets) {
    if (isReadyForPickup(ticket)) {
      ready.push(ticket);
    } else {
      preparing.push(ticket);
    }
  }

  return { preparing, ready };
}

// Completed orders are KEPT (not deleted) so they show in the "Ready for Pickup"
// column; the display auto-clears them once the pickup window passes (see
// isPickupExpired + the prune tick in customer-display-screen.tsx).
export function mergeDisplayTicket(tickets: DisplayLikeTicket[], ticket: DisplayLikeTicket) {
  const next = new Map(tickets.map((currentTicket) => [currentTicket.id, currentTicket]));
  next.set(ticket.id, ticket);
  return [...next.values()].toSorted((left, right) => left.createdAt.localeCompare(right.createdAt));
}
