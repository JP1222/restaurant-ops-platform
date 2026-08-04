import { describe, expect, test } from "vitest";
import type {
  InventoryCategory,
  InventoryItem,
  InventoryRecipe,
  InventoryVendor,
  InventoryWasteEntry,
} from "@rop/contracts";
import {
  buildItemsCsv,
  buildRecipesCsv,
  buildVendorsCsv,
  buildWasteCsv,
} from "@/lib/inventory/export-csv";

const CATEGORIES: InventoryCategory[] = [
  { id: "dairy", name: "Dairy & Cream", color: "amber" },
  { id: "packaging", name: "Cups & Packaging", color: "slate" },
];

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

function rows(csv: string): string[] {
  return csv.split("\n");
}

describe("buildItemsCsv", () => {
  const items = [
    mkItem({ id: "i1", name: "16oz Cups", sku: "CUP16", category: "packaging", on_hand: 2, par_min: 5 }),
    mkItem({ id: "i2", name: 'Milk, "Whole"', sku: "MLK", category: "dairy", flagged_86: true }),
  ];
  const csv = buildItemsCsv(items, CATEGORIES);
  const line = rows(csv);

  test("emits a header row", () => {
    expect(line[0]).toBe(
      "Name,SKU,Category,Status,On hand,Unit,Par min,Par max,Unit cost,Vendor,86",
    );
  });

  test("resolves category name, derives status, formats cost, maps 86", () => {
    // on_hand 2 < par_min*0.5 (2.5) => Critical (matches the Inventory page's statusOf).
    expect(line[1]).toBe("16oz Cups,CUP16,Cups & Packaging,Critical,2,each,5,20,0.52,Acme,no");
  });

  test("escapes cells containing commas and quotes (RFC-4180)", () => {
    // "Milk, \"Whole\"" -> wrapped in quotes with doubled inner quotes.
    expect(line[2]).toContain('"Milk, ""Whole"""');
    expect(line[2]).toMatch(/,yes$/);
  });
});

describe("buildRecipesCsv", () => {
  const recipes: InventoryRecipe[] = [
    {
      id: "r1",
      name: "Classic Milk Tea",
      category: "Tea",
      sell_cents: 599,
      sold_today: 12,
      lines: [
        { sku: "i1", qty: 1 },
        { sku: "i2", qty: 2 },
      ],
    },
  ];
  const line = rows(buildRecipesCsv(recipes));

  test("header + sell price in dollars + ingredient count", () => {
    expect(line[0]).toBe("Name,Category,Sell price,Sold today,Ingredients");
    expect(line[1]).toBe("Classic Milk Tea,Tea,5.99,12,2");
  });
});

describe("buildVendorsCsv", () => {
  const vendors: InventoryVendor[] = [
    {
      id: "v1",
      name: "Sysco",
      type: "Broadline",
      contact: "Pat",
      phone: "555-1000",
      email: "pat@sysco.test",
      account: "ACME-1",
      terms: "Net 30",
      min_order_cents: 15000,
      cutoff: "16:00",
      delivery_days: ["Mon", "Thu"],
      categories: ["dairy", "packaging"],
      fill_rate: 0.98,
      on_time: 0.95,
      price_stability: 0.9,
      credits_90d: 0,
      spend_30d: 120000,
      trend_4w: [1, 2, 3, 4],
      preferred: true,
      tags: [],
      archived: false,
    },
  ];
  const line = rows(buildVendorsCsv(vendors, CATEGORIES));

  test("header + min order dollars + preferred + category names joined", () => {
    expect(line[0]).toBe("Name,Type,Contact,Phone,Email,Terms,Min order,Preferred,Categories");
    expect(line[1]).toBe(
      'Sysco,Broadline,Pat,555-1000,pat@sysco.test,Net 30,150.00,yes,Dairy & Cream; Cups & Packaging',
    );
  });
});

describe("buildWasteCsv", () => {
  const items = [mkItem({ id: "i2", name: "Whole Milk", sku: "MLK" })];
  const entries: InventoryWasteEntry[] = [
    {
      id: "w1",
      at: "2026-06-05T10:00:00.000Z",
      who: "alice",
      sku: "i2",
      qty: 3,
      reason: "spoilage",
      notes: "left out overnight",
      photo: false,
      approved: true,
    },
  ];
  const line = rows(buildWasteCsv(entries, items));

  test("header + resolves item name from sku + approved flag", () => {
    expect(line[0]).toBe("Date,Logged by,Item,Qty,Reason,Approved,Notes");
    expect(line[1]).toBe(
      "2026-06-05T10:00:00.000Z,alice,Whole Milk,3,spoilage,yes,left out overnight",
    );
  });

  test("falls back to the raw sku when the item is unknown", () => {
    const orphan = buildWasteCsv(
      [{ ...entries[0]!, sku: "missing" }],
      items,
    );
    expect(rows(orphan)[1]).toContain(",missing,");
  });
});
