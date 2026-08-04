import { describe, expect, it } from "vitest";
import {
  normalizeOrder,
  normalizePayment,
  normalizeRefund,
  normalizeTender,
  normalizeTenderType
} from "../src/transform/normalize.js";

describe("normalize Clover payloads", () => {
  it("normalizes tender labels into AI-friendly payment method groups", () => {
    expect(normalizeTenderType("Cash")).toBe("CASH");
    expect(normalizeTenderType("Credit Card")).toBe("CREDIT_CARD");
    expect(normalizeTenderType("Gift Card")).toBe("GIFT_CARD");
    expect(normalizeTenderType("DoorDash")).toBe("OTHER");
    expect(normalizeTenderType(null)).toBe("UNKNOWN");
  });

  it("keeps split payments as individual payment facts", () => {
    const tenderLookup = new Map([
      ["cash", "CASH" as const],
      ["card", "CREDIT_CARD" as const]
    ]);

    const cash = normalizePayment({
      id: "pay-cash",
      createdTime: Date.UTC(2026, 3, 20, 17),
      amount: 1200,
      order: { id: "order-1" },
      tender: { id: "cash" },
      result: "SUCCESS"
    }, "America/Chicago", tenderLookup);

    const card = normalizePayment({
      id: "pay-card",
      createdTime: Date.UTC(2026, 3, 20, 17, 5),
      amount: 800,
      tipAmount: 100,
      order: { id: "order-1" },
      tender: { id: "card" },
      result: "SUCCESS"
    }, "America/Chicago", tenderLookup);

    expect(cash?.orderId).toBe("order-1");
    expect(cash?.tenderType).toBe("CASH");
    expect(cash?.amountCents).toBe(1200);
    expect(card?.tenderType).toBe("CREDIT_CARD");
    expect(card?.tipCents).toBe(100);
  });

  it("drops failed or voided payments from mart facts", () => {
    const failed = normalizePayment({
      id: "pay-failed",
      createdTime: Date.UTC(2026, 3, 20, 17),
      amount: 1200,
      result: "FAILED"
    }, "America/Chicago", new Map());

    expect(failed).toBeNull();
  });

  it("normalizes refund amount as positive cents", () => {
    const refund = normalizeRefund({
      id: "refund-1",
      createdTime: Date.UTC(2026, 3, 21, 1),
      amount: -500,
      paymentId: "payment-1",
      orderId: "order-1"
    }, "America/Chicago");

    expect(refund?.amountCents).toBe(500);
    expect(refund?.businessDate).toBe("2026-04-20");
  });

  it("normalizes orders and line item quantities in Central Time", () => {
    const order = normalizeOrder({
      id: "order-1",
      clientCreatedTime: Date.UTC(2026, 3, 21, 1, 30),
      total: 2400,
      employee: { id: "emp-1" },
      orderType: { id: "dine-in" },
      lineItems: {
        elements: [{
          id: "line-1",
          name: "Milk Tea",
          alternateName: "Classic milk tea with boba",
          unitQty: 2000,
          price: 600,
          modifications: {
            elements: [{ name: "Boba", amount: 100 }]
          }
        }]
      }
    }, "America/Chicago");

    expect(order?.businessDate).toBe("2026-04-20");
    expect(order?.local.localHour).toBe(20);
    expect(order?.lineItems[0]?.quantity).toBe(2);
    expect(order?.lineItems[0]?.alternateName).toBe("Classic milk tea with boba");
    expect(order?.lineItems[0]?.modifiers).toMatchObject([{ name: "Boba", amount: 100 }]);
    expect(order?.lineItems[0]?.modifierTotalCents).toBe(100);
    expect(order?.lineItems[0]?.grossSalesCents).toBe(1400);
  });

  it("normalizes raw tender dimension rows", () => {
    const tender = normalizeTender({ id: "t1", label: "Cash" });
    expect(tender).toMatchObject({
      tenderId: "t1",
      label: "Cash",
      type: "CASH"
    });
  });
});
