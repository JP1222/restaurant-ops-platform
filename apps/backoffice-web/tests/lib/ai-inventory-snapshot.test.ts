import { describe, expect, test } from "vitest";
import type { InventoryItem, InventoryItemAlias } from "@rop/contracts";
import {
  buildInventoryOverview,
  searchInventory,
  vendorPriceLookup,
} from "@/lib/ai/inventory-snapshot";

const NOW = "2026-06-05T12:00:00.000Z";

const DEFAULTS: Omit<InventoryItem, "id" | "name"> = {
  sku: "SKU",
  category: "topping",
  unit: "each",
  unit_kind: "count",
  on_hand: 10,
  par_min: 5,
  par_max: 20,
  cost_cents: 50,
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
  return { ...DEFAULTS, ...over };
}

// statusOf: 86 if flagged; critical if on_hand < par_min*0.5; low if < par_min;
// over if > par_max; else ok.
function source(items: InventoryItem[]) {
  return { items, categories: [] };
}

describe("buildInventoryOverview", () => {
  const dataset = source([
    mkItem({ id: "ok1", name: "Healthy Topping", on_hand: 10, par_min: 5, par_max: 20 }),
    mkItem({ id: "low1", name: "Low Sauce", category: "sweetener", on_hand: 4, par_min: 5, par_max: 20 }),
    mkItem({ id: "crit1", name: "Critical Milk", category: "dairy", on_hand: 1, par_min: 5, par_max: 20 }),
    mkItem({ id: "over1", name: "Overstock Cups", category: "packaging", on_hand: 30, par_min: 5, par_max: 20 }),
    mkItem({ id: "x86", name: "Eighty-Sixed Boba", on_hand: 8, flagged_86: true }),
    mkItem({ id: "arch1", name: "Archived Thing", on_hand: 0, par_min: 5, archived: true }),
  ]);

  const overview = buildInventoryOverview(dataset, NOW);

  test("excludes archived items from totals", () => {
    expect(overview.total_active_items).toBe(5);
    expect(overview.generated_at).toBe(NOW);
  });

  test("counts each status", () => {
    expect(overview.status_counts).toEqual({ ok: 1, low: 1, critical: 1, over: 1, "86": 1 });
  });

  // par_max === 0 is the "no upper bound set" sentinel (floor-created items leave it
  // optional). Such an item must never read "over" however high its on_hand sits, and
  // gets no reorder hint (there's no ceiling to reorder up to).
  test("par_max=0 is no-ceiling: never 'over', regardless of on_hand", () => {
    const ov = buildInventoryOverview(
      source([
        mkItem({ id: "noceil", name: "No Ceiling Cups", on_hand: 9999, par_min: 5, par_max: 0 }),
        mkItem({ id: "noceil_low", name: "No Ceiling Low", on_hand: 1, par_min: 5, par_max: 0 }),
      ]),
      NOW,
    );
    expect(ov.status_counts.over).toBe(0);
    expect(ov.status_counts.ok).toBe(1);
    expect(ov.status_counts.critical).toBe(1);
    // No ceiling → no "order up to par_max" suggestion even when short.
    const low = ov.at_risk.find((i) => i.name === "No Ceiling Low");
    expect(low?.suggested_reorder).toBeUndefined();
  });

  test("at_risk is critical+low+86 ordered by severity (critical, 86, low)", () => {
    expect(overview.at_risk.map((i) => i.status)).toEqual(["critical", "86", "low"]);
    expect(overview.at_risk_truncated).toBe(false);
  });

  test("suggested_reorder set for low/critical to reach par_max, absent for 86", () => {
    const critByName = overview.at_risk.find((i) => i.name === "Critical Milk");
    const lowByName = overview.at_risk.find((i) => i.name === "Low Sauce");
    const boba = overview.at_risk.find((i) => i.name === "Eighty-Sixed Boba");
    expect(critByName?.suggested_reorder).toBe(19);
    expect(lowByName?.suggested_reorder).toBe(16);
    expect(boba?.suggested_reorder).toBeUndefined();
  });

  test("resolves category display names via the canonical fallback", () => {
    const milk = overview.at_risk.find((i) => i.name === "Critical Milk");
    expect(milk?.category).toBe("Dairy & Cream");
  });

  test("by_category rollup counts items and needs_attention", () => {
    const dairy = overview.by_category.find((c) => c.category === "Dairy & Cream");
    expect(dairy).toEqual({ category: "Dairy & Cream", items: 1, needs_attention: 1 });
    const pkg = overview.by_category.find((c) => c.category === "Cups & Packaging");
    expect(pkg).toEqual({ category: "Cups & Packaging", items: 1, needs_attention: 0 });
  });

  test("caps at_risk at 40 and flags truncation", () => {
    const many = source(
      Array.from({ length: 45 }, (_, i) =>
        mkItem({ id: `lo${i}`, name: `Low Item ${i}`, on_hand: 0, par_min: 5, par_max: 10 }),
      ),
    );
    const big = buildInventoryOverview(many, NOW);
    expect(big.at_risk).toHaveLength(40);
    expect(big.at_risk_truncated).toBe(true);
    expect(big.status_counts.critical).toBe(45);
  });
});

describe("searchInventory", () => {
  const dataset = source([
    mkItem({ id: "tap", name: "Tapioca Pearls", sku: "TAP1", category: "topping", on_hand: 3, par_min: 5 }),
    mkItem({ id: "pearls", name: "Pearls", sku: "PRL", category: "topping" }),
    mkItem({ id: "milk", name: "Whole Milk", sku: "MLK", category: "dairy" }),
    mkItem({ id: "cups", name: "16oz Cups", sku: "CUP16", category: "packaging" }),
  ]);

  test("exact name match ranks first", () => {
    const res = searchInventory(dataset, "pearls", NOW);
    expect(res.match_count).toBe(2);
    expect(res.matches[0]?.name).toBe("Pearls");
    expect(res.query).toBe("pearls");
  });

  test("partial, case-insensitive match", () => {
    const res = searchInventory(dataset, "PEARL", NOW);
    expect(res.matches.map((m) => m.name).sort()).toEqual(["Pearls", "Tapioca Pearls"]);
  });

  test("matches on SKU", () => {
    const res = searchInventory(dataset, "cup16", NOW);
    expect(res.matches.map((m) => m.name)).toEqual(["16oz Cups"]);
  });

  test("matches on category display-name keyword", () => {
    const res = searchInventory(dataset, "dairy", NOW);
    expect(res.matches.map((m) => m.name)).toEqual(["Whole Milk"]);
  });

  test("empty / whitespace query returns no matches", () => {
    expect(searchInventory(dataset, "   ", NOW).match_count).toBe(0);
    expect(searchInventory(dataset, "", NOW).matches).toEqual([]);
  });

  test("excludes archived items", () => {
    const withArchived = source([
      ...dataset.items,
      mkItem({ id: "old", name: "Old Pearls", archived: true }),
    ]);
    const res = searchInventory(withArchived, "pearls", NOW);
    expect(res.matches.some((m) => m.name === "Old Pearls")).toBe(false);
  });

  test("caps matches at 25 and flags truncation", () => {
    const many = source(
      Array.from({ length: 30 }, (_, i) => mkItem({ id: `p${i}`, name: `Pearls ${i}`, sku: `P${i}` })),
    );
    const res = searchInventory(many, "pearls", NOW);
    expect(res.matches).toHaveLength(25);
    expect(res.match_count).toBe(30);
    expect(res.truncated).toBe(true);
  });
});

describe("vendorPriceLookup", () => {
  function mkAlias(
    over: Partial<InventoryItemAlias> & Pick<InventoryItemAlias, "item_id" | "vendor">,
  ): InventoryItemAlias {
    return {
      id: `a-${over.item_id}-${over.vendor}`,
      vendor_label: "",
      normalized: "n",
      raw: "raw",
      brand: "",
      pack: "",
      pack_id: null,
      source: "receive",
      last_cost_cents: null,
      hits: 1,
      last_seen_at: "2026-01-01T00:00:00.000Z",
      ...over,
    };
  }

  test("returns per-vendor prices cheapest first, with the cheapest flagged", () => {
    const ds = {
      items: [mkItem({ id: "milk", name: "Milk 12 oz", unit: "each" })],
      categories: [],
      item_aliases: [
        mkAlias({ item_id: "milk", vendor: "sysco", vendor_label: "Sysco", last_cost_cents: 455 }),
        mkAlias({ item_id: "milk", vendor: "samsclub", vendor_label: "Sam's Club", last_cost_cents: 420 }),
      ],
    };
    const out = vendorPriceLookup(ds, "milk", NOW);
    expect(out.match_count).toBe(1);
    expect(out.items[0]?.cheapest_vendor).toBe("Sam's Club");
    expect(out.items[0]?.vendors).toEqual([
      { vendor: "Sam's Club", last_cost_cents_per_unit: 420 },
      { vendor: "Sysco", last_cost_cents_per_unit: 455 },
    ]);
  });

  test("an item with no recorded price returns an empty vendor list", () => {
    const ds = {
      items: [mkItem({ id: "eggs", name: "Eggs" })],
      categories: [],
      item_aliases: [],
    };
    const out = vendorPriceLookup(ds, "eggs", NOW);
    expect(out.items[0]?.vendors).toEqual([]);
    expect(out.items[0]?.cheapest_vendor).toBeNull();
  });
});
