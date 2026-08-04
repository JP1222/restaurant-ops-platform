// points-earn-rules.ts — DESIGN SPIKE for the Example Kitchen loyalty engine.
//
// This is the ONE place the loyalty *business strategy* lives. Everything else in
// the points system — the append-only ledger, idempotency, refund reversals,
// expiry jobs, multi-location rollup — is mechanical and provider-agnostic
// (see docs/design/loyalty/loyalty-system-design.md §4). This module encodes
// "how a Example Kitchen customer earns and redeems points."
//
// Self-contained on purpose (types inline) so it compiles + unit-tests alone,
// then drops into packages/loyalty-engine (or apps/crm-api/src/domain) per ADR-0021.
//
// PURE: same input -> same output, no I/O, no clock, no db. Idempotency,
// PENDING->AVAILABLE promotion, and reversals are the LEDGER's job, not here.
//
// Numbers are the workflow-researched recommendation and are OWNER-TUNABLE:
// they are isolated into the constants block + REWARD_CATALOG so the policy
// changes without touching the mechanism. Sign-off = design doc §7.

// ── Canonical input (POS-agnostic) ───────────────────────────────────────────
/** A completed, PAID order, already normalized across POS providers. */
export interface CompletedOrder {
  orderId: string;
  provider: string; // "clover" | "deliverect" | future "toast" | "square"
  locationId: string;
  subtotalCents: number; // pre-tax/pre-tip total (audit only; basis is recomputed from items)
  taxCents: number;
  tipCents: number;
  items: OrderLine[];
}

export interface OrderLine {
  nameId: string;
  chargedCents: number; // what the customer actually paid for this line, pre-tax
  isGiftCardPurchase: boolean; // buying a gift card must NOT earn (double-dip + farm vector)
  wasRewardRedemption: boolean; // a free/discounted line from a redeemed reward must NOT re-earn
  refunded?: boolean; // a refunded line is excluded from the eligible basis
}

export interface EarnResult {
  points: number;
  basisCents: number; // the dollar basis rewarded — stored on the EARN ledger row for audit
}

// ── Owner knobs (the strategy) ────────────────────────────────────────────────
// The RATE is cosmetic: 10/$1 is economically identical to 1/$1. What is
// load-bearing is rate / reward-threshold = effective give-back %. Target band is
// 5-10% (F&B norm); Example Kitchen sits at the generous end (~7-8.5%) because drinks +
// toppings are high-margin. See design doc §3.
export const POINTS_PER_DOLLAR = 10;

// Providers that do NOT earn points. 3rd-party / marketplace orders (Deliverect)
// have no reliable payment signal and thinner margin -> earn 0 (design doc §8, ADR-0022).
export const NON_EARNING_PROVIDERS: ReadonlySet<string> = new Set(["deliverect"]);

// ── Earn policy ───────────────────────────────────────────────────────────────
/**
 * Compute points earned for one completed, paid order.
 *
 *   BASIS  pre-tax subtotal of ELIGIBLE lines only — excludes gift-card purchases,
 *          reward-redeemed lines, refunded lines, tax & tip. (Chipotle/Cava/Dunkin norm.)
 *   RATE   POINTS_PER_DOLLAR.
 *   ROUND  Math.floor — never over-credits; explainable on a counter card.
 *
 * Integer-cents arithmetic (multiply BEFORE divide) avoids floating-point drift:
 * a $6.49 line -> floor(649 * 10 / 100) = floor(64.9) = 64 pts.
 */
export function calculatePointsEarned(order: CompletedOrder): EarnResult {
  if (NON_EARNING_PROVIDERS.has(order.provider)) {
    return { points: 0, basisCents: 0 };
  }

  const basisCents = order.items.reduce((sum, line) => {
    const eligible =
      !line.isGiftCardPurchase && !line.wasRewardRedemption && !line.refunded;
    return eligible ? sum + Math.max(0, line.chargedCents) : sum;
  }, 0);

  const points = Math.floor((basisCents * POINTS_PER_DOLLAR) / 100);
  return { points, basisCents };
}

// ── Reward catalog (the redemption ladder) ────────────────────────────────────
// Low-threshold, multi-rung so a reward fires every ~1-8 visits and a near-goal is
// always visible (goal-gradient effect). These rows become the owner-editable
// CrmReward table (Phase 3); encoded here as the design default.
export type RewardKind = "FREE_ITEM" | "DISCOUNT" | "DOLLAR_CREDIT";

export interface Reward {
  slug: string;
  label: string;
  costPoints: number;
  kind: RewardKind;
  valueCents: number; // for liability accounting / cost-per-point
  couponTtlDays: number; // tight window on the issued coupon forces a return visit
  minLifetimeSpendCents?: number; // gate (e.g. birthday)
}

export const REWARD_CATALOG: readonly Reward[] = [
  { slug: "free-topping", label: "Free topping or boba add-on", costPoints: 100, kind: "FREE_ITEM", valueCents: 100, couponTtlDays: 30 },
  { slug: "size-up", label: "Free size upgrade / single boba", costPoints: 175, kind: "FREE_ITEM", valueCents: 125, couponTtlDays: 30 },
  { slug: "two-off", label: "$2 off any order", costPoints: 300, kind: "DISCOUNT", valueCents: 200, couponTtlDays: 30 },
  { slug: "store-cash-5", label: "$5 Store Cash (credit toward anything)", costPoints: 600, kind: "DOLLAR_CREDIT", valueCents: 500, couponTtlDays: 30 },
  { slug: "free-regular", label: "Free regular rolled ice cream / boba / smoothie", costPoints: 850, kind: "FREE_ITEM", valueCents: 650, couponTtlDays: 30 },
  { slug: "free-premium", label: "Free large / premium creation", costPoints: 1200, kind: "FREE_ITEM", valueCents: 850, couponTtlDays: 30 },
];

// Non-purchase point sources — all gated to block farming (design doc §3).
export const SIGNUP_BONUS_POINTS = 200; // held PENDING until first qualifying purchase
export const REFERRER_BONUS_POINTS = 200; // credited after the referred friend's first $5+ order
export const REFERRAL_QUALIFYING_CENTS = 500; // $5 minimum

export interface RedeemCheck {
  ok: boolean;
  reason?: string;
}

/**
 * Pure guard: can this account redeem this reward right now? The actual REDEEM
 * debit + coupon issue (with idempotency + TTL) is the ledger's job, not here.
 */
export function canRedeem(
  reward: Reward,
  availablePoints: number,
  lifetimeSpendCents: number,
): RedeemCheck {
  if (availablePoints < reward.costPoints) {
    return { ok: false, reason: `needs ${reward.costPoints - availablePoints} more points` };
  }
  if (reward.minLifetimeSpendCents && lifetimeSpendCents < reward.minLifetimeSpendCents) {
    return { ok: false, reason: "lifetime-spend gate not met" };
  }
  return { ok: true };
}
