import { describe, expect, it } from "vitest";

import {
  CRM_LOYALTY_ACCRUAL_QUEUE,
  EarnLineSchema,
  OrderCompletedEventSchema
} from "./loyalty.js";

describe("CRM_LOYALTY_ACCRUAL_QUEUE", () => {
  it("is the shared queue name both kds-api and crm-api agree on", () => {
    expect(CRM_LOYALTY_ACCRUAL_QUEUE).toBe("crm-loyalty-accrual");
  });
});

describe("EarnLineSchema", () => {
  it("accepts a line with refunded omitted (optional)", () => {
    const parsed = EarnLineSchema.parse({
      chargedCents: 650,
      isGiftCardPurchase: false,
      wasRewardRedemption: false
    });
    expect(parsed).toEqual({ chargedCents: 650, isGiftCardPurchase: false, wasRewardRedemption: false });
    expect(parsed.refunded).toBeUndefined();
  });

  it("rejects a non-integer chargedCents (cents are integers)", () => {
    expect(() =>
      EarnLineSchema.parse({ chargedCents: 6.5, isGiftCardPurchase: false, wasRewardRedemption: false })
    ).toThrow();
  });

  it("rejects a negative chargedCents (a malformed line, not a 0-clamp) (GH #464)", () => {
    expect(() =>
      EarnLineSchema.parse({ chargedCents: -1, isGiftCardPurchase: false, wasRewardRedemption: false })
    ).toThrow();
  });

  it("accepts a zero chargedCents (a fully-discounted but real line)", () => {
    const parsed = EarnLineSchema.parse({
      chargedCents: 0,
      isGiftCardPurchase: false,
      wasRewardRedemption: false
    });
    expect(parsed.chargedCents).toBe(0);
  });

  it("rejects a line missing a required eligibility flag", () => {
    expect(() => EarnLineSchema.parse({ chargedCents: 100, isGiftCardPurchase: false })).toThrow();
  });
});

describe("OrderCompletedEventSchema", () => {
  const validEarn = {
    provider: "clover",
    items: [{ chargedCents: 800, isGiftCardPurchase: false, wasRewardRedemption: false }],
    merchantId: "merch-1",
    internalOrderId: "clover:merch-1:order-1",
    occurredAt: "2026-05-30T12:00:00.000Z",
    phoneE164: "+19015550100",
    isRefund: false
  };

  it("accepts an event with locationId + source omitted", () => {
    const parsed = OrderCompletedEventSchema.parse(validEarn);
    expect(parsed.locationId).toBeUndefined();
    expect(parsed.source).toBeUndefined();
    expect(parsed.phoneE164).toBe("+19015550100");
  });

  it("accepts a null phone (anonymous order)", () => {
    expect(OrderCompletedEventSchema.parse({ ...validEarn, phoneE164: null }).phoneE164).toBeNull();
  });

  it("survives a JSON round-trip (the BullMQ wire format)", () => {
    const roundTripped = OrderCompletedEventSchema.parse(JSON.parse(JSON.stringify(validEarn)));
    expect(roundTripped).toMatchObject(validEarn);
  });

  it("rejects an event missing isRefund (the earn-vs-reverse switch)", () => {
    const withoutFlag: Record<string, unknown> = { ...validEarn };
    delete withoutFlag.isRefund;
    expect(() => OrderCompletedEventSchema.parse(withoutFlag)).toThrow();
  });
});
