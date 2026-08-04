import type { NormalizedOrder } from "@rop/contracts";
import { describe, expect, it, vi, type Mock } from "vitest";

import type { AppServices } from "../src/lib/services.js";
import {
  enqueueLoyaltyWriteBack,
  isLoyaltyRefund,
  mapToOrderCompletedEvent
} from "../src/lib/sync-order.js";

const makeOrder = (over: Partial<NormalizedOrder> = {}): NormalizedOrder =>
  ({
    provider: "clover",
    merchantId: "merch-1",
    orderId: "order-1",
    sourceOrderId: "order-1",
    orderLabel: "#1",
    source: null,
    orderType: null,
    paymentState: "PAID",
    note: null,
    priority: 0,
    createdAt: "2026-05-30T12:00:00.000Z",
    modifiedAt: "2026-05-30T12:05:00.000Z",
    items: [
      { cloverLineItemId: null, providerLineItemId: null, itemKey: "k1", itemId: null, name: "Strawberry Roll", alternateName: null, note: null, modifiers: [], quantity: 1, priceCents: 800, refunded: false, printed: false },
      { cloverLineItemId: null, providerLineItemId: null, itemKey: "k2", itemId: null, name: "Boba add-on", alternateName: null, note: null, modifiers: [], quantity: 1, priceCents: 400, refunded: false, printed: false }
    ],
    amounts: null,
    customer: { phone: "+19015550100", name: "Jo" },
    ...over
  }) as NormalizedOrder;

const makeServices = (enqueue: () => Promise<void> = async () => {}) =>
  ({
    queue: { enqueueLoyaltyAccrual: vi.fn(enqueue) },
    prisma: { deadLetterJob: { create: vi.fn(async () => undefined) } }
  }) as unknown as AppServices;

describe("isLoyaltyRefund", () => {
  it("treats a fully-refunded Clover order as a reverse (case-insensitive)", () => {
    expect(isLoyaltyRefund("clover", "REFUNDED")).toBe(true);
    expect(isLoyaltyRefund("clover", "Refunded")).toBe(true);
    expect(isLoyaltyRefund("clover", "FULLY_REFUNDED")).toBe(true);
  });

  it("does NOT reverse on a paid or partially-refunded order (partial refunds unmodelled)", () => {
    expect(isLoyaltyRefund("clover", "PAID")).toBe(false);
    expect(isLoyaltyRefund("clover", "PARTIALLY_REFUNDED")).toBe(false);
    expect(isLoyaltyRefund("clover", null)).toBe(false);
  });

  it("never flags non-Clover providers as a refund", () => {
    expect(isLoyaltyRefund("deliverect", "REFUNDED")).toBe(false);
    expect(isLoyaltyRefund("demo", "REFUNDED")).toBe(false);
  });
});

describe("mapToOrderCompletedEvent", () => {
  it("maps a paid order to a POS-neutral earn event", () => {
    const event = mapToOrderCompletedEvent(makeOrder());
    expect(event).toMatchObject({
      provider: "clover",
      merchantId: "merch-1",
      internalOrderId: "clover:merch-1:order-1",
      occurredAt: "2026-05-30T12:05:00.000Z", // the provider clock (modifiedAt), not server time
      phoneE164: "+19015550100",
      isRefund: false
    });
    expect(event.items).toEqual([
      { chargedCents: 800, isGiftCardPurchase: false, wasRewardRedemption: false, refunded: false },
      { chargedCents: 400, isGiftCardPurchase: false, wasRewardRedemption: false, refunded: false }
    ]);
  });

  it("carries a null phone for an anonymous order and treats a missing price as 0", () => {
    const event = mapToOrderCompletedEvent(
      makeOrder({
        customer: null,
        items: [
          { cloverLineItemId: null, providerLineItemId: null, itemKey: "k1", itemId: null, name: "x", alternateName: null, note: null, modifiers: [], quantity: 1, priceCents: null, refunded: true, printed: false }
        ]
      })
    );
    expect(event.phoneE164).toBeNull();
    expect(event.items).toEqual([
      { chargedCents: 0, isGiftCardPurchase: false, wasRewardRedemption: false, refunded: true }
    ]);
  });

  it("flags a refund event from a fully-refunded paymentState", () => {
    expect(mapToOrderCompletedEvent(makeOrder({ paymentState: "REFUNDED" })).isRefund).toBe(true);
  });
});

describe("enqueueLoyaltyWriteBack (best-effort, ADR-0022)", () => {
  it("emits the mapped event when a customer phone is attached", async () => {
    const services = makeServices();
    await enqueueLoyaltyWriteBack(services, makeOrder());
    const enqueue = services.queue.enqueueLoyaltyAccrual as unknown as Mock;
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue.mock.calls[0][0]).toMatchObject({ internalOrderId: "clover:merch-1:order-1", phoneE164: "+19015550100" });
  });

  it("skips anonymous orders without enqueuing or dead-lettering (online-first gate)", async () => {
    const services = makeServices();
    await enqueueLoyaltyWriteBack(services, makeOrder({ customer: null }));
    expect(services.queue.enqueueLoyaltyAccrual).not.toHaveBeenCalled();
    expect(services.prisma.deadLetterJob.create).not.toHaveBeenCalled();
  });

  it("dead-letters an enqueue failure WITHOUT throwing or leaking the phone", async () => {
    const services = makeServices(async () => {
      throw new Error("redis down");
    });
    // Must never reject — a crm/Redis outage cannot block order sync.
    await expect(enqueueLoyaltyWriteBack(services, makeOrder())).resolves.toBeUndefined();

    const create = services.prisma.deadLetterJob.create as unknown as Mock;
    expect(create).toHaveBeenCalledTimes(1);
    const arg = create.mock.calls[0][0];
    expect(arg.data.jobType).toBe("crm-loyalty-accrual-enqueue");
    expect(arg.data.payload).toEqual({ internalOrderId: "clover:merch-1:order-1", isRefund: false });
    // No PII anywhere in the dead-letter row.
    expect(JSON.stringify(arg)).not.toContain("9015550100");
  });
});
