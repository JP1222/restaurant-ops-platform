import { describe, expect, it } from "vitest";
import { normalizeDeliverectOrder } from "../src/domain/normalize-deliverect-order.js";

describe("normalizeDeliverectOrder", () => {
  it("normalizes provider-aware ids and stable item keys", () => {
    const order = normalizeDeliverectOrder(
      {
        _id: "deliv-12345",
        channelOrderId: "#UE5001",
        createdAt: "2026-04-21T20:00:00.000Z",
        updatedAt: "2026-04-21T20:02:00.000Z",
        note: "rush delivery",
        channel: "Uber Eats",
        orderType: "Delivery",
        items: [
          {
            _id: "item-1",
            plu: "burger-1",
            name: "Burger",
            quantity: 2,
            subItems: [
              { name: "No Onion" },
              { name: "Extra Cheese" }
            ]
          }
        ]
      },
      "MERCHANT-1"
    );

    expect(order).toMatchObject({
      provider: "deliverect",
      merchantId: "MERCHANT-1",
      orderId: "deliverect:deliv-12345",
      sourceOrderId: "deliv-12345",
      orderLabel: "#UE5001",
      source: "Uber Eats",
      orderType: "Delivery",
      priority: 2
    });
    expect(order.items[0]).toMatchObject({
      cloverLineItemId: null,
      providerLineItemId: "item-1",
      itemId: "burger-1",
      itemKey: "item-1",
      modifiers: ["No Onion", "Extra Cheese"],
      quantity: 2
    });
  });
});
