import { describe, expect, it } from "vitest";
import {
  applyOptimisticBoardAction,
  applyOptimisticItemAction,
  countCompletedItems,
  defaultBoardVisualSettings,
  describeEditableOrderChannel,
  describeEditableFulfillmentTime,
  describeOrderChannel,
  displayDetailsForBoardItem,
  displayNameForBoardItem,
  formatElapsed,
  formatElapsedPrecise,
  getTicketUrgencyTier,
  isBoardItemComplete,
  nextBoardItemAction,
  resolveBoardVisualSettings,
  sortTickets,
  summarizeBoard,
  toneForModifier
} from "@/lib/board";

function makeItem(overrides: Record<string, unknown> = {}) {
  return {
    id: "item-1",
    cloverLineItemId: null,
    providerLineItemId: null,
    itemKey: "item-1",
    itemId: null,
    name: "Item",
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

function makeTicket(overrides: Record<string, unknown> = {}) {
  return {
    id: "1",
    merchantId: "M",
    provider: "clover" as const,
    cloverOrderId: "A",
    sourceOrderId: "A",
    orderLabel: "#1",
    status: "new" as const,
    priority: 0,
    source: null,
    orderType: null,
    paymentState: null,
    note: null,
    lastActor: null,
    heldAt: null,
    holdUntil: null,
    displayChannelLabel: null,
    displayFulfillmentTimeLabel: null,
    hasLocalEdits: false,
    createdAt: "2026-04-21T17:00:00.000Z",
    updatedAt: "2026-04-21T17:00:00.000Z",
    elapsedMinutes: 1,
    items: [],
    ...overrides
  };
}

describe("board helpers", () => {
  it("formats elapsed time for long-running tickets", () => {
    expect(formatElapsed(18)).toBe("18m");
    expect(formatElapsed(83)).toBe("1h 23m");
    expect(formatElapsedPrecise(250)).toBe("4m 10s");
  });

  it("summarizes active board metrics", () => {
    const tickets = [
      makeTicket({
        status: "new",
        priority: 2,
        source: "Drive Thru",
        orderType: "Pickup",
        paymentState: "PAID",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        elapsedMinutes: 4,
        items: [makeItem({ id: "i1", itemKey: "i1", name: "Eggs", quantity: 2 })]
      }),
      makeTicket({
        id: "2",
        cloverOrderId: "B",
        sourceOrderId: "B",
        orderLabel: "#2",
        status: "in_progress",
        source: "For Here",
        orderType: "Dine In",
        paymentState: "PAID",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        elapsedMinutes: 8,
        items: [
          makeItem({ id: "i2", itemKey: "i2", name: "Eggs" }),
          makeItem({ id: "i3", itemKey: "i3", name: "Biscuit" })
        ]
      })
    ];

    expect(summarizeBoard(tickets)).toEqual({
      openCount: 2,
      avgMinutes: 6,
      longestMinutes: 8,
      readyCount: 0,
      priorityCount: 1
    });
  });

  it("sorts priority tickets before older low-priority tickets", () => {
    const sorted = sortTickets([
      makeTicket({
        id: "2",
        cloverOrderId: "B",
        sourceOrderId: "B",
        orderLabel: "#2",
        priority: 0,
        createdAt: "2026-04-21T17:01:00.000Z",
        updatedAt: "2026-04-21T17:01:00.000Z"
      }),
      makeTicket({
        id: "1",
        priority: 2,
        createdAt: "2026-04-21T17:02:00.000Z",
        updatedAt: "2026-04-21T17:02:00.000Z"
      }),
      makeTicket({
        id: "3",
        cloverOrderId: "C",
        sourceOrderId: "C",
        orderLabel: "#3",
        priority: 2,
        createdAt: "2026-04-21T17:00:00.000Z",
        updatedAt: "2026-04-21T17:00:00.000Z"
      })
    ]);

    expect(sorted.map((ticket) => ticket.id)).toEqual(["3", "1", "2"]);
  });

  it("applies optimistic complete and recall states for the board", () => {
    const baseTicket = makeTicket({
      status: "ready",
      priority: 1,
      source: "For Here",
      orderType: "Dine In",
      paymentState: "PAID",
      elapsedMinutes: 4
    });

    expect(applyOptimisticBoardAction(baseTicket, "complete", "2026-04-21T17:05:00.000Z")).toMatchObject({
      status: "completed",
      lastActor: "Kitchen",
      updatedAt: "2026-04-21T17:05:00.000Z"
    });

    expect(applyOptimisticBoardAction({ ...baseTicket, status: "completed" }, "recall", "2026-04-21T17:06:00.000Z")).toMatchObject({
      status: "ready",
      lastActor: "Kitchen",
      updatedAt: "2026-04-21T17:06:00.000Z"
    });
  });

  it("applies optimistic item completion and undo states", () => {
    const ticket = makeTicket({
      status: "in_progress",
      priority: 1,
      source: "Pickup",
      orderType: "Pickup",
      paymentState: "PAID",
      elapsedMinutes: 4,
      items: [
        makeItem({ id: "i1", itemKey: "line-1", name: "Burger", modifiers: ["No onions"] }),
        makeItem({ id: "i2", itemKey: "line-2", name: "Fries" })
      ]
    });

    const completed = applyOptimisticItemAction(ticket, "line-1", "complete", "2026-04-21T17:05:00.000Z");
    expect(isBoardItemComplete(completed.items[0])).toBe(true);
    expect(nextBoardItemAction(completed.items[0])).toBe("undo");
    expect(countCompletedItems(completed)).toBe(1);
    expect(completed.status).toBe("in_progress");
    expect(completed.updatedAt).toBe("2026-04-21T17:05:00.000Z");

    const undone = applyOptimisticItemAction(completed, "line-1", "undo", "2026-04-21T17:06:00.000Z");
    expect(isBoardItemComplete(undone.items[0])).toBe(false);
    expect(nextBoardItemAction(undone.items[0])).toBe("complete");
    expect(countCompletedItems(undone)).toBe(0);
  });

  it("moves optimistic item-only tickets into and out of the ready lane", () => {
    const ticket = makeTicket({
      status: "in_progress",
      items: [makeItem({ itemKey: "line-1", name: "Burger" })]
    });

    const completed = applyOptimisticItemAction(ticket, "line-1", "complete", "2026-04-21T17:05:00.000Z");
    expect(completed.status).toBe("ready");

    const undone = applyOptimisticItemAction(completed, "line-1", "undo", "2026-04-21T17:06:00.000Z");
    expect(undone.status).toBe("in_progress");
  });

  it("moves optimistic multi-item tickets ready after the last unchecked item is completed", () => {
    const ticket = makeTicket({
      status: "in_progress",
      items: [
        makeItem({ id: "i1", itemKey: "line-1", name: "Burger", completed: true }),
        makeItem({ id: "i2", itemKey: "line-2", name: "Fries" })
      ]
    });

    const completed = applyOptimisticItemAction(ticket, "line-2", "complete", "2026-04-21T17:05:00.000Z");
    expect(completed.status).toBe("ready");
  });

  it("resolves urgency settings and ticket tiers", () => {
    expect(resolveBoardVisualSettings(null)).toEqual(defaultBoardVisualSettings);
    expect(
      resolveBoardVisualSettings({
        urgencyWarningMinutes: 9,
        urgencyCriticalMinutes: 4,
        urgencyBlinkCritical: false,
        modifierDangerKeywords: ["allergy"],
        modifierAccentKeywords: ["extra"]
      })
    ).toEqual({
      urgencyWarningMinutes: 9,
      urgencyCriticalMinutes: 10,
      urgencyBlinkCritical: false,
      modifierDangerKeywords: ["allergy"],
      modifierAccentKeywords: ["extra"]
    });

    const ticket = makeTicket({
      source: "Drive Thru",
      orderType: "Pickup",
      paymentState: "PAID",
      elapsedMinutes: 0
    });

    expect(getTicketUrgencyTier(ticket, Date.parse("2026-04-21T17:09:59.000Z"), defaultBoardVisualSettings)).toBe("normal");
    expect(getTicketUrgencyTier(ticket, Date.parse("2026-04-21T17:10:00.000Z"), defaultBoardVisualSettings)).toBe("warning");
    expect(getTicketUrgencyTier(ticket, Date.parse("2026-04-21T17:20:00.000Z"), defaultBoardVisualSettings)).toBe("critical");
  });

  it("classifies modifiers for highlighted board chips", () => {
    expect(toneForModifier("No onions", defaultBoardVisualSettings)).toBe("alert");
    expect(toneForModifier("Extra cheese", defaultBoardVisualSettings)).toBe("accent");
    expect(toneForModifier("Cut in half", defaultBoardVisualSettings)).toBe("neutral");
  });

  it("keeps kitchen item names and expands item detail lines", () => {
    const item = makeItem({
      name: "Special#1",
      alternateName: "Roll icecream",
      note: "Vanilla base\nOreo mixin",
      modifiers: ["Oreo topping", " Oreo topping "]
    });

    expect(displayNameForBoardItem(item)).toBe("Special#1");
    expect(displayDetailsForBoardItem(item)).toEqual(["Roll icecream", "Vanilla base", "Oreo mixin", "Oreo topping"]);
  });

  it("splits Clover special recipe names into kitchen detail lines", () => {
    const item = makeItem({
      name: "Special#1",
      alternateName: "Vanilla & Orea Mix-in & Orea topping",
      note: null,
      modifiers: []
    });

    expect(displayNameForBoardItem(item)).toBe("Special#1");
    expect(displayDetailsForBoardItem(item)).toEqual(["Vanilla", "Orea Mix-in", "Orea topping"]);
  });

  it("prefers local edit channel labels for the service bar", () => {
    const ticket = makeTicket({
      source: "Pickup at 12:15 PM",
      orderType: "Pickup",
      paymentState: "PAID",
      note: "",
      displayChannelLabel: "Pickup",
      displayFulfillmentTimeLabel: "12:15 PM",
      hasLocalEdits: true,
      elapsedMinutes: 4
    });

    expect(describeOrderChannel(ticket)).toBe("Pickup at 12:15 PM");
    expect(describeEditableOrderChannel(ticket)).toBe("Pickup");
    expect(describeEditableFulfillmentTime(ticket)).toBe("12:15 PM");
  });

  it("splits raw pickup sources for the edit form", () => {
    const ticket = makeTicket({
      source: "Pickup at 12:30 PM",
      orderType: "Pickup",
      paymentState: "PAID",
      note: "",
      elapsedMinutes: 4
    });

    expect(describeOrderChannel(ticket)).toBe("Pickup at 12:30 PM");
    expect(describeEditableOrderChannel(ticket)).toBe("Pickup");
    expect(describeEditableFulfillmentTime(ticket)).toBe("12:30 PM");
  });

  it("removes Deliverect provider suffixes from order channel labels", () => {
    expect(describeOrderChannel(makeTicket({ source: "Uber Eats via Deliverect" }))).toBe("Uber Eats");
    expect(describeOrderChannel(makeTicket({ source: "Pickup via deliverect" }))).toBe("Pickup");
    expect(describeEditableOrderChannel(makeTicket({ displayChannelLabel: "DoorDash via Deliverect" }))).toBe("DoorDash");
  });
});
