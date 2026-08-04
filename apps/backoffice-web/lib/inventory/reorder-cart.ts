import type { InventoryItem, InventoryPurchaseOrderCreate } from "@rop/contracts";

export const NO_VENDOR_LABEL = "No vendor";

// Group the quick-reorder cart (item id → qty) into one PO per vendor, the same
// payload shape NewPoBuilder submits: `sku` carries the item id and unit_cost_cents
// is the item's per-usage cost (may be sub-cent; it feeds the order total only).
// Items missing from the catalog or with a non-positive qty are dropped. Items with
// no vendor still need a valid PO (the contract requires a non-empty vendor), so
// they group under NO_VENDOR_LABEL — the same fallback the action queue displays.
// Vendor order follows first appearance in the cart, matching the reorder drawer.
export function buildPosFromCart(
  cart: Record<string, number>,
  byId: Record<string, InventoryItem>
): InventoryPurchaseOrderCreate[] {
  const byVendor = new Map<string, InventoryPurchaseOrderCreate>();
  for (const [id, qty] of Object.entries(cart)) {
    const item = byId[id];
    if (!item || !(qty > 0)) continue;
    const vendor = item.vendor.trim() || NO_VENDOR_LABEL;
    let po = byVendor.get(vendor);
    if (!po) {
      po = { vendor, lines: [] };
      byVendor.set(vendor, po);
    }
    po.lines.push({ sku: item.id, qty_ordered: qty, unit_cost_cents: item.cost_cents });
  }
  return [...byVendor.values()];
}
