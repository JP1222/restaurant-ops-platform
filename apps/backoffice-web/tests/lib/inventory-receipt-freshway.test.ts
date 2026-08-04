import { describe, expect, it } from "vitest";

import type { InventoryDataset } from "@rop/contracts";
import { convertForReceive, looksLikePackUnit } from "@rop/contracts/match";

import { bestCatalogMatch } from "@/lib/inventory/receipt-match";

// A sample case-format invoice (Freshway Restaurant Supply, "FOR AI TESTING ONLY") sold to
// EXAMPLE KITCHEN Ice Cream, transcribed line-for-line. Unlike the Sam's Club receipt (which
// prints per-unit and never triggers conversion), this one carries real PACKS — "40 lb
// Case", "1000 ct", "6000 ct Case" — so it exercises the pack/unit conversion path
// (ADR-0592) end to end. The vision OCR step is not run here (no live model); the fixture
// feeds the parse OUTPUT (incl. the clean `canonicalName` the prompt asks for) through the
// shipped matcher + conversion helpers, which is where the deterministic bugs live.

const VENDOR = "Freshway Restaurant Supply";

interface ParsedLine {
  description: string;
  qty: number;
  unit: string; // what the model would lift as the unit/pack word (or "" when none is shown)
  unitPriceCents: number;
  extendedCents: number;
  canonicalName: string;
}

const RECEIPT: ParsedLine[] = [
  { description: "Whole Milk, 1 Gallon", qty: 6, unit: "gallon", unitPriceCents: 429, extendedCents: 2574, canonicalName: "Whole Milk" },
  { description: "Heavy Cream, 1 Quart", qty: 8, unit: "quart", unitPriceCents: 549, extendedCents: 4392, canonicalName: "Heavy Cream" },
  { description: "Fresh Strawberries, 8 lb", qty: 2, unit: "lb", unitPriceCents: 1899, extendedCents: 3798, canonicalName: "Fresh Strawberries" },
  { description: "Bananas, 40 lb Case", qty: 1, unit: "case", unitPriceCents: 2250, extendedCents: 2250, canonicalName: "Bananas" },
  { description: "Oreo Cookie Crumbs, 5 lb", qty: 2, unit: "lb", unitPriceCents: 1475, extendedCents: 2950, canonicalName: "Oreo Cookie Crumbs" },
  { description: "Vanilla Extract, 16 oz", qty: 1, unit: "oz", unitPriceCents: 1199, extendedCents: 1199, canonicalName: "Vanilla Extract" },
  { description: "Chocolate Syrup, 1 Gallon", qty: 3, unit: "gallon", unitPriceCents: 989, extendedCents: 2967, canonicalName: "Chocolate Syrup" },
  { description: "Whipped Topping, 15 oz", qty: 12, unit: "oz", unitPriceCents: 325, extendedCents: 3900, canonicalName: "Whipped Topping" },
  { description: "12 oz Paper Cups, Case", qty: 1, unit: "case", unitPriceCents: 3699, extendedCents: 3699, canonicalName: "12 oz Paper Cups" },
  { description: "Plastic Spoons, 1000 ct", qty: 1, unit: "ct", unitPriceCents: 1949, extendedCents: 1949, canonicalName: "Plastic Spoons" },
  { description: "Napkins, 6000 ct Case", qty: 1, unit: "case", unitPriceCents: 2875, extendedCents: 2875, canonicalName: "Napkins" },
  { description: "Sanitizer Solution, 1 Gallon", qty: 2, unit: "gallon", unitPriceCents: 1299, extendedCents: 2598, canonicalName: "Sanitizer Solution" },
];

const SUBTOTAL_CENTS = 35151; // printed Subtotal $351.51

type Item = InventoryDataset["items"][number];

function item(id: string, name: string, extra: Partial<Item> = {}): Item {
  return {
    id,
    sku: id,
    name,
    category: "food",
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
    ...extra,
  };
}

// EXAMPLE KITCHEN's catalog. Liquids/produce track in their own stock unit (gal/qt/lb/can);
// the two food packs that a shop really does break down (bananas by the lb, cookie crumbs
// by the lb) carry a pack_qty > 1; consumable supplies are tracked BY THE CASE (pack_qty 1)
// — you don't count individual napkins — which is the setup the precision test below argues for.
const CATALOG: Item[] = [
  item("item-milk", "Whole Milk", { unit: "gal", purchase_unit: "gal" }),
  item("item-cream", "Heavy Cream", { unit: "qt", purchase_unit: "qt" }),
  item("item-straw", "Strawberries", { unit: "lb" }),
  item("item-banana", "Bananas", { unit: "lb", purchase_unit: "case", pack_qty: 40 }),
  item("item-oreo", "Oreo Cookie Crumbs", { unit: "lb", purchase_unit: "bag", pack_qty: 5 }),
  item("item-vanilla", "Vanilla Extract", { unit: "bottle" }),
  item("item-choc", "Chocolate Syrup", { unit: "gal", purchase_unit: "gal" }),
  item("item-whip", "Whipped Topping", { unit: "can" }),
  item("item-cups", "Paper Cups", { unit: "case", purchase_unit: "case" }),
  item("item-spoons", "Plastic Spoons", { unit: "case", purchase_unit: "case" }),
  item("item-napkins", "Napkins", { unit: "case", purchase_unit: "case" }),
  item("item-sanitizer", "Sanitizer Solution", { unit: "gal", purchase_unit: "gal" }),
];

function line(description: string): ParsedLine {
  const found = RECEIPT.find((l) => l.description === description);
  if (!found) throw new Error(`no fixture line ${description}`);
  return found;
}

describe("Freshway invoice — fixture integrity", () => {
  it("each line's qty x unit price equals the printed extended price", () => {
    for (const l of RECEIPT) expect(l.qty * l.unitPriceCents).toBe(l.extendedCents);
  });

  it("the line extendeds sum to the printed subtotal ($351.51)", () => {
    expect(RECEIPT.reduce((sum, l) => sum + l.extendedCents, 0)).toBe(SUBTOTAL_CENTS);
  });
});

describe("Freshway invoice — every line matches the catalog (incl. the plural fold, #594)", () => {
  const expected: Record<string, string> = {
    "Whole Milk, 1 Gallon": "item-milk",
    "Heavy Cream, 1 Quart": "item-cream",
    "Fresh Strawberries, 8 lb": "item-straw", // "Strawberries" vs "Fresh Strawberries" + plural
    "Bananas, 40 lb Case": "item-banana", // plural -> Bananas via singularize
    "Oreo Cookie Crumbs, 5 lb": "item-oreo",
    "Vanilla Extract, 16 oz": "item-vanilla",
    "Chocolate Syrup, 1 Gallon": "item-choc",
    "Whipped Topping, 15 oz": "item-whip",
    "12 oz Paper Cups, Case": "item-cups", // plural Cups
    "Plastic Spoons, 1000 ct": "item-spoons", // plural Spoons
    "Napkins, 6000 ct Case": "item-napkins", // plural Napkins
    "Sanitizer Solution, 1 Gallon": "item-sanitizer",
  };

  for (const [desc, id] of Object.entries(expected)) {
    it(`matches "${desc}" -> ${id}`, () => {
      const l = line(desc);
      expect(bestCatalogMatch(l.description, CATALOG, { vendor: VENDOR, canonicalName: l.canonicalName })).toBe(id);
    });
  }
});

describe("Freshway invoice — pack/unit detection", () => {
  it('flags the explicit pack words ("Case", "ct") as packs', () => {
    expect(looksLikePackUnit("case", "case")).toBe(true);
    expect(looksLikePackUnit("ct", "case")).toBe(true);
  });

  it("treats a per-unit size word (Gallon/Quart/oz) as a stock unit, not a pack", () => {
    // The "1 Gallon" / "1 Quart" / "16 oz" is the size of EACH unit, not a multiplier.
    expect(looksLikePackUnit("gallon", "gal")).toBe(false);
    expect(looksLikePackUnit("quart", "qt")).toBe(false);
    expect(looksLikePackUnit("oz", "bottle")).toBe(false);
  });
});

describe("Freshway invoice — pack conversion math (ADR-0592)", () => {
  it("breaks a weight case into its stock unit at the per-unit cost", () => {
    // Bananas: 1 case of 40 lb @ $22.50 -> 40 lb @ 56.25c/lb (sub-cent kept, not rounded to 56).
    const banana = line("Bananas, 40 lb Case");
    expect(convertForReceive(banana.qty, banana.unitPriceCents, 40, true)).toEqual({ qty: 40, unitCostCents: 56.25 });
    // Oreo crumbs: 2 bags of 5 lb @ $14.75 -> 10 lb @ exactly $2.95/lb (clean division).
    const oreo = line("Oreo Cookie Crumbs, 5 lb");
    expect(convertForReceive(oreo.qty, oreo.unitPriceCents, 5, true)).toEqual({ qty: 10, unitCostCents: 295 });
  });

  it("receives consumable supplies BY THE CASE (pack_qty 1) — no conversion, exact cost", () => {
    // Cups/Spoons/Napkins are tracked by the case, so factor is 1: qty and cost pass through
    // and the stored cost is exact. This is the correct setup for these items (see below).
    const cups = line("12 oz Paper Cups, Case");
    expect(convertForReceive(cups.qty, cups.unitPriceCents, 1, true)).toEqual({ qty: 1, unitCostCents: 3699 });
    const napkins = line("Napkins, 6000 ct Case");
    expect(convertForReceive(napkins.qty, napkins.unitPriceCents, 1, true)).toEqual({ qty: 1, unitCostCents: 2875 });
  });

  it("keeps sub-cent precision for high-count cheap packs (no longer flattened to 0)", () => {
    // Per-usage cost is a Float to 4 decimals, so breaking a big cheap pack into single units
    // keeps a real per-unit cost instead of the old whole-cent rounding (napkin -> 0, cup -> 4c
    // overstating by ~8%). A 6000-ct napkin case at $28.75 is 0.4792c/napkin; a 1000-ct cup case
    // at $36.99 is 3.699c/cup. The whole-cent amount PAID (purchase_cost_cents) stays exact.
    const napkins = line("Napkins, 6000 ct Case");
    expect(convertForReceive(napkins.qty, napkins.unitPriceCents, 6000, true).unitCostCents).toBe(0.4792);
    const cups = line("12 oz Paper Cups, Case");
    expect(convertForReceive(cups.qty, cups.unitPriceCents, 1000, true).unitCostCents).toBe(3.699);
  });
});
