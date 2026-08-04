// The pure earn engine — promoted from the Phase-1 design spike
// (docs/design/loyalty/points-earn-rules.ts), which was written self-contained
// precisely so it could "drop into apps/crm-api/src/domain per ADR-0021". This
// is that drop. PURE: same input -> same output, no I/O, no clock, no db.
//
// Idempotency, PENDING->AVAILABLE promotion, and refund reversals are the
// LEDGER's job (see accrual.ts), NOT here. Numbers are owner-tunable and live in
// the constants block; the policy changes without touching the mechanism.
// Redemption (REWARD_CATALOG / canRedeem) lands in Phase 5.
import type { EarnLine } from "@rop/contracts";

// EarnLine moved to @rop/contracts in PR4c — it now crosses the
// kds-api → crm-api boundary as part of OrderCompletedEvent (ADR-0025).
// Re-exported here so existing `./earn.js` importers stay unchanged.
export type { EarnLine };

export interface EarnInput {
  provider: string; // "clover" | "deliverect" | future "toast" | "square"
  items: EarnLine[];
}

export interface EarnResult {
  points: number;
  basisCents: number; // the dollar basis rewarded — stored on the EARN ledger row for audit
}

// The RATE is cosmetic: 10/$1 is economically identical to 1/$1. What is
// load-bearing is rate / reward-threshold = effective give-back % (~7-8.5% target).
export const POINTS_PER_DOLLAR = 10;

// Providers that do NOT earn points. 3rd-party / marketplace orders (Deliverect)
// have no reliable payment signal and thinner margin -> earn 0 (ADR-0022).
export const NON_EARNING_PROVIDERS: ReadonlySet<string> = new Set(["deliverect"]);

/**
 * Points earned for one completed, PAID order.
 *   BASIS  pre-tax subtotal of ELIGIBLE lines only — excludes gift-card purchases,
 *          reward-redeemed lines, refunded lines, tax & tip.
 *   RATE   POINTS_PER_DOLLAR.
 *   ROUND  Math.floor — never over-credits.
 * Integer-cents arithmetic (multiply BEFORE divide) avoids float drift.
 */
export function calculatePointsEarned(order: EarnInput): EarnResult {
  if (NON_EARNING_PROVIDERS.has(order.provider)) {
    return { points: 0, basisCents: 0 };
  }
  const basisCents = order.items.reduce((sum, line) => {
    const eligible = !line.isGiftCardPurchase && !line.wasRewardRedemption && !line.refunded;
    // EarnLineSchema.chargedCents is .nonnegative() (GH #464), so the defensive
    // Math.max(0, …) clamp here was dead — and worse, it silently swallowed a
    // malformed negative line instead of letting it dead-letter as a contract bug.
    return eligible ? sum + line.chargedCents : sum;
  }, 0);
  const points = Math.floor((basisCents * POINTS_PER_DOLLAR) / 100);
  return { points, basisCents };
}
