import type { OrderCompletedEvent } from "@rop/contracts";
import type { PrismaClient } from "@rop/db-crm";

import { calculatePointsEarned } from "./earn.js";

// OrderCompletedEvent moved to @rop/contracts in PR4c, now that kds-api
// emits it onto the crm-loyalty-accrual queue (ADR-0025 prototype-DTO rule).
// Re-exported here so existing `./accrual.js` importers (tests, future routes)
// stay unchanged. Accrual is async + idempotent — never a sync call that could
// stall order sync (ADR-0022).
export type { OrderCompletedEvent };

export type AccrualResult =
  | { status: "earned"; points: number }
  | { status: "reversed"; points: number }
  | { status: "skipped"; reason: string };

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === "P2002"
  );
}

function sourceFor(event: OrderCompletedEvent): string {
  return event.source ?? `${event.provider}_order`;
}

/**
 * Turn an order-completed (or -refunded) event into ledger movement, exactly
 * once. The earn path INSERTs a PENDING EARN row + bumps the account projection
 * inside ONE transaction; the DB UNIQUE(source,sourceId,type) makes a replayed
 * webhook conflict and roll back the whole tx — never a double-credit. The
 * refund path cancels a still-PENDING earn in place, or posts a negative REVERSE
 * row against a promoted (AVAILABLE) one.
 */
export async function accrueFromOrderCompleted(
  prisma: PrismaClient,
  event: OrderCompletedEvent
): Promise<AccrualResult> {
  if (!event.phoneE164) {
    return { status: "skipped", reason: "anonymous order (no customer phone)" };
  }
  const customer = await prisma.crmCustomer.findUnique({
    where: { phoneE164: event.phoneE164 },
    include: { account: true }
  });
  if (!customer?.account) {
    return { status: "skipped", reason: "customer not enrolled" };
  }
  const accountId = customer.account.id;
  const source = sourceFor(event);
  const occurredAt = new Date(event.occurredAt);

  if (event.isRefund) {
    return reverseAccrual(prisma, { accountId, source, sourceId: event.internalOrderId, occurredAt });
  }

  const { points, basisCents } = calculatePointsEarned(event);
  if (points <= 0) {
    return { status: "skipped", reason: "no eligible points" };
  }

  try {
    await prisma.$transaction(async (tx) => {
      // The UNIQUE(source, sourceId, type) on this INSERT is the idempotency
      // guard. A replay throws P2002 here, rolling back the projection bump too.
      await tx.crmPointsLedger.create({
        data: {
          accountId,
          merchantId: event.merchantId,
          locationId: event.locationId ?? null,
          type: "EARN",
          points,
          status: "PENDING", // promoted to AVAILABLE after the return window (Phase 5)
          source,
          sourceId: event.internalOrderId,
          eligibleSubtotalCents: basisCents,
          occurredAt
        }
      });
      // EARN is PENDING, so it lifts pendingPoints, not the spendable balance.
      await tx.crmLoyaltyAccount.update({
        where: { id: accountId },
        data: {
          pendingPoints: { increment: points },
          lifetimeEligibleSpendCents: { increment: basisCents },
          lastActivityAt: occurredAt,
          balanceVersion: { increment: 1 }
        }
      });
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      return { status: "skipped", reason: "already accrued (idempotent replay)" };
    }
    throw err;
  }
  return { status: "earned", points };
}

interface ReverseArgs {
  accountId: string;
  source: string;
  sourceId: string;
  occurredAt: Date;
}

async function reverseAccrual(prisma: PrismaClient, args: ReverseArgs): Promise<AccrualResult> {
  const { accountId, source, sourceId, occurredAt } = args;
  const earn = await prisma.crmPointsLedger.findUnique({
    where: { source_sourceId_type: { source, sourceId, type: "EARN" } }
  });
  if (!earn) {
    return { status: "skipped", reason: "no prior EARN to reverse" };
  }
  if (earn.status === "REVERSED") {
    return { status: "skipped", reason: "already reversed" };
  }
  const spendBack = earn.eligibleSubtotalCents ?? 0;

  // Still PENDING: cancel in place rather than double-rowing. The status guard on
  // updateMany makes a concurrent flip a no-op (count === 0 -> nothing decremented).
  // We must surface that no-op as `skipped` to the caller — a bare `return` inside
  // the tx callback would fall through to `reversed` below and falsely report that
  // THIS call did the reversal, diverging the ledger from the projection (GH #456).
  if (earn.status === "PENDING") {
    let flippedCount = 0;
    await prisma.$transaction(async (tx) => {
      const flipped = await tx.crmPointsLedger.updateMany({
        where: { id: earn.id, status: "PENDING" },
        data: { status: "REVERSED" }
      });
      if (flipped.count === 0) {
        return;
      }
      flippedCount = flipped.count;
      await tx.crmLoyaltyAccount.update({
        where: { id: accountId },
        data: {
          pendingPoints: { decrement: earn.points },
          lifetimeEligibleSpendCents: { decrement: spendBack },
          balanceVersion: { increment: 1 }
        }
      });
    });
    if (flippedCount === 0) {
      return { status: "skipped", reason: "already reversed (concurrent flip)" };
    }
    return { status: "reversed", points: earn.points };
  }

  // AVAILABLE: history stays intact — post a NEW signed-negative REVERSE row.
  // UNIQUE(source, sourceId, REVERSE) makes a replayed refund a no-op.
  try {
    await prisma.$transaction(async (tx) => {
      await tx.crmPointsLedger.create({
        data: {
          accountId,
          merchantId: earn.merchantId,
          locationId: earn.locationId,
          type: "REVERSE",
          points: -earn.points,
          status: "AVAILABLE",
          source,
          sourceId,
          reversesLedgerId: earn.id,
          occurredAt
        }
      });
      await tx.crmLoyaltyAccount.update({
        where: { id: accountId },
        data: {
          balancePoints: { decrement: earn.points },
          lifetimeEligibleSpendCents: { decrement: spendBack },
          balanceVersion: { increment: 1 }
        }
      });
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      return { status: "skipped", reason: "already reversed (idempotent)" };
    }
    throw err;
  }
  return { status: "reversed", points: earn.points };
}
