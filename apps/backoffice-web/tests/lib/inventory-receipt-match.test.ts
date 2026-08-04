import { describe, expect, it } from "vitest";

import { normalizeAlias, type InventoryDataset, type InventoryItemAlias } from "@rop/contracts";

import { bestCatalogMatch } from "@/lib/inventory/receipt-match";

type Item = InventoryDataset["items"][number];

function item(id: string, name: string): Item {
  return {
    id,
    sku: id,
    name,
    category: "dairy",
    unit: "ea",
    unit_kind: "count",
    on_hand: 0,
    par_min: 0,
    par_max: 0,
    cost_cents: 0,
    purchase_unit: "",
    pack_qty: 1,
    purchase_cost_cents: 0,
    vendor: "",
    shelf_days: 0,
    last_counted: "2026-06-06",
    flagged_86: false,
    archived: false,
  };
}

function alias(itemId: string, raw: string, vendor: string): InventoryItemAlias {
  return {
    id: `alias-${itemId}-${raw}`,
    item_id: itemId,
    vendor: normalizeAlias(vendor),
    vendor_label: vendor,
    normalized: normalizeAlias(raw),
    raw,
    brand: "",
    pack: "",
    pack_id: null,
    source: "receive",
    last_cost_cents: null,
    hits: 1,
    last_seen_at: "2026-01-01T00:00:00.000Z",
  };
}

const milk = item("item-milk", "Milk 12 oz");
const oatMilk = item("item-oat", "Oat Milk");
const items = [milk, oatMilk];

describe("bestCatalogMatch", () => {
  it("falls back to fuzzy name matching with no aliases (unchanged behavior)", () => {
    expect(bestCatalogMatch("MILK 12 OZ", items)).toBe(milk.id);
    expect(bestCatalogMatch("totally unknown thing", items)).toBe("");
  });

  it("tier 0: a learned alias wins over fuzzy (the memory)", () => {
    const aliases = [alias(milk.id, "MEMBER'S MARK WHOLE MILK 12 OZ", "Sam's Club")];
    // Fuzzy alone might mis-handle the brand words; the learned alias resolves it exactly.
    expect(
      bestCatalogMatch("Member's Mark Whole Milk 12oz", items, {
        aliases,
        vendor: "Sam's Club",
      }),
    ).toBe(milk.id);
  });

  it("ignores a learned alias that points at a since-removed item and falls back to fuzzy", () => {
    const aliases = [alias("item-deleted", "MEMBER'S MARK MILK 12 OZ", "Sam's Club")];
    // The alias target is not in `items`, so it can't be used; fuzzy on the canonical
    // name still finds the real milk.
    expect(
      bestCatalogMatch("MEMBER'S MARK MILK 12 OZ", items, {
        aliases,
        vendor: "Sam's Club",
        canonicalName: "Milk 12 oz",
      }),
    ).toBe(milk.id);
  });

  it("tier 1: matches on the AI canonical name when the raw line is brand-heavy", () => {
    // No alias yet; the raw line is noisy, but the model's clean canonical name matches.
    expect(
      bestCatalogMatch("MEMBERS MARK PREMIUM OAT BEVERAGE", items, {
        canonicalName: "Oat Milk",
      }),
    ).toBe(oatMilk.id);
  });
});
