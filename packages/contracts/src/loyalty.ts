/**
 * Loyalty / CRM **cross-app** contracts.
 *
 * The one event that crosses an app boundary in the loyalty domain: kds-api
 * (the order producer) hands a completed/refunded order to crm-api (the loyalty
 * consumer) via a BullMQ queue — **never** a shared database (Iron Law #1:
 * kds-api must never import `@rop/db-crm`). The queue is the boundary;
 * this module is its shared shape.
 *
 * These types started life inside `apps/crm-api/src/domain` (the accrual engine
 * was built + tested before any producer existed). They migrate here the moment
 * kds-api emits them, per the [ADR-0025] prototype-DTO rule — "a DTO lives local
 * until it crosses an app boundary, then it moves to contracts." This is that
 * move (PR4c). crm-api re-exports them from their old paths so existing imports
 * keep working.
 *
 * Money is **integer cents** (suite house rule). See ADR-0022 (accrual / REVERSE
 * semantics) and ADR-0024 (phone-keyed CRM identity).
 */
import { z } from "zod";

/**
 * BullMQ queue name for the order → loyalty-accrual hand-off. Shared so the
 * kds-api producer and the crm-api worker agree on the exact string without
 * either importing the other (the name is itself a cross-app contract). The
 * queue lives on the KDS Redis (kds-api already connects to it); the crm-api
 * worker connects to that *same* Redis to consume — a message bus, not a
 * shared system-of-record, so Iron Law #1 (the Postgres boundary) is intact.
 */
export const CRM_LOYALTY_ACCRUAL_QUEUE = "crm-loyalty-accrual";

/**
 * One charged line of a completed order, reduced to just what the earn engine
 * needs. The accrual BASIS is the sum of `chargedCents` over *eligible* lines —
 * gift-card purchases and reward-redeemed lines never earn (double-dip / farm
 * vectors), and refunded lines drop out of the basis.
 */
export const EarnLineSchema = z.object({
  // What the customer paid for this line, pre-tax. `.nonnegative()` (GH #464):
  // a negative line price is a malformed/contract-broken payload, so reject it
  // at the boundary (→ worker dead-letters per "validate at the boundary") rather
  // than letting the earn engine silently clamp it to 0 and swallow the bug.
  chargedCents: z.number().int().nonnegative(),
  isGiftCardPurchase: z.boolean(), // buying stored value must NOT earn
  wasRewardRedemption: z.boolean(), // a redeemed/free line must NOT re-earn
  refunded: z.boolean().optional() // a refunded line is excluded from the basis
});
export type EarnLine = z.infer<typeof EarnLineSchema>;

/**
 * The event kds-api emits when an order reaches a paid (earn) or refunded
 * (reverse) terminal state. Consumed by the crm-api loyalty worker, which turns
 * it into ledger movement exactly once (idempotent on `internalOrderId`).
 *
 * - `phoneE164` is the accrual key — **null = anonymous order**, the consumer
 *   skips it (presence of a phone is the only switch; no special-casing). The
 *   producer ferries the provider's *loose* phone (kds-api never formats
 *   phones); the crm-api worker canonicalizes to E.164 before the ledger lookup
 *   (its `normalizeE164` chokepoint, ADR-0024).
 * - `occurredAt` is the **provider clock** (`order.modifiedAt`), never server
 *   time, so replays and reconciliation stay deterministic.
 * - `internalOrderId` is the idempotency key, e.g. `"clover:<merchant>:<order>"`.
 */
export const OrderCompletedEventSchema = z.object({
  provider: z.string(), // "clover" | "deliverect" | future "toast" | "square"
  items: z.array(EarnLineSchema),
  merchantId: z.string(), // suite store identifier (conceptually Location, ADR-0019)
  locationId: z.string().nullable().optional(),
  internalOrderId: z.string(), // idempotency key (e.g. "clover:merchant:order")
  occurredAt: z.string(), // ISO, provider clock (order.modifiedAt) — never server time
  phoneE164: z.string().nullable(), // accrual key; null = anonymous → no accrual
  isRefund: z.boolean(),
  source: z.string().optional() // ledger source tag; defaults to "<provider>_order"
});
export type OrderCompletedEvent = z.infer<typeof OrderCompletedEventSchema>;

/**
 * Guest cohort analytics (RFM) — the operator-facing read for the backoffice
 * `/guests` page. crm-api computes it from the loyalty data it owns and returns
 * only **aggregates**: counts and integer-cent spend per segment, never a phone,
 * name, or any per-customer row. The customer-level PII never leaves crm-api, so
 * the analytics/AI surfaces consume cohorts without ever holding loyalty PII.
 *
 * RFM here is lifetime-based: Recency = days since last eligible order, Frequency
 * = count of eligible orders, Monetary = lifetime eligible spend. Each active
 * member is scored 1–5 (quintiles) on each axis and mapped to one segment.
 */
export const loyaltySegmentKeys = [
  "champions",
  "loyal",
  "potential_loyalist",
  "needs_attention",
  "at_risk",
  "hibernating"
] as const;
export const LoyaltySegmentKeySchema = z.enum(loyaltySegmentKeys);
export type LoyaltySegmentKey = z.infer<typeof LoyaltySegmentKeySchema>;

export const LoyaltyCohortSchema = z.object({
  key: LoyaltySegmentKeySchema,
  member_count: z.number().int().nonnegative(),
  total_spend_cents: z.number().int().nonnegative(),
  avg_recency_days: z.number().nonnegative().nullable(), // null when the segment is empty
  pct_of_active: z.number().min(0).max(1) // share of active members
});
export type LoyaltyCohort = z.infer<typeof LoyaltyCohortSchema>;

export const LoyaltyNewVsReturningSchema = z.object({
  new_count: z.number().int().nonnegative(), // active members with exactly one eligible order
  new_spend_cents: z.number().int().nonnegative(),
  returning_count: z.number().int().nonnegative(), // two or more eligible orders
  returning_spend_cents: z.number().int().nonnegative()
});
export type LoyaltyNewVsReturning = z.infer<typeof LoyaltyNewVsReturningSchema>;

export const LoyaltyCohortsResponseSchema = z.object({
  as_of: z.string(), // ISO timestamp the cohorts were computed at
  total_members: z.number().int().nonnegative(), // all enrolled loyalty accounts
  active_members: z.number().int().nonnegative(), // members with >=1 eligible order (the RFM base)
  segments: z.array(LoyaltyCohortSchema),
  new_vs_returning: LoyaltyNewVsReturningSchema
});
export type LoyaltyCohortsResponse = z.infer<typeof LoyaltyCohortsResponseSchema>;
