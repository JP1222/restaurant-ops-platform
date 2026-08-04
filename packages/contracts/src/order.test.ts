import { describe, expect, it } from "vitest";

import {
  CreateOrderRequestSchema,
  OrderCheckoutRequestSchema,
  OrderMenuResponseSchema,
  OrderStatusResponseSchema,
  OrderStatusStateSchema,
  OrderTotalsSchema,
  orderStatusStates,
} from "./order.js";

describe("order contracts", () => {
  it("parses a menu response and applies item defaults", () => {
    const parsed = OrderMenuResponseSchema.parse({
      categories: ["Signature Rolls"],
      items: [
        { id: "r1", name: "Strawberry Roll", priceCents: 899, category: "Signature Rolls" },
      ],
    });
    const item = parsed.items.at(0);
    if (!item) throw new Error("expected one menu item");
    expect(item.description).toBeNull();
    expect(item.imageUrl).toBeNull();
    expect(item.available).toBe(true);
    expect(item.modifierGroups).toEqual([]);
  });

  it("accepts a guest order (no phone) and trims the pickup name", () => {
    const req = CreateOrderRequestSchema.parse({
      customerName: "  Jamie  ",
      lines: [
        { lineId: "l1", itemId: "r1", itemName: "Strawberry Roll", unitPriceCents: 899, quantity: 1 },
      ],
    });
    expect(req.customerName).toBe("Jamie");
    expect(req.customerPhone).toBeUndefined();
    const line = req.lines.at(0);
    if (!line) throw new Error("expected one order line");
    expect(line.modifiers).toEqual([]); // default applied
  });

  it("rejects an order with no lines", () => {
    expect(
      CreateOrderRequestSchema.safeParse({ customerName: "Jamie", lines: [] }).success,
    ).toBe(false);
  });

  it("requires a payment token at checkout and defaults the tip to 0", () => {
    const ok = OrderCheckoutRequestSchema.parse({ orderId: "o1", paymentToken: "clv_test" });
    expect(ok.tipCents).toBe(0);
    expect(OrderCheckoutRequestSchema.safeParse({ orderId: "o1" }).success).toBe(false);
  });

  it("accepts exactly the six customer-facing order states", () => {
    for (const state of orderStatusStates) {
      expect(OrderStatusStateSchema.parse(state)).toBe(state);
    }
    expect(OrderStatusStateSchema.safeParse("refunded").success).toBe(false);
  });

  it("defaults totals currency to USD and tip to 0", () => {
    const totals = OrderTotalsSchema.parse({ subtotalCents: 899, taxCents: 88, totalCents: 987 });
    expect(totals.currency).toBe("USD");
    expect(totals.tipCents).toBe(0);
  });

  it("round-trips an order-status response and defaults locationId to null", () => {
    const input = {
      orderId: "o1",
      ticketNumber: "R-042",
      state: "preparing" as const,
      updatedAt: "2026-05-31T12:00:00.000Z",
    };
    // locationId defaults to null on the single-store path (multi-location, ADR-0018).
    expect(OrderStatusResponseSchema.parse(input)).toEqual({ ...input, locationId: null });
    // An explicitly-bound store round-trips unchanged.
    expect(OrderStatusResponseSchema.parse({ ...input, locationId: "loc2" }).locationId).toBe(
      "loc2",
    );
  });
});
