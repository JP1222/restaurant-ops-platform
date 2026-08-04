import { describe, expect, test } from "vitest";
import { InventoryPurchaseOrderCreateSchema, type InventoryItem } from "@rop/contracts";

import { NO_VENDOR_LABEL, buildPosFromCart } from "@/lib/inventory/reorder-cart";

const ITEM_DEFAULTS: Omit<InventoryItem, "id" | "name"> = {
  sku: "SKU",
  category: "packaging",
  unit: "each",
  unit_kind: "count",
  on_hand: 10,
  par_min: 5,
  par_max: 20,
  cost_cents: 52,
  purchase_unit: "Case",
  pack_qty: 1,
  purchase_cost_cents: 5000,
  vendor: "Acme",
  shelf_days: 30,
  last_counted: "2026-06-01",
  flagged_86: false,
  archived: false,
};

function mkItem(over: Partial<InventoryItem> & Pick<InventoryItem, "id" | "name">): InventoryItem {
  return { ...ITEM_DEFAULTS, ...over };
}

function byId(...items: InventoryItem[]): Record<string, InventoryItem> {
  return Object.fromEntries(items.map((item) => [item.id, item]));
}

describe("buildPosFromCart", () => {
  test("empty cart builds no POs", () => {
    expect(buildPosFromCart({}, byId(mkItem({ id: "i1", name: "Cups" })))).toEqual([]);
  });

  test("groups cart items into one PO per vendor, lines keyed by item id", () => {
    const items = byId(
      mkItem({ id: "i1", name: "16oz Cups", vendor: "Acme", cost_cents: 52 }),
      mkItem({ id: "i2", name: "Lids", vendor: "Acme", cost_cents: 31 }),
      mkItem({ id: "i3", name: "Whole Milk", vendor: "Freshway", cost_cents: 410 })
    );
    expect(buildPosFromCart({ i1: 4, i2: 2, i3: 6 }, items)).toEqual([
      {
        vendor: "Acme",
        lines: [
          { sku: "i1", qty_ordered: 4, unit_cost_cents: 52 },
          { sku: "i2", qty_ordered: 2, unit_cost_cents: 31 },
        ],
      },
      {
        vendor: "Freshway",
        lines: [{ sku: "i3", qty_ordered: 6, unit_cost_cents: 410 }],
      },
    ]);
  });

  test("vendor order follows first appearance in the cart", () => {
    const items = byId(
      mkItem({ id: "i1", name: "Milk", vendor: "Freshway" }),
      mkItem({ id: "i2", name: "Cups", vendor: "Acme" }),
      mkItem({ id: "i3", name: "Cream", vendor: "Freshway" })
    );
    const vendors = buildPosFromCart({ i1: 1, i2: 1, i3: 1 }, items).map((po) => po.vendor);
    expect(vendors).toEqual(["Freshway", "Acme"]);
  });

  test("drops ids missing from the catalog and non-positive quantities", () => {
    const items = byId(mkItem({ id: "i1", name: "Cups" }), mkItem({ id: "i2", name: "Lids" }));
    expect(buildPosFromCart({ i1: 3, i2: 0, ghost: 5 }, items)).toEqual([
      { vendor: "Acme", lines: [{ sku: "i1", qty_ordered: 3, unit_cost_cents: 52 }] },
    ]);
  });

  test("items without a vendor group under the no-vendor label", () => {
    const items = byId(
      mkItem({ id: "i1", name: "Mystery Sauce", vendor: "" }),
      mkItem({ id: "i2", name: "Napkins", vendor: "  " })
    );
    expect(buildPosFromCart({ i1: 1, i2: 2 }, items)).toEqual([
      {
        vendor: NO_VENDOR_LABEL,
        lines: [
          { sku: "i1", qty_ordered: 1, unit_cost_cents: 52 },
          { sku: "i2", qty_ordered: 2, unit_cost_cents: 52 },
        ],
      },
    ]);
  });

  test("preserves sub-cent unit costs and satisfies the create-PO contract", () => {
    const items = byId(
      mkItem({ id: "i1", name: "Vanilla Syrup", cost_cents: 12.5 }),
      mkItem({ id: "i2", name: "Sauce", vendor: "" })
    );
    const pos = buildPosFromCart({ i1: 3, i2: 1 }, items);
    expect(pos[0]?.lines[0]?.unit_cost_cents).toBe(12.5);
    for (const po of pos) {
      expect(InventoryPurchaseOrderCreateSchema.safeParse(po).success).toBe(true);
    }
  });
});
