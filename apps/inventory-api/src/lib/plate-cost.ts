import type { PlateCostSnapshot } from "@rop/contracts";

export interface RecipeForCosting {
  cloverItemId: string | null;
  lines: { sku: string; qty: number }[];
}

/**
 * Plate cost per Clover menu item, from each recipe's base BOM x ingredient cost
 * (ADR-0031). `costBySku` holds the per-usage cost already normalized by the item
 * editor (`purchaseCostCents / packQty`), so no unit conversion happens here —
 * plate cost is simply `sum(line.qty * cost)`.
 *
 * A recipe is emitted ONLY when it has a Clover link, a non-empty BOM, and EVERY
 * ingredient resolves to a known cost. If any ingredient cost is missing (or the
 * BOM is empty), the plate cost is *unknown* and the item is omitted — we never
 * treat a missing cost as $0, which would understate cost and falsely mark a
 * high-price item a Star (roadmap invariant #6). A cost of exactly 0 is a valid,
 * known cost (a free/promo ingredient) and is kept.
 */
export function computePlateCosts(
  recipes: RecipeForCosting[],
  costBySku: Map<string, number>,
  effectiveFrom: string,
): PlateCostSnapshot[] {
  const snapshots: PlateCostSnapshot[] = [];
  for (const recipe of recipes) {
    if (recipe.cloverItemId === null || recipe.lines.length === 0) {
      continue;
    }
    let total = 0;
    let complete = true;
    for (const line of recipe.lines) {
      const cost = costBySku.get(line.sku);
      if (cost === undefined) {
        complete = false;
        break;
      }
      total += line.qty * cost;
    }
    if (!complete) {
      continue;
    }
    snapshots.push({
      clover_item_id: recipe.cloverItemId,
      plate_cost_cents: total,
      currency: "USD",
      effective_from: effectiveFrom,
    });
  }
  return snapshots;
}
