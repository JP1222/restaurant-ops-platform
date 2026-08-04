import { z } from "zod";

/**
 * Inbound validation for the BFF route POST /api/order/checkout.
 *
 * This guards the **dollars-shaped** body that lib/api.ts sends (mirrors
 * lib/types.ts `OrderCheckoutRequest`) — NOT the integer-cents wire contract
 * `OrderCheckoutRequestSchema` in packages/contracts, which is what the handler
 * forwards to kds-api *after* the dollars→cents conversion.
 *
 * Why it exists: the handler converts `tip` (dollars) → cents with
 * `dollarsToCents()`, which throws `RangeError` on a non-finite input, and that
 * conversion runs OUTSIDE the route's try/catch. A client (or stale
 * localStorage state) sending a truthy non-number `tip` would otherwise surface
 * as an uncaught 500 instead of a clean 400 — and a JS-coercible value like
 * "5" (`"5" * 100 === 500`) would silently become a $5 tip. A STRICT
 * `z.number()` (never `z.coerce.number()`) rejects every non-number, turning
 * both the crash and the silent coercion into a 400. kds-api re-prices and
 * charges authoritatively, so this is robustness / DoS hardening, not a
 * money-correctness fix.
 */
export const CheckoutRequestSchema = z.object({
  orderId: z.string().min(1),
  paymentToken: z.string().min(1),
  // dollars; optional (no tip selector yet — design-brief §7.5). `.finite()`
  // mirrors `dollarsToCents`'s own `Number.isFinite` guard so the validation
  // boundary and the conversion boundary agree.
  tip: z.number().finite().min(0).optional(),
});

export type CheckoutRequestBody = z.infer<typeof CheckoutRequestSchema>;
