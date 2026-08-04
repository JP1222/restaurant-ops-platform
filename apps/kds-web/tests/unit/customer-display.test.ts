import type { KdsTicket, KdsTicketItem, RealtimeEvent } from "@rop/contracts";
import { describe, expect, it } from "vitest";
import {
  announcementFromEvent,
  buildAnnouncementText,
  completedItemAnnouncementKeys,
  customerDisplayItemGroups,
  isPickupReady,
  isReadyForPickup,
  itemNamesForAnnouncement,
  mergeDisplayTicket,
  PICKUP_DISPLAY_WINDOW_MS,
  pickCustomerVisibleTickets,
  pickupWindowExpired,
  releaseStaleAnnouncementKeys
} from "@/lib/customer-display";

function makeItem(overrides: Partial<KdsTicketItem> = {}): KdsTicketItem {
  return {
    id: "item-1",
    cloverLineItemId: null,
    providerLineItemId: null,
    itemKey: "item-1",
    itemId: null,
    name: "Vanilla Rolled Ice Cream",
    alternateName: null,
    note: null,
    modifiers: [],
    quantity: 1,
    refunded: false,
    printed: false,
    completed: false,
    completedAt: null,
    completedBy: null,
    ...overrides
  };
}

function makeTicket(overrides: Partial<KdsTicket> = {}): KdsTicket {
  return {
    id: "ticket-1",
    merchantId: "merchant-1",
    provider: "clover",
    cloverOrderId: "order-1",
    sourceOrderId: "order-1",
    orderLabel: "#A12",
    status: "new",
    priority: 0,
    source: null,
    orderType: "Pickup",
    paymentState: "PAID",
    note: null,
    lastActor: null,
    heldAt: null,
    holdUntil: null,
    displayChannelLabel: null,
    displayFulfillmentTimeLabel: null,
    hasLocalEdits: false,
    createdAt: "2026-04-22T18:00:00.000Z",
    updatedAt: "2026-04-22T18:00:00.000Z",
    elapsedMinutes: 4,
    items: [makeItem()],
    ...overrides
  };
}

function makeEvent(ticket: KdsTicket, overrides: Partial<RealtimeEvent> = {}): RealtimeEvent {
  return {
    type: "ticket.status_changed",
    merchantId: ticket.merchantId,
    occurredAt: ticket.updatedAt,
    ticket,
    ...overrides
  };
}

describe("customer display helpers", () => {
  it("shows ready and completed orders first, then preparing oldest-first", () => {
    const visible = pickCustomerVisibleTickets([
      makeTicket({ id: "new", orderLabel: "#NEW", status: "new", createdAt: "2026-04-22T18:03:00.000Z" }),
      makeTicket({ id: "started", orderLabel: "#STARTED", status: "in_progress", createdAt: "2026-04-22T18:02:00.000Z" }),
      makeTicket({
        id: "ready",
        orderLabel: "#READY",
        status: "ready",
        updatedAt: "2026-04-22T18:04:00.000Z",
        items: [makeItem({ completed: true })]
      }),
      makeTicket({
        id: "done",
        orderLabel: "#DONE",
        status: "completed",
        updatedAt: "2026-04-22T18:05:00.000Z",
        items: [makeItem({ completed: true })]
      })
    ]);

    // Completed/ready orders lead (newest-finished first); preparing follows oldest-first.
    expect(visible.map((ticket) => ticket.orderLabel)).toEqual(["#DONE", "#READY", "#STARTED", "#NEW"]);
  });

  it("treats completed and explicit ready orders as ready for pickup regardless of item flags", () => {
    expect(isReadyForPickup(makeTicket({ status: "completed", items: [makeItem({ completed: false })] }))).toBe(true);
    expect(isReadyForPickup(makeTicket({ status: "ready", items: [makeItem({ completed: false })] }))).toBe(true);
    expect(isReadyForPickup(makeTicket({ status: "in_progress", items: [makeItem({ completed: true })] }))).toBe(true);
    expect(isReadyForPickup(makeTicket({ status: "in_progress", items: [makeItem({ completed: false })] }))).toBe(false);
  });

  it("shows a ready order regardless of how old its server timestamp is", () => {
    // Expiry is time-on-screen (tracked by the display), not server updatedAt, so
    // a freshly-pushed ready order with an old timestamp must still appear.
    const visible = pickCustomerVisibleTickets([
      makeTicket({
        id: "old-ts",
        orderLabel: "#OLD",
        status: "ready",
        updatedAt: "2020-01-01T00:00:00.000Z",
        items: [makeItem({ completed: true })]
      })
    ]);

    expect(visible.map((ticket) => ticket.orderLabel)).toEqual(["#OLD"]);
  });

  it("expires a pickup order only once the window elapses from when it was first seen ready", () => {
    const seenAt = Date.parse("2026-04-22T18:00:00.000Z");
    expect(pickupWindowExpired(seenAt, seenAt + 60_000)).toBe(false);
    expect(pickupWindowExpired(seenAt, seenAt + PICKUP_DISPLAY_WINDOW_MS - 1)).toBe(false);
    expect(pickupWindowExpired(seenAt, seenAt + PICKUP_DISPLAY_WINDOW_MS)).toBe(true);
  });

  it("announces newly checked items but not duplicate ready or completed updates", () => {
    const completedTicket = makeTicket({ status: "completed", items: [makeItem({ completed: true })] });
    const readyTicket = makeTicket({
      id: "ticket-2",
      status: "ready",
      orderLabel: "#B24",
      items: [makeItem({ completed: true })]
    });
    const announced = new Set<string>(["ticket-1:item-1"]);

    expect(announcementFromEvent(makeEvent(completedTicket), announced)).toBeNull();

    const readyAnnouncement = announcementFromEvent(makeEvent(readyTicket), announced);
    expect(readyAnnouncement).toMatchObject({
      id: "ticket-2",
      orderLabel: "#B24",
      status: "ready"
    });
    expect(readyAnnouncement?.itemKeys).toEqual(["ticket-2:item-1"]);

    for (const itemKey of readyAnnouncement?.itemKeys ?? []) {
      announced.add(itemKey);
    }
    expect(announcementFromEvent(makeEvent(readyTicket), announced)).toBeNull();
  });

  it("announces an order completed with X when its items were not already announced", () => {
    const completedTicket = makeTicket({
      id: "ticket-2",
      status: "completed",
      orderLabel: "#B24",
      items: [
        makeItem({ id: "item-1", itemKey: "item-1", name: "Caesar Salad" }),
        makeItem({ id: "item-2", itemKey: "item-2", name: "Chicken Caesar Wrap" })
      ]
    });

    expect(announcementFromEvent(makeEvent(completedTicket), new Set())).toMatchObject({
      id: "ticket-2",
      itemKeys: ["ticket-2:item-1", "ticket-2:item-2"],
      itemNames: ["Caesar Salad", "Chicken Caesar Wrap"],
      spokenText: "Order #B24 is ready. Caesar Salad, Chicken Caesar Wrap.",
      status: "completed"
    });
  });

  it("announces only remaining items when a partially announced order is completed with X", () => {
    const completedTicket = makeTicket({
      id: "ticket-2",
      status: "completed",
      orderLabel: "#B24",
      items: [
        makeItem({ id: "item-1", itemKey: "item-1", name: "Caesar Salad", completed: true }),
        makeItem({ id: "item-2", itemKey: "item-2", name: "Chicken Caesar Wrap" })
      ]
    });

    expect(
      announcementFromEvent(makeEvent(completedTicket), new Set(["ticket-2:item-1"]))
    ).toMatchObject({
      itemKeys: ["ticket-2:item-2"],
      itemNames: ["Chicken Caesar Wrap"],
      spokenText: "Order #B24 is ready. Chicken Caesar Wrap."
    });
  });

  it("releases unchecked item announcement keys so re-checking plays again", () => {
    const checkedTicket = makeTicket({
      id: "ticket-2",
      status: "in_progress",
      orderLabel: "#B24",
      items: [makeItem({ completed: true })]
    });
    const uncheckedTicket = makeTicket({
      id: "ticket-2",
      status: "in_progress",
      orderLabel: "#B24",
      items: [makeItem({ completed: false })]
    });
    const announced = new Set<string>();

    const firstAnnouncement = announcementFromEvent(makeEvent(checkedTicket), announced);
    expect(firstAnnouncement?.itemKeys).toEqual(["ticket-2:item-1"]);

    for (const itemKey of firstAnnouncement?.itemKeys ?? []) {
      announced.add(itemKey);
    }
    expect(announcementFromEvent(makeEvent(checkedTicket), announced)).toBeNull();

    releaseStaleAnnouncementKeys(uncheckedTicket, announced);
    expect(announcementFromEvent(makeEvent(checkedTicket), announced)?.itemKeys).toEqual([
      "ticket-2:item-1"
    ]);
  });

  it("keeps announcement keys when a pickup order is completed to ignore duplicate completed events", () => {
    const announced = new Set(["ticket-2:item-1"]);
    const completedTicket = makeTicket({
      id: "ticket-2",
      status: "completed",
      items: [makeItem({ completed: true })]
    });

    releaseStaleAnnouncementKeys(completedTicket, announced);
    expect(announced).toEqual(new Set(["ticket-2:item-1"]));
  });

  it("does not announce active preparation events", () => {
    expect(announcementFromEvent(makeEvent(makeTicket({ status: "in_progress" })), new Set())).toBeNull();
  });

  it("treats orders with all visible items checked as ready for pickup", () => {
    const checkedTicket = makeTicket({
      status: "in_progress",
      items: [makeItem({ completed: true, completedAt: "2026-04-22T18:05:00.000Z" })]
    });

    expect(isPickupReady(checkedTicket)).toBe(true);
    expect(isPickupReady(makeTicket({ status: "in_progress" }))).toBe(false);
    expect(isPickupReady(makeTicket({ status: "ready" }))).toBe(false);
    expect(isPickupReady(makeTicket({ status: "ready", items: [] }))).toBe(false);
    expect(announcementFromEvent(makeEvent(checkedTicket), new Set())).toMatchObject({
      orderLabel: "#A12",
      status: "in_progress"
    });
  });

  it("groups duplicate item names and exposes ready versus preparing counts", () => {
    const groups = customerDisplayItemGroups(
      makeTicket({
        items: [
          makeItem({ id: "item-1", itemKey: "item-1", name: "Mango Bubble Tea", completed: true }),
          makeItem({ id: "item-2", itemKey: "item-2", name: "Mango Bubble Tea" }),
          makeItem({ id: "item-3", itemKey: "item-3", name: "Mango Bubble Tea" }),
          makeItem({ id: "item-4", itemKey: "item-4", name: "Bottle Drink", quantity: 2 })
        ]
      })
    );

    expect(groups).toEqual([
      {
        name: "Mango Bubble Tea",
        total: 3,
        ready: 1,
        pending: 2
      },
      {
        name: "Bottle Drink",
        total: 2,
        ready: 0,
        pending: 2
      }
    ]);
  });

  it("builds speech text from the order label and safe item names", () => {
    const ticket = makeTicket({
      orderLabel: "#C31",
      items: [
        makeItem({ id: "item-1", name: "Vanilla Rolled Ice Cream", completed: true }),
        makeItem({ id: "item-2", name: "Vanilla Rolled Ice Cream", completed: true }),
        makeItem({ id: "item-3", name: "Bottle Water", alternateName: "Water", completed: true }),
        makeItem({ id: "item-4", name: "Refunded Drink", completed: true, refunded: true }),
        makeItem({ id: "item-5", name: "Still Preparing" })
      ]
    });

    expect(itemNamesForAnnouncement(ticket)).toEqual(["Vanilla Rolled Ice Cream", "Water"]);
    expect(buildAnnouncementText(ticket)).toBe("Order #C31 is ready. Vanilla Rolled Ice Cream, Water.");
  });

  it("uses the real item name instead of generic special labels on the customer display", () => {
    const ticket = makeTicket({
      items: [
        makeItem({
          name: "Strawberry & Cheese Cake Rolled Ice Cream",
          alternateName: "Special#2",
          completed: true
        })
      ]
    });

    expect(itemNamesForAnnouncement(ticket)).toEqual(["Strawberry & Cheese Cake Rolled Ice Cream"]);
    expect(customerDisplayItemGroups(ticket)).toMatchObject([
      {
        name: "Strawberry & Cheese Cake Rolled Ice Cream"
      }
    ]);
  });

  it("merges realtime tickets and keeps completed orders for the pickup window", () => {
    const tickets = [
      makeTicket({ id: "ticket-1", orderLabel: "#A12", createdAt: "2026-04-22T18:00:00.000Z" }),
      makeTicket({ id: "ticket-2", orderLabel: "#B24", createdAt: "2026-04-22T18:02:00.000Z" })
    ];

    const merged = mergeDisplayTicket(
      tickets,
      makeTicket({ id: "ticket-1", status: "completed", items: [makeItem({ completed: true })] })
    );
    expect(merged).toHaveLength(2);
    expect(merged.find((ticket) => ticket.id === "ticket-1")).toMatchObject({ status: "completed" });
  });

  it("builds initial completed item announcement keys for snapshot hydration", () => {
    expect(
      completedItemAnnouncementKeys(
        makeTicket({
          items: [
            makeItem({ id: "item-1", itemKey: "item-1", completed: true }),
            makeItem({ id: "item-2", itemKey: "item-2" })
          ]
        })
      )
    ).toEqual(["ticket-1:item-1"]);
  });
});
