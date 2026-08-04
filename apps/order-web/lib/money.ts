/**
 * Dollars ↔ integer-cents conversion — the single boundary where the
 * order-web UI's dollar amounts (lib/types.ts `Money`) meet the suite's
 * integer-cents wire contract (packages/contracts, kds-api `/api/order/*`).
 *
 * Kept in one tiny module so there is exactly ONE place this conversion
 * happens. Called only inside the `app/api/order/*` BFF route handlers
 * (server-side), never scattered through the UI — so a rounding mistake can't
 * silently leak into a charge.
 *
 * WHY round (not floor/trunc): `7.99 * 100` is `798.9999999999999` in IEEE-754
 * double, so `Math.trunc` would undercharge to $7.98. `Math.round` recovers
 * 799. Every dollar value the UI produces has at most two decimal places, so
 * exact half-cent ties never occur in practice and round-half-up vs banker's
 * rounding is moot here.
 *
 * NOTE (for review): the dollar amounts the UI shows are ADVISORY — kds-api
 * re-prices the cart authoritatively from the catalog at checkout (see the
 * `unitPriceCents` comment in packages/contracts/src/order.ts), so a cent of
 * client-side float drift can never become the actual charge. This conversion
 * only has to be faithful for display and for the draft request.
 */

/** UI dollars (e.g. 7.99) → integer cents (799). */
export function dollarsToCents(dollars: number): number {
  if (!Number.isFinite(dollars)) {
    throw new RangeError(`dollarsToCents: non-finite input ${dollars}`);
  }
  return Math.round(dollars * 100);
}

/** Integer cents (799) → UI dollars (7.99). */
export function centsToDollars(cents: number): number {
  if (!Number.isInteger(cents)) {
    // The wire contract is integer cents; a fractional value means an upstream
    // broke its own contract — fail loud rather than render a sub-cent price.
    throw new RangeError(`centsToDollars: expected integer cents, got ${cents}`);
  }
  return cents / 100;
}
