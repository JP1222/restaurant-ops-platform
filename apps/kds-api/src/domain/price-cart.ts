import type { CreateOrderRequest, OrderMenuResponse } from "@rop/contracts";

/**
 * Server-authoritative cart pricing. The client sends advisory `unitPriceCents`
 * (ADR-0027), but we re-price every line from the live Clover catalog (PR3a) so
 * a tampered client total can never become the charge.
 *
 * Safe-by-default policy: if ANY line references an item or modifier that is no
 * longer in the catalog or is unavailable, we REJECT the whole order rather than
 * silently dropping a line or guessing a price — the customer re-confirms a menu
 * that is real. (Flip to per-line adjustment later if that UX is preferred.)
 */

export interface PricedLine {
  name: string; // catalog item name, used for the Clover order line
  unitPriceCents: number; // authoritative: catalog base + selected modifier deltas
  quantity: number;
  modifierNames: string[];
}

export interface PricedCart {
  lines: PricedLine[];
  subtotalCents: number;
}

export type PriceCartResult =
  | { ok: true; cart: PricedCart }
  | { ok: false; reason: string; lineId: string };

export function priceCart(
  request: CreateOrderRequest,
  menu: OrderMenuResponse,
): PriceCartResult {
  const itemsById = new Map(menu.items.map((item) => [item.id, item]));
  const lines: PricedLine[] = [];
  let subtotalCents = 0;

  for (const line of request.lines) {
    const item = itemsById.get(line.itemId);
    if (!item || !item.available) {
      return {
        ok: false,
        reason: `"${line.itemName}" is no longer available.`,
        lineId: line.lineId,
      };
    }

    const modifiersById = new Map(
      item.modifierGroups.flatMap((group) => group.modifiers).map((mod) => [mod.id, mod]),
    );

    let unitPriceCents = item.priceCents;
    const modifierNames: string[] = [];
    for (const chosen of line.modifiers) {
      const known = modifiersById.get(chosen.id);
      if (!known) {
        return {
          ok: false,
          reason: `An option on "${item.name}" is no longer available.`,
          lineId: line.lineId,
        };
      }
      unitPriceCents += known.priceDeltaCents;
      modifierNames.push(known.name);
    }

    lines.push({ name: item.name, unitPriceCents, quantity: line.quantity, modifierNames });
    subtotalCents += unitPriceCents * line.quantity;
  }

  return { ok: true, cart: { lines, subtotalCents } };
}
