import type { PrismaClient } from "@rop/db-crm";
import { describe, expect, it } from "vitest";

import { accrueFromOrderCompleted, type OrderCompletedEvent } from "../src/domain/accrual.js";

// A small STATEFUL fake — accrual's whole point is state transitions
// (idempotency, reversal), so a stateless stub can't test it. It models the
// UNIQUE(source,sourceId,type) constraint (create throws P2002 on a dup),
// findUnique by the compound key, updateMany, and increment/decrement on the
// account projection. $transaction just runs the callback (no real isolation,
// but it exercises the create+update sequence).
function makeFake(customer: Record<string, unknown> | null) {
  const ledger: Array<Record<string, unknown>> = [];
  const account = (customer?.account as Record<string, unknown> | undefined) ?? null;
  const sameKey = (a: Record<string, unknown>, b: Record<string, unknown>) =>
    a.source === b.source && a.sourceId === b.sourceId && a.type === b.type;
  const applyDelta = (target: Record<string, unknown>, data: Record<string, unknown>) => {
    for (const [k, v] of Object.entries(data)) {
      if (v && typeof v === "object" && "increment" in v) {
        target[k] = ((target[k] as number) ?? 0) + (v as { increment: number }).increment;
      } else if (v && typeof v === "object" && "decrement" in v) {
        target[k] = ((target[k] as number) ?? 0) - (v as { decrement: number }).decrement;
      } else {
        target[k] = v;
      }
    }
  };
  const api = {
    crmCustomer: { findUnique: async () => customer },
    crmPointsLedger: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        if (ledger.some((r) => sameKey(r, data))) {
          throw { code: "P2002" };
        }
        const row = { id: `led-${ledger.length + 1}`, ...data };
        ledger.push(row);
        return row;
      },
      findUnique: async ({ where }: { where: { source_sourceId_type: Record<string, unknown> } }) => {
        const k = where.source_sourceId_type;
        return (
          ledger.find((r) => r.source === k.source && r.sourceId === k.sourceId && r.type === k.type) ?? null
        );
      },
      updateMany: async ({
        where,
        data
      }: {
        where: { id: string; status?: string };
        data: Record<string, unknown>;
      }) => {
        let count = 0;
        for (const r of ledger) {
          if (r.id === where.id && (where.status === undefined || r.status === where.status)) {
            Object.assign(r, data);
            count++;
          }
        }
        return { count };
      }
    },
    crmLoyaltyAccount: {
      update: async ({ data }: { data: Record<string, unknown> }) => {
        if (account) applyDelta(account, data);
        return account;
      }
    },
    $transaction: async <T>(fn: (tx: typeof api) => Promise<T>) => fn(api),
    $disconnect: async () => {}
  };
  return { prisma: api as unknown as PrismaClient, ledger, account };
}

const enrolled = () => ({
  id: "cust-1",
  phoneE164: "+19015550100",
  account: {
    id: "acct-1",
    balancePoints: 0,
    pendingPoints: 0,
    lifetimeEligibleSpendCents: 0,
    balanceVersion: 0,
    lastActivityAt: null
  }
});

// basis = 800 + 400 = 1200c ($12) -> floor(1200*10/100) = 120 pts
const earnEvent = (over: Partial<OrderCompletedEvent> = {}): OrderCompletedEvent => ({
  provider: "clover",
  merchantId: "merch-1",
  locationId: null,
  internalOrderId: "clover:merch-1:order-1",
  occurredAt: "2026-05-30T12:00:00.000Z",
  phoneE164: "+19015550100",
  isRefund: false,
  items: [
    { chargedCents: 800, isGiftCardPurchase: false, wasRewardRedemption: false },
    { chargedCents: 400, isGiftCardPurchase: false, wasRewardRedemption: false }
  ],
  ...over
});

describe("accrueFromOrderCompleted — earn", () => {
  it("writes a PENDING EARN row and lifts pendingPoints (not the spendable balance)", async () => {
    const { prisma, ledger, account } = makeFake(enrolled());
    const res = await accrueFromOrderCompleted(prisma, earnEvent());
    expect(res).toEqual({ status: "earned", points: 120 });
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ type: "EARN", status: "PENDING", points: 120, eligibleSubtotalCents: 1200 });
    expect(account).toMatchObject({ pendingPoints: 120, balancePoints: 0, lifetimeEligibleSpendCents: 1200, balanceVersion: 1 });
  });

  it("is idempotent — a replayed webhook does not double-credit", async () => {
    const { prisma, ledger, account } = makeFake(enrolled());
    await accrueFromOrderCompleted(prisma, earnEvent());
    const replay = await accrueFromOrderCompleted(prisma, earnEvent());
    expect(replay).toEqual({ status: "skipped", reason: "already accrued (idempotent replay)" });
    expect(ledger).toHaveLength(1);
    expect(account).toMatchObject({ pendingPoints: 120, balanceVersion: 1 });
  });

  it("skips an anonymous order (no customer phone)", async () => {
    const { prisma, ledger } = makeFake(enrolled());
    const res = await accrueFromOrderCompleted(prisma, earnEvent({ phoneE164: null }));
    expect(res.status).toBe("skipped");
    expect(ledger).toHaveLength(0);
  });

  it("skips when the phone isn't enrolled", async () => {
    const { prisma, ledger } = makeFake(null);
    const res = await accrueFromOrderCompleted(prisma, earnEvent());
    expect(res).toEqual({ status: "skipped", reason: "customer not enrolled" });
    expect(ledger).toHaveLength(0);
  });

  it("skips a gift-card-only order (0 eligible points)", async () => {
    const { prisma, ledger } = makeFake(enrolled());
    const res = await accrueFromOrderCompleted(
      prisma,
      earnEvent({ items: [{ chargedCents: 2500, isGiftCardPurchase: true, wasRewardRedemption: false }] })
    );
    expect(res).toEqual({ status: "skipped", reason: "no eligible points" });
    expect(ledger).toHaveLength(0);
  });
});

describe("accrueFromOrderCompleted — refund", () => {
  it("cancels a still-PENDING earn in place and removes the pending points", async () => {
    const { prisma, ledger, account } = makeFake(enrolled());
    await accrueFromOrderCompleted(prisma, earnEvent());
    const res = await accrueFromOrderCompleted(prisma, earnEvent({ isRefund: true }));
    expect(res).toEqual({ status: "reversed", points: 120 });
    expect(ledger).toHaveLength(1); // cancelled in place, not double-rowed
    expect(ledger[0]).toMatchObject({ type: "EARN", status: "REVERSED" });
    expect(account).toMatchObject({ pendingPoints: 0, lifetimeEligibleSpendCents: 0 });
  });

  it("skips a refund with no prior earn to reverse", async () => {
    const { prisma, ledger } = makeFake(enrolled());
    const res = await accrueFromOrderCompleted(prisma, earnEvent({ isRefund: true }));
    expect(res).toEqual({ status: "skipped", reason: "no prior EARN to reverse" });
    expect(ledger).toHaveLength(0);
  });

  // GH #456: findUnique reads the earn as PENDING, but a concurrent refund flips
  // it out of PENDING before our guarded updateMany runs -> count === 0. The call
  // must report `skipped`, NOT `reversed`, and must not touch the projection.
  it("skips (not 'reversed') when a concurrent flip makes the update a no-op", async () => {
    const { prisma, ledger, account } = makeFake(enrolled());
    await accrueFromOrderCompleted(prisma, earnEvent()); // PENDING earn, pendingPoints = 120
    expect(account).toMatchObject({ pendingPoints: 120 });

    // Simulate the race: flip the row to REVERSED at the moment updateMany fires,
    // after reverseAccrual's findUnique has already read it as PENDING.
    const fake = prisma as unknown as {
      crmPointsLedger: { updateMany: (args: unknown) => Promise<{ count: number }> };
    };
    const originalUpdateMany = fake.crmPointsLedger.updateMany.bind(fake.crmPointsLedger);
    fake.crmPointsLedger.updateMany = async (args) => {
      ledger[0].status = "REVERSED"; // the concurrent winner already flipped it
      return originalUpdateMany(args);
    };

    const res = await accrueFromOrderCompleted(prisma, earnEvent({ isRefund: true }));
    expect(res).toEqual({ status: "skipped", reason: "already reversed (concurrent flip)" });
    // Our losing call must NOT have decremented the projection (no double-reverse).
    expect(account).toMatchObject({ pendingPoints: 120 });
  });
});
