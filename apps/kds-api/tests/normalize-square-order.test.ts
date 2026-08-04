import { describe, expect, it } from "vitest";

import { normalizeSquareOrder, type SquareOrder } from "../src/domain/normalize-square-order.js";

const MERCHANT = "square:LV78H3YNW202D";

// A paid pickup order with one multi-modifier line and one quantity-2 line.
function paidOrder(): SquareOrder {
  return {
    id: "ORDER_ABC123",
    locationId: "LV78H3YNW202D",
    ticketName: "Jaime",
    source: { name: "Square Online" },
    state: "COMPLETED",
    createdAt: "2026-06-18T15:00:00Z",
    updatedAt: "2026-06-18T15:02:00Z",
    netAmountDueMoney: { amount: 0n, currency: "USD" },
    totalMoney: { amount: 1075n, currency: "USD" },
    totalTaxMoney: { amount: 75n, currency: "USD" },
    totalTipMoney: { amount: 100n, currency: "USD" },
    fulfillments: [
      {
        type: "PICKUP",
        state: "PROPOSED",
        pickupDetails: {
          note: "extra napkins",
          recipient: { displayName: "Jaime R", phoneNumber: "+15551230000" },
        },
      },
    ],
    lineItems: [
      {
        uid: "LINE1",
        name: "Vanilla Scoop",
        variationName: "Regular",
        quantity: "1",
        note: "no cone",
        catalogObjectId: "ITEM_VANILLA",
        modifiers: [
          { uid: "M1", name: "Hot Fudge", totalPriceMoney: { amount: 75n } },
          { uid: "M2", name: "Sprinkles", totalPriceMoney: { amount: 0n } },
        ],
        totalMoney: { amount: 575n, currency: "USD" },
      },
      {
        uid: "LINE2",
        name: "Cola",
        quantity: "2",
        catalogObjectId: "ITEM_COLA",
        totalMoney: { amount: 500n, currency: "USD" },
      },
    ],
  };
}

describe("normalizeSquareOrder", () => {
  it("maps a paid pickup order to a NormalizedOrder", () => {
    const order = normalizeSquareOrder(paidOrder(), MERCHANT);

    expect(order.provider).toBe("square");
    expect(order.merchantId).toBe(MERCHANT);
    expect(order.orderId).toBe("ORDER_ABC123");
    expect(order.sourceOrderId).toBe("ORDER_ABC123");
    expect(order.orderLabel).toBe("Jaime");
    expect(order.source).toBe("Square Online");
    expect(order.orderType).toBe("PICKUP");
    expect(order.paymentState).toBe("PAID");
    expect(order.note).toBe("extra napkins");
    expect(order.createdAt).toBe("2026-06-18T15:00:00Z");
    expect(order.modifiedAt).toBe("2026-06-18T15:02:00Z");

    expect(order.items).toHaveLength(2);
    expect(order.items[0]).toMatchObject({
      providerLineItemId: "LINE1",
      cloverLineItemId: null,
      itemKey: "LINE1", // buildStableItemKey prefers the provider line uid
      itemId: "ITEM_VANILLA",
      name: "Vanilla Scoop",
      alternateName: "Regular",
      note: "no cone",
      modifiers: ["Hot Fudge", "Sprinkles"],
      quantity: 1,
      priceCents: 575,
      refunded: false,
      printed: false,
    });
    expect(order.items[1]).toMatchObject({ name: "Cola", quantity: 2, priceCents: 500 });

    // subtotal = total - tax - tip = 1075 - 75 - 100
    expect(order.amounts).toEqual({
      subtotalCents: 900,
      taxCents: 75,
      tipCents: 100,
      totalCents: 1075,
      currency: "USD",
    });
    expect(order.customer).toEqual({ name: "Jaime R", phone: "+15551230000" });
  });

  it("is JSON-safe — no Square bigint leaks through (the v44 footgun)", () => {
    expect(() => JSON.stringify(normalizeSquareOrder(paidOrder(), MERCHANT))).not.toThrow();
  });

  it("marks an order with money still due as UNPAID", () => {
    const order = normalizeSquareOrder(
      { ...paidOrder(), state: "OPEN", netAmountDueMoney: { amount: 500n, currency: "USD" } },
      MERCHANT,
    );
    expect(order.paymentState).toBe("UNPAID");
  });

  it("treats a COMPLETED order with no net_amount_due field as PAID", () => {
    const base = paidOrder();
    delete base.netAmountDueMoney;
    const order = normalizeSquareOrder({ ...base, state: "COMPLETED" }, MERCHANT);
    expect(order.paymentState).toBe("PAID");
  });

  it("falls back to the reference id, then a short id slug, for the kitchen label", () => {
    const base = paidOrder();
    delete base.ticketName;
    expect(normalizeSquareOrder({ ...base, referenceId: "WEB-42" }, MERCHANT).orderLabel).toBe("WEB-42");
    const noRef = paidOrder();
    delete noRef.ticketName;
    expect(normalizeSquareOrder(noRef, MERCHANT).orderLabel).toBe("#ORDER_");
  });

  it("clamps a non-integer/zero quantity to at least 1", () => {
    const order = normalizeSquareOrder(
      {
        id: "O",
        lineItems: [
          { uid: "L", name: "X", quantity: "0", totalMoney: { amount: 100n } },
          { uid: "L2", name: "Y", quantity: "1.5", totalMoney: { amount: 100n } },
        ],
      },
      MERCHANT,
    );
    expect(order.items[0]?.quantity).toBe(1);
    expect(order.items[1]?.quantity).toBe(1);
  });

  it("emits no customer when the fulfillment has no recipient", () => {
    const order = normalizeSquareOrder(
      { id: "O", state: "COMPLETED", fulfillments: [{ type: "PICKUP", pickupDetails: {} }] },
      MERCHANT,
    );
    expect(order.customer).toBeNull();
  });
});
