import { describe, expect, it } from "vitest";

import {
  normalizeSquareOrder,
  normalizeSquarePayment,
  normalizeSquareRefund,
  normalizeSquareTenderType,
} from "../src/transform/normalize-square.js";

const TZ = "America/Chicago";

describe("normalizeSquareTenderType", () => {
  it("maps Square source types into the mart's constrained set", () => {
    expect(normalizeSquareTenderType({ sourceType: "CARD" })).toBe("CREDIT_CARD");
    expect(normalizeSquareTenderType({ sourceType: "CASH" })).toBe("CASH");
    expect(normalizeSquareTenderType({ sourceType: "SQUARE_GIFT_CARD" })).toBe("GIFT_CARD");
    expect(normalizeSquareTenderType({ sourceType: "EXTERNAL" })).toBe("OTHER");
    expect(normalizeSquareTenderType({})).toBe("UNKNOWN");
  });
});

describe("normalizeSquareOrder", () => {
  it("maps a Square order to a NormalizedOrder (ISO ts, catalog id, reshaped modifiers)", () => {
    const order = normalizeSquareOrder(
      {
        id: "sqOrder1",
        createdAt: "2026-04-26T02:30:00.000Z", // 21:30 the prior day in America/Chicago
        updatedAt: "2026-04-26T02:35:00.000Z",
        state: "COMPLETED",
        ticketName: "Jaime",
        totalMoney: { amount: 575, currency: "USD" },
        totalDiscountMoney: { amount: 0, currency: "USD" },
        fulfillments: [{ type: "PICKUP" }],
        lineItems: [
          {
            uid: "L1",
            name: "Vanilla Scoop",
            variationName: "Regular",
            quantity: "2",
            catalogObjectId: "ITEM_VANILLA",
            basePriceMoney: { amount: 250, currency: "USD" },
            grossSalesMoney: { amount: 575, currency: "USD" },
            totalTaxMoney: { amount: 25 },
            modifiers: [{ uid: "MU", catalogObjectId: "MOD_FUDGE", name: "Hot Fudge", totalPriceMoney: { amount: 75 } }],
          },
        ],
      },
      TZ,
    )!;

    expect(order.orderId).toBe("sqOrder1");
    expect(order.businessDate).toBe("2026-04-25"); // 21:30 CDT
    expect(order.orderTypeId).toBe("PICKUP");
    expect(order.orderLabel).toBe("Jaime");
    expect(order.orderTotalCents).toBe(575);
    expect(order.currency).toBe("USD");

    expect(order.lineItems).toHaveLength(1);
    const line = order.lineItems[0]!;
    expect(line.itemId).toBe("ITEM_VANILLA"); // the sold-items join key
    expect(line.lineItemId).toBe("L1");
    expect(line.quantity).toBe(2);
    expect(line.unitPriceCents).toBe(250);
    expect(line.modifierTotalCents).toBe(75);
    expect(line.grossSalesCents).toBe(575);
    expect(line.taxTotalCents).toBe(25);
    // modifiers reshaped to {id, name, amount} so the shared mart modifier
    // extractor reads them unchanged.
    expect(line.modifiers).toEqual([{ id: "MOD_FUDGE", name: "Hot Fudge", amount: 75 }]);
  });

  it("returns null for an order with no id", () => {
    expect(normalizeSquareOrder({ createdAt: "2026-04-26T00:00:00Z" }, TZ)).toBeNull();
  });
});

describe("normalizeSquarePayment", () => {
  it("maps amount/tip from Money, derives tender type, and zeroes payment tax", () => {
    const payment = normalizeSquarePayment(
      {
        id: "P1",
        orderId: "sqOrder1",
        createdAt: "2026-04-26T17:00:00.000Z",
        status: "COMPLETED",
        sourceType: "CARD",
        amountMoney: { amount: 575, currency: "USD" },
        tipMoney: { amount: 100, currency: "USD" },
      },
      TZ,
    )!;
    expect(payment.paymentId).toBe("P1");
    expect(payment.orderId).toBe("sqOrder1");
    expect(payment.amountCents).toBe(575);
    expect(payment.tipCents).toBe(100);
    expect(payment.taxCents).toBe(0);
    expect(payment.tenderType).toBe("CREDIT_CARD");
    expect(payment.employeeId).toBeNull();
  });

  it("skips a failed/canceled payment", () => {
    expect(normalizeSquarePayment({ id: "P2", status: "FAILED", sourceType: "CARD" }, TZ)).toBeNull();
    expect(normalizeSquarePayment({ id: "P3", status: "CANCELED", sourceType: "CARD" }, TZ)).toBeNull();
  });
});

describe("normalizeSquareRefund", () => {
  it("maps the refund amount to absolute cents", () => {
    const refund = normalizeSquareRefund(
      { id: "R1", paymentId: "P1", orderId: "sqOrder1", createdAt: "2026-04-26T18:00:00.000Z", amountMoney: { amount: 200 }, reason: "oops" },
      TZ,
    )!;
    expect(refund.refundId).toBe("R1");
    expect(refund.amountCents).toBe(200);
    expect(refund.reason).toBe("oops");
  });
});
