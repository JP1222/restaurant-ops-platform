import { describe, expect, it, vi } from "vitest";

vi.mock("@rop/db-kds", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@rop/db-kds")>();

  return {
    ...actual,
    OrderProvider: {
      CLOVER: "CLOVER",
      DELIVERECT: "DELIVERECT",
      DEMO: "DEMO"
    }
  };
});

import { buildLocalEditValues } from "../src/lib/local-ticket-edit.js";
import { serializeTicket } from "../src/lib/ticket-serializer.js";

function makeTicket(overrides: Record<string, unknown> = {}) {
  return {
    id: "ticket-1",
    merchantId: "merchant-1",
    provider: "CLOVER",
    cloverOrderId: "order-1",
    sourceOrderId: "order-1",
    orderLabel: "Jordan",
    status: "NEW",
    priority: 0,
    lastActor: null,
    lastAction: null,
    searchText: "jordan pickup",
    note: "Demo ticket",
    source: "Pickup",
    orderType: "Pickup",
    paymentState: "PAID",
    heldAt: null,
    holdUntil: null,
    acknowledgedAt: null,
    inProgressAt: null,
    readyAt: null,
    completedAt: null,
    bumpedAt: null,
    recalledAt: null,
    createdAt: new Date("2026-04-21T21:11:00.000Z"),
    updatedAt: new Date("2026-04-21T21:11:00.000Z"),
    items: [],
    localEdit: null,
    ...overrides
  };
}

describe("local ticket edits", () => {
  it("stores an override when the fulfillment display changes", () => {
    const next = buildLocalEditValues(
      makeTicket(),
      {
        orderLabel: "Jordan",
        channelLabel: "Pickup",
        fulfillmentTimeLabel: "12:15 PM",
        note: "Demo ticket"
      }
    );

    expect(next.needsOverride).toBe(true);
    expect(next.values).toEqual({
      orderLabel: "Jordan",
      channelLabel: "Pickup",
      fulfillmentTimeLabel: "12:15 PM",
      note: "Demo ticket"
    });
  });

  it("drops the override when the edit matches Clover data", () => {
    const next = buildLocalEditValues(
      makeTicket(),
      {
        orderLabel: "Jordan",
        channelLabel: "Pickup",
        fulfillmentTimeLabel: "",
        note: "Demo ticket"
      }
    );

    expect(next.needsOverride).toBe(false);
    expect(next.values.channelLabel).toBeNull();
    expect(next.values.fulfillmentTimeLabel).toBeNull();
  });

  it("treats split pickup labels as matching the raw Clover source", () => {
    const next = buildLocalEditValues(
      makeTicket({
        source: "Pickup at 12:15 PM",
        orderType: "Pickup"
      }),
      {
        orderLabel: "Jordan",
        channelLabel: "Pickup",
        fulfillmentTimeLabel: "12:15 PM",
        note: "Demo ticket"
      }
    );

    expect(next.needsOverride).toBe(false);
    expect(next.values.channelLabel).toBeNull();
    expect(next.values.fulfillmentTimeLabel).toBeNull();
  });

  it("merges local edit values into the serialized ticket", () => {
    const ticket = serializeTicket(
      makeTicket({
        provider: "DELIVERECT",
        sourceOrderId: "deliverect-order-1",
        items: [
          {
            id: "item-1",
            ticketId: "ticket-1",
            cloverLineItemId: null,
            providerLineItemId: "line-1",
            itemKey: "line-1",
            itemId: "catalog-1",
            name: "Loaded Fries",
            alternateName: null,
            note: "extra crisp",
            modifiers: ["Bacon"],
            quantity: 1,
            refunded: false,
            printed: true,
            completed: true,
            completedAt: new Date("2026-04-21T21:13:00.000Z"),
            completedBy: "Expo",
            createdAt: new Date("2026-04-21T21:11:00.000Z"),
            updatedAt: new Date("2026-04-21T21:13:00.000Z")
          }
        ],
        localEdit: {
          id: "edit-1",
          ticketId: "ticket-1",
          merchantId: "merchant-1",
          orderLabel: "Jordan Rush",
          channelLabel: "Pickup",
          fulfillmentTimeLabel: "12:15 PM",
          note: "",
          createdAt: new Date("2026-04-21T21:12:00.000Z"),
          updatedAt: new Date("2026-04-21T21:12:00.000Z")
        }
      }) as never
    );

    expect(ticket.orderLabel).toBe("Jordan Rush");
    expect(ticket.provider).toBe("deliverect");
    expect(ticket.sourceOrderId).toBe("deliverect-order-1");
    expect(ticket.note).toBe("");
    expect(ticket.displayChannelLabel).toBe("Pickup");
    expect(ticket.displayFulfillmentTimeLabel).toBe("12:15 PM");
    expect(ticket.hasLocalEdits).toBe(true);
    expect(ticket.items[0]).toMatchObject({
      providerLineItemId: "line-1",
      itemKey: "line-1",
      completed: true,
      completedAt: "2026-04-21T21:13:00.000Z",
      completedBy: "Expo"
    });
  });

  it("uses the provider order title instead of a stale Clover source id", () => {
    const ticket = serializeTicket(
      makeTicket({
        sourceOrderId: "T20HCA",
        orderLabel: "#T20HCA",
        order: {
          raw: {
            title: "29"
          },
          normalized: null
        }
      }) as never
    );

    expect(ticket.orderLabel).toBe("#29");
  });

  it("keeps item rows in their original order when serializing", () => {
    const ticket = serializeTicket(
      makeTicket({
        items: [
          {
            id: "item-2",
            ticketId: "ticket-1",
            cloverLineItemId: null,
            providerLineItemId: "line-2",
            itemKey: "line-2",
            itemId: "catalog-2",
            name: "Fries",
            alternateName: null,
            note: null,
            modifiers: [],
            quantity: 1,
            refunded: false,
            printed: true,
            completed: true,
            completedAt: new Date("2026-04-21T21:14:00.000Z"),
            completedBy: "Expo",
            createdAt: new Date("2026-04-21T21:12:00.000Z"),
            updatedAt: new Date("2026-04-21T21:14:00.000Z")
          },
          {
            id: "item-1",
            ticketId: "ticket-1",
            cloverLineItemId: null,
            providerLineItemId: "line-1",
            itemKey: "line-1",
            itemId: "catalog-1",
            name: "Burger",
            alternateName: null,
            note: null,
            modifiers: [],
            quantity: 1,
            refunded: false,
            printed: true,
            completed: false,
            completedAt: null,
            completedBy: null,
            createdAt: new Date("2026-04-21T21:11:00.000Z"),
            updatedAt: new Date("2026-04-21T21:11:00.000Z")
          }
        ]
      }) as never
    );

    expect(ticket.items.map((item) => item.itemKey)).toEqual(["line-1", "line-2"]);
  });
});
