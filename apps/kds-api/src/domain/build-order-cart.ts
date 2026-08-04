import type { PricedLine } from "./price-cart.js";

/**
 * Build the Clover `orderCart` payload (shared by `atomic_order/checkouts` and
 * `atomic_order/orders`) from priced cart lines. Quantity is expanded into
 * repeated ad-hoc line items (`{name, price}`), which Clover accepts without any
 * pre-seeded inventory (verified in the sandbox).
 *
 * `orderTypeId`: reference a REAL taxable order type by id so Clover applies tax.
 * We omit `orderType` entirely when the merchant has none — an INLINE definition
 * like `{taxable:true}` is rejected ("Referenced order type does not exist",
 * verified in the sandbox), so passing one breaks order creation.
 */
export function buildOrderCart(
  lines: PricedLine[],
  orderTypeId: string | null,
): Record<string, unknown> {
  const cart: Record<string, unknown> = {
    lineItems: lines.flatMap((line) =>
      Array.from({ length: line.quantity }, () => ({
        name: line.name,
        price: line.unitPriceCents,
      })),
    ),
  };
  if (orderTypeId) {
    cart.orderType = { id: orderTypeId };
  }
  return cart;
}
