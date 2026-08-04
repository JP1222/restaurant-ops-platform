import { describe, expect, it } from "vitest";

import { normalizeAlias, type InventoryDataset, type InventoryItemAlias } from "@rop/contracts";
import {
  applyMatchSuggestions,
  convertForReceive,
  looksLikePackUnit,
  resolveLearnedAlias,
  vendorPricesForItem,
  type AliasPriceLike,
} from "@rop/contracts/match";

import { bestCatalogMatch } from "@/lib/inventory/receipt-match";

// A real Sam's Club receipt (Anytown ST, 06/05/26) transcribed line-for-line, used as a
// fixture to drive the SHIPPED deterministic receiving pipeline end to end:
// fuzzy/alias match -> AI-residual gate -> pack conversion -> per-vendor price.
//
// The vision OCR step itself is NOT exercised here (no live model). `canonicalName` is the
// clean generic name the parse PROMPT asks the model to produce from each printed line
// (see apps/backoffice-web/lib/ai/receipt-parse.ts). Sam's Club prints every line as
// "N AT 1 FOR <unit price>" with no unit word, so `unit` is "" for all lines.

const VENDOR = "Sam's Club";

interface ParsedLine {
  description: string;
  qty: number;
  unit: string;
  unitPriceCents: number;
  extendedCents: number; // the printed line total, used for fixture-integrity checks
  canonicalName: string;
}

const RECEIPT: ParsedLine[] = [
  { description: "B&C SPOON", qty: 2, unit: "", unitPriceCents: 1468, extendedCents: 2936, canonicalName: "Spoon" },
  { description: "OREO 30CT", qty: 2, unit: "", unitPriceCents: 1348, extendedCents: 2696, canonicalName: "Oreo 30 ct" },
  { description: "BANANAS", qty: 3, unit: "", unitPriceCents: 147, extendedCents: 441, canonicalName: "Bananas" },
  { description: "STRAWBERRY", qty: 8, unit: "", unitPriceCents: 597, extendedCents: 4776, canonicalName: "Strawberries" },
  { description: "CHEESECAKE", qty: 2, unit: "", unitPriceCents: 1478, extendedCents: 2956, canonicalName: "Cheesecake" },
  // Genuinely un-cleanable smushed text — the model echoes it, so fuzzy gets no signal.
  { description: "9OZMMCUP", qty: 1, unit: "", unitPriceCents: 1498, extendedCents: 1498, canonicalName: "9OZMMCUP" },
  { description: "MM HEAVY CR", qty: 48, unit: "", unitPriceCents: 352, extendedCents: 16896, canonicalName: "Heavy Cream" },
  { description: "MM 50 SUGAR", qty: 1, unit: "", unitPriceCents: 2798, extendedCents: 2798, canonicalName: "Sugar 50 lb" },
  { description: "WHOLE MILK", qty: 12, unit: "", unitPriceCents: 306, extendedCents: 3672, canonicalName: "Whole Milk" },
];

const TOTAL_CENTS = 38669; // printed TOTAL 386.69

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

// A rolled-ice-cream shop's catalog (Example Kitchen) — the kind of Sam's Club run this receipt is.
const CATALOG: Item[] = [
  item("item-cream", "Heavy Cream"),
  item("item-milk", "Whole Milk"),
  item("item-sugar", "Granulated Sugar"),
  item("item-straw", "Strawberries"),
  item("item-banana", "Bananas"),
  item("item-oreo", "Oreo Cookies"),
  item("item-cheese", "Cheesecake Bites"),
  item("item-spoon", "Tasting Spoons"),
  item("item-cup", "9 oz Cups"),
];

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

function line(description: string): ParsedLine {
  const found = RECEIPT.find((l) => l.description === description);
  if (!found) throw new Error(`no fixture line ${description}`);
  return found;
}

describe("Sam's Club receipt — fixture integrity", () => {
  it("each line's qty x unit price equals the printed extended price", () => {
    for (const l of RECEIPT) {
      expect(l.qty * l.unitPriceCents).toBe(l.extendedCents);
    }
  });

  it("the line extendeds sum to the printed receipt total ($386.69)", () => {
    expect(RECEIPT.reduce((sum, l) => sum + l.extendedCents, 0)).toBe(TOTAL_CENTS);
  });
});

describe("Sam's Club receipt — deterministic catalog match (tier 1, fuzzy on canonical name)", () => {
  const expected: Record<string, string> = {
    "B&C SPOON": "item-spoon",
    "OREO 30CT": "item-oreo",
    BANANAS: "item-banana",
    STRAWBERRY: "item-straw",
    CHEESECAKE: "item-cheese",
    // The brand abbreviation "MM" (Member's Mark) is noise; the model's canonical name rescues it.
    "MM HEAVY CR": "item-cream",
    "MM 50 SUGAR": "item-sugar",
    "WHOLE MILK": "item-milk",
  };

  for (const [desc, id] of Object.entries(expected)) {
    it(`matches "${desc}" -> ${id} via the model's canonical name`, () => {
      const l = line(desc);
      expect(
        bestCatalogMatch(l.description, CATALOG, { vendor: VENDOR, canonicalName: l.canonicalName }),
      ).toBe(id);
    });
  }

  it('leaves the smushed "9OZMMCUP" line unmatched -> residual for the AI tier', () => {
    const l = line("9OZMMCUP");
    expect(
      bestCatalogMatch(l.description, CATALOG, { vendor: VENDOR, canonicalName: l.canonicalName }),
    ).toBe("");
  });

  it("matches the SINGULAR canonical too — singular/plural drift is folded out", () => {
    // The catalog item is plural ("Strawberries"); a model that emits the singular
    // "Strawberry" used to fall through to residual. The singularize fold closes that gap.
    expect(bestCatalogMatch("STRAWBERRY", CATALOG, { vendor: VENDOR, canonicalName: "Strawberry" })).toBe(
      "item-straw",
    );
    expect(bestCatalogMatch("BANANA", CATALOG, { vendor: VENDOR, canonicalName: "Banana" })).toBe("item-banana");
  });
});

describe("Sam's Club receipt — AI semantic tier on the residual line", () => {
  const validIds = new Set(CATALOG.map((i) => i.id));

  it("accepts a confident, real-catalog suggestion for 9OZMMCUP", () => {
    const out = applyMatchSuggestions([{ index: 5, item_id: "item-cup", confidence: 0.86 }], validIds, 0.7);
    expect(out.get(5)).toEqual({ itemId: "item-cup", confidence: 0.86 });
  });

  it("rejects a low-confidence or hallucinated suggestion (the operator decides)", () => {
    expect(applyMatchSuggestions([{ index: 5, item_id: "item-cup", confidence: 0.4 }], validIds, 0.7).size).toBe(0);
    expect(applyMatchSuggestions([{ index: 5, item_id: "item-ghost", confidence: 0.99 }], validIds, 0.7).size).toBe(0);
  });
});

describe("Sam's Club receipt — learned alias makes the second scan instant (tier 0)", () => {
  it("a confirmed receive teaches the exact vendor wording, even the abbreviated/smushed ones", () => {
    const aliases: InventoryItemAlias[] = [
      alias("item-cream", "MM HEAVY CR", VENDOR),
      alias("item-cup", "9OZMMCUP", VENDOR),
    ];
    // The previously-residual smushed line now resolves with zero fuzzy/AI cost.
    expect(resolveLearnedAlias("9OZMMCUP", aliases, VENDOR)).toBe("item-cup");
    expect(resolveLearnedAlias("MM HEAVY CR", aliases, VENDOR)).toBe("item-cream");
    // Through the full matcher, the learned alias beats fuzzy.
    expect(bestCatalogMatch("MM HEAVY CR", CATALOG, { aliases, vendor: VENDOR })).toBe("item-cream");
  });
});

describe("Sam's Club receipt — pack/unit conversion", () => {
  it("receives every line as-is: Sam's Club prints per-unit, so no line looks like a pack", () => {
    for (const l of RECEIPT) {
      expect(looksLikePackUnit(l.unit, "")).toBe(false);
      const { qty, unitCostCents } = convertForReceive(l.qty, l.unitPriceCents, 1, false);
      expect(qty).toBe(l.qty);
      expect(unitCostCents).toBe(l.unitPriceCents);
    }
  });

  it("engages only when the operator stocks a smaller unit than the printed package", () => {
    // Operator portions from a 30-ct Oreo box and toggles "by case (x30)":
    // 2 boxes -> 60 stock units at the per-unit cost (1348 / 30 = 44.9333c, sub-cent kept).
    const oreo = line("OREO 30CT");
    expect(convertForReceive(oreo.qty, oreo.unitPriceCents, 30, true)).toEqual({ qty: 60, unitCostCents: 44.9333 });
  });
});

describe("Sam's Club receipt — per-vendor price intelligence", () => {
  it("surfaces the last-paid price per vendor, cheapest first", () => {
    const aliases: AliasPriceLike[] = [
      {
        item_id: "item-milk",
        vendor: normalizeAlias(VENDOR),
        vendor_label: VENDOR,
        last_cost_cents: 306, // this receipt: WHOLE MILK @ 3.06
        hits: 1,
        last_seen_at: "2026-06-05T00:00:00.000Z",
      },
      {
        item_id: "item-milk",
        vendor: "restaurantdepot",
        vendor_label: "Restaurant Depot",
        last_cost_cents: 298,
        hits: 1,
        last_seen_at: "2026-05-20T00:00:00.000Z",
      },
    ];
    expect(vendorPricesForItem("item-milk", aliases)).toEqual([
      { vendor: "Restaurant Depot", lastCostCents: 298, hits: 1 },
      { vendor: "Sam's Club", lastCostCents: 306, hits: 1 },
    ]);
  });
});
