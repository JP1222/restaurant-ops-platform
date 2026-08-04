import { z } from "zod";

/**
 * Inbound-body schema for `POST /api/order` (the draft-pricing BFF).
 *
 * This validates the **dollars** cart the browser sends (mirrors the
 * hand-written `OrderRequest` / `CartLine` / `Modifier` DTOs in `lib/types.ts`),
 * NOT the integer-cents wire contract (`CreateOrderRequestSchema` in
 * `packages/contracts`). The dollars→cents conversion happens just after this,
 * at the BFF boundary (`lib/money.ts`).
 *
 * WHY this exists: `dollarsToCents` throws a `RangeError` on any non-finite
 * input (`NaN`, `Infinity`, or a non-number like `"abc"` / `null` / `{}` once
 * it hits `* 100`). The route only shape-checked `Array.isArray(lines)`, so a
 * client — or a stale-localStorage cart — sending a bad `unitPrice` /
 * `priceDelta` reached the `.map`, threw, and surfaced as an unhandled 500
 * instead of a clean 400. `safeParse`-ing this schema first moves that failure
 * to a 400. (Same bug class as the `tip` fix in the sibling checkout route.)
 *
 * VALIDATION ALTITUDE — this schema owns exactly two jobs:
 *   1. Don't crash: every value that flows into `dollarsToCents` must be a
 *      finite number (`.finite()`). This is the load-bearing rule.
 *   2. Be structurally well-formed enough to map over: a non-empty `lines`
 *      array, and numbers within the range kds-api's INPUT contract accepts
 *      (`unitPriceCents: int().min(0)`, `quantity: int().min(1)`) so we never
 *      forward a number kds-api would only reject.
 *
 * Everything else — string lengths, whether a name is "adequate" — is left to
 * kds-api, which re-validates with its own contract AND re-prices the cart
 * authoritatively. Duplicating those semantic string rules here would only
 * create drift (the BFF rejecting something kds-api accepts, or vice versa) for
 * no gain, so the string fields are type-checked but not bounded or trimmed —
 * the BFF forwards them verbatim and lets the single source of truth decide.
 * (Pathological oversized bodies are bounded at the edge / by kds-api, not by
 * per-field caps duplicated here.)
 */

const ModifierSchema = z.object({
  id: z.string(),
  name: z.string(),
  // Finite only: kds-api's `priceDeltaCents` has no lower bound (a negative
  // delta is a valid discount-style modifier), so we just guard the crash.
  priceDelta: z.number().finite(),
});

const CartLineSchema = z.object({
  lineId: z.string(),
  itemId: z.string(),
  itemName: z.string(),
  // dollars; matches kds-api `unitPriceCents: int().min(0)` — finite (no crash)
  // and non-negative (kds-api rejects a negative one at its boundary too).
  unitPrice: z.number().finite().min(0),
  // Matches kds-api `quantity: int().min(1)`. Not run through dollarsToCents,
  // but a non-integer / <1 quantity is meaningless and kds-api rejects it.
  quantity: z.number().int().min(1),
  // Preserve the route's old `?? []` tolerance: a stale-localStorage line may
  // carry `modifiers: null`. `.nullish()` accepts null|undefined; the transform
  // normalizes both to [] so the downstream `.map` never sees a nullish value.
  modifiers: z
    .array(ModifierSchema)
    .nullish()
    .transform((m) => m ?? []),
  notes: z.string().optional(),
});

export const OrderRequestSchema = z.object({
  // Required to be a present string (the cents payload needs it), but its
  // length/content is kds-api's to enforce (`min(1).max(120)`), not ours.
  customerName: z.string(),
  customerPhone: z.string().optional(),
  customerEmail: z.string().optional(),
  notes: z.string().optional(),
  // `.min(1)` subsumes the old empty-cart guard: zero lines is a 400.
  lines: z.array(CartLineSchema).min(1),
});

/** Validated, normalized inbound order (dollars). `modifiers` is always an array. */
export type ValidatedOrderRequest = z.infer<typeof OrderRequestSchema>;
