import type { PrismaClient } from "@rop/db-crm";
import { describe, expect, it } from "vitest";

import type { AppServices } from "../src/lib/services.js";
import { processAccrualJob } from "../src/worker-handler.js";

// A focused fake: records the phone the ledger was queried with (the thing the
// worker is responsible for canonicalizing) and lets the earn path complete.
function makeFake(customer: Record<string, unknown> | null) {
  const calls: { queriedPhone?: string | null } = {};
  const api = {
    crmCustomer: {
      findUnique: async ({ where }: { where: { phoneE164: string } }) => {
        calls.queriedPhone = where.phoneE164;
        return customer;
      }
    },
    crmPointsLedger: {
      create: async () => ({}),
      findUnique: async () => null,
      updateMany: async () => ({ count: 0 })
    },
    crmLoyaltyAccount: { update: async () => ({}) },
    $transaction: async <T>(fn: (tx: typeof api) => Promise<T>) => fn(api)
  };
  return { services: { prisma: api as unknown as PrismaClient } as unknown as AppServices, calls };
}

const enrolled = {
  id: "cust-1",
  phoneE164: "+19015550100",
  account: { id: "acct-1", balancePoints: 0, pendingPoints: 0, lifetimeEligibleSpendCents: 0, balanceVersion: 0, lastActivityAt: null }
};

const earnEvent = (over: Record<string, unknown> = {}) => ({
  provider: "clover",
  merchantId: "merch-1",
  locationId: null,
  internalOrderId: "clover:merch-1:order-1",
  occurredAt: "2026-05-30T12:00:00.000Z",
  phoneE164: "+19015550100",
  isRefund: false,
  items: [{ chargedCents: 1200, isGiftCardPurchase: false, wasRewardRedemption: false }],
  ...over
});

describe("processAccrualJob", () => {
  it("canonicalizes a loose phone to E.164 BEFORE the ledger lookup", async () => {
    const { services, calls } = makeFake(enrolled);
    // A loose, human-typed phone — the producer ferries it verbatim from Clover.
    const result = await processAccrualJob(services, earnEvent({ phoneE164: "(901) 555-0100" }));
    expect(calls.queriedPhone).toBe("+19015550100"); // normalized at the consumer chokepoint
    expect(result).toEqual({ status: "earned", points: 120 });
  });

  it("skips (no throw) when the phone can't be canonicalized — never looks up", async () => {
    const { services, calls } = makeFake(null);
    const result = await processAccrualJob(services, earnEvent({ phoneE164: "not-a-phone" }));
    expect(result).toEqual({ status: "skipped", reason: "anonymous order (no customer phone)" });
    expect(calls.queriedPhone).toBeUndefined();
  });

  it("skips a genuinely anonymous order (null phone)", async () => {
    const { services } = makeFake(null);
    const result = await processAccrualJob(services, earnEvent({ phoneE164: null }));
    expect(result.status).toBe("skipped");
  });

  it("throws on a structurally-invalid job so BullMQ retries / dead-letters it", async () => {
    const { services } = makeFake(null);
    const malformed: Record<string, unknown> = { ...earnEvent() };
    delete malformed.isRefund; // the earn-vs-reverse switch is required
    await expect(processAccrualJob(services, malformed)).rejects.toThrow();
  });
});
