import { describe, expect, it } from "vitest";

import type { InventoryItemAlias } from "./inventory.js";
import {
  applyMatchSuggestions,
  baseProductKey,
  categoryFromText,
  convertForReceive,
  looksLikePackUnit,
  mergeReceiptLines,
  normalizeAlias,
  baseProductName,
  chooseFamilyBaseUnit,
  convertSize,
  parseSizeToken,
  planScanGrouping,
  resolveScanPacks,
  receiptMergeKey,
  resolveLearnedAlias,
  roundCost,
  singularizeToken,
  vendorPricesForItem,
  type AliasPriceLike,
  type ReceiptLineLike
} from "./inventory-match.js";

function alias(partial: Partial<InventoryItemAlias> & { item_id: string; raw: string }): InventoryItemAlias {
  return {
    id: `alias-${partial.raw}`,
    vendor: "",
    vendor_label: "",
    normalized: normalizeAlias(partial.raw),
    brand: "",
    pack: "",
    pack_id: null,
    source: "receive",
    last_cost_cents: null,
    hits: 1,
    last_seen_at: "2026-01-01T00:00:00.000Z",
    ...partial
  };
}

describe("normalizeAlias", () => {
  it("lowercases and strips all non-alphanumerics (spacing/punctuation/apostrophes)", () => {
    expect(normalizeAlias("MEMBER'S MARK MILK 12 OZ")).toBe("membersmarkmilk12oz");
    expect(normalizeAlias("  Member's   Mark\tMilk 12oz ")).toBe("membersmarkmilk12oz");
    expect(normalizeAlias("Members Mark Milk 12-oz")).toBe("membersmarkmilk12oz");
  });

  it("is stable for the same product regardless of casing/spacing/punctuation", () => {
    expect(normalizeAlias("Leche Entera GAL")).toBe(normalizeAlias("leche  entera gal"));
    // "12 oz" and "12oz" must collapse to the same key (the common vendor-vs-operator drift).
    expect(normalizeAlias("Milk 12 oz")).toBe(normalizeAlias("MILK 12OZ"));
  });

  it("returns empty string for punctuation-only input", () => {
    expect(normalizeAlias("--- / ---")).toBe("");
  });
});

describe("resolveLearnedAlias", () => {
  const milkId = "item-milk-12oz";
  const aliases: InventoryItemAlias[] = [
    alias({ item_id: milkId, raw: "MEMBER'S MARK MILK 12 OZ", vendor: normalizeAlias("Sam's Club") })
  ];

  it("returns null when there is no learned alias", () => {
    expect(resolveLearnedAlias("Unknown thing", aliases, "Sam's Club")).toBeNull();
  });

  it("matches the vendor-scoped alias exactly (the learned memory)", () => {
    expect(resolveLearnedAlias("Member's Mark Milk 12oz", aliases, "Sam's Club")).toBe(milkId);
  });

  it("matches vendor-agnostically when the printed text is unambiguous", () => {
    // Same wording, vendor unknown / different: one item -> still resolves.
    expect(resolveLearnedAlias("MEMBER'S MARK MILK 12 OZ", aliases)).toBe(milkId);
    expect(resolveLearnedAlias("members mark milk 12 oz", aliases, "Costco")).toBe(milkId);
  });

  it("refuses to guess when the same text maps to two different items under different vendors", () => {
    const ambiguous: InventoryItemAlias[] = [
      alias({ item_id: "item-a", raw: "HOUSE MILK", vendor: normalizeAlias("Vendor A") }),
      alias({ item_id: "item-b", raw: "HOUSE MILK", vendor: normalizeAlias("Vendor B") })
    ];
    // No vendor hint and conflicting targets -> null (operator disambiguates).
    expect(resolveLearnedAlias("House Milk", ambiguous)).toBeNull();
    // With a matching vendor, the scoped mapping still wins.
    expect(resolveLearnedAlias("House Milk", ambiguous, "Vendor B")).toBe("item-b");
  });
});

describe("applyMatchSuggestions", () => {
  const valid = new Set(["item-a", "item-b"]);

  it("accepts a suggestion at/above the threshold for a real item", () => {
    const out = applyMatchSuggestions(
      [{ index: 0, item_id: "item-a", confidence: 0.9 }],
      valid,
      0.7
    );
    expect(out.get(0)).toEqual({ itemId: "item-a", confidence: 0.9 });
  });

  it("rejects below-threshold and null suggestions", () => {
    const out = applyMatchSuggestions(
      [
        { index: 0, item_id: "item-a", confidence: 0.5 },
        { index: 1, item_id: null, confidence: 0.99 }
      ],
      valid,
      0.7
    );
    expect(out.size).toBe(0);
  });

  it("drops a hallucinated id not in the live catalog (guard)", () => {
    const out = applyMatchSuggestions(
      [{ index: 0, item_id: "item-ghost", confidence: 1 }],
      valid,
      0.7
    );
    expect(out.size).toBe(0);
  });

  it("threshold is inclusive", () => {
    const out = applyMatchSuggestions(
      [{ index: 2, item_id: "item-b", confidence: 0.7 }],
      valid,
      0.7
    );
    expect(out.get(2)?.itemId).toBe("item-b");
  });
});

describe("vendorPricesForItem", () => {
  const a = (p: Partial<AliasPriceLike> & { vendor: string }): AliasPriceLike => ({
    item_id: "milk",
    vendor_label: "",
    last_cost_cents: 100,
    hits: 1,
    last_seen_at: "2026-01-01T00:00:00.000Z",
    ...p
  });

  it("returns one priced row per vendor, cheapest first, with the display label", () => {
    const out = vendorPricesForItem("milk", [
      a({ vendor: "samsclub", vendor_label: "Sam's Club", last_cost_cents: 420 }),
      a({ vendor: "sysco", vendor_label: "Sysco", last_cost_cents: 455 }),
      a({ vendor: "other", item_id: "eggs", last_cost_cents: 99 }) // different item, ignored
    ]);
    expect(out).toEqual([
      { vendor: "Sam's Club", lastCostCents: 420, hits: 1 },
      { vendor: "Sysco", lastCostCents: 455, hits: 1 }
    ]);
  });

  it("skips aliases with no price and prettifies a missing label", () => {
    const out = vendorPricesForItem("milk", [
      a({ vendor: "restaurantdepot", vendor_label: "", last_cost_cents: 410 }),
      a({ vendor: "nodata", last_cost_cents: null })
    ]);
    expect(out).toEqual([{ vendor: "Restaurantdepot", lastCostCents: 410, hits: 1 }]);
  });

  it("collapses one vendor's wordings to the LATEST receive, not the most-hit (stale-price guard)", () => {
    const out = vendorPricesForItem("milk", [
      // older wording, seen far more often, but a now-stale price
      a({
        vendor: "samsclub",
        vendor_label: "Sam's Club",
        last_cost_cents: 500,
        hits: 9,
        last_seen_at: "2026-01-01T00:00:00.000Z"
      }),
      // newer wording from a recent invoice, fewer hits, current price — must win
      a({
        vendor: "samsclub",
        vendor_label: "Sam's Club",
        last_cost_cents: 420,
        hits: 1,
        last_seen_at: "2026-03-01T00:00:00.000Z"
      })
    ]);
    expect(out).toEqual([{ vendor: "Sam's Club", lastCostCents: 420, hits: 1 }]);
  });
});

describe("looksLikePackUnit", () => {
  it("recognizes the item's configured purchase unit and common pack words", () => {
    expect(looksLikePackUnit("Case", "case")).toBe(true);
    expect(looksLikePackUnit("flat", "Flat")).toBe(true);
    expect(looksLikePackUnit("cs", "each")).toBe(true);
    expect(looksLikePackUnit("ct", "each")).toBe(true);
    expect(looksLikePackUnit("dozen", "")).toBe(true);
  });

  it("treats each/unit/blank as a stock unit, not a pack", () => {
    expect(looksLikePackUnit("each", "case")).toBe(false);
    expect(looksLikePackUnit("ea", "case")).toBe(false);
    expect(looksLikePackUnit("", "case")).toBe(false);
    expect(looksLikePackUnit("unit", "")).toBe(false);
  });
});

describe("roundCost", () => {
  it("keeps sub-cent precision to 4 decimals (no double-precision noise, no whole-cent flattening)", () => {
    expect(roundCost(2875 / 6000)).toBe(0.4792); // a 6000-ct napkin case at $28.75 -> 0.4792c, not 0
    expect(roundCost(5000 / 12)).toBe(416.6667); // non-terminating division -> a clean 4dp value
    expect(roundCost(56.25)).toBe(56.25);
    expect(roundCost(306)).toBe(306); // whole cents stay whole
  });
});

describe("convertForReceive", () => {
  it("multiplies qty and divides cost by the pack size, keeping sub-cent precision", () => {
    expect(convertForReceive(2, 5000, 12, true)).toEqual({ qty: 24, unitCostCents: 416.6667 });
    // A high-count cheap pack is NOT flattened to 0 (the old Math.round bug):
    expect(convertForReceive(1, 2875, 6000, true)).toEqual({ qty: 6000, unitCostCents: 0.4792 });
  });

  it("passes through unchanged when not a pack, or pack_qty <= 1, or no cost", () => {
    expect(convertForReceive(24, 417, 12, false)).toEqual({ qty: 24, unitCostCents: 417 });
    expect(convertForReceive(3, 250, 1, true)).toEqual({ qty: 3, unitCostCents: 250 });
    expect(convertForReceive(2, undefined, 12, true)).toEqual({ qty: 24, unitCostCents: undefined });
  });
});

describe("singularizeToken", () => {
  it("folds common English plurals to a singular (the fuzzy-match drift cases)", () => {
    expect(singularizeToken("bananas")).toBe("banana");
    expect(singularizeToken("eggs")).toBe("egg");
    expect(singularizeToken("cups")).toBe("cup");
    expect(singularizeToken("strawberries")).toBe("strawberry");
    expect(singularizeToken("cherries")).toBe("cherry");
    expect(singularizeToken("boxes")).toBe("box");
    expect(singularizeToken("dishes")).toBe("dish");
    expect(singularizeToken("glasses")).toBe("glass");
  });

  it("a singular word is its own fixed point (idempotent — symmetric folding)", () => {
    for (const w of ["banana", "strawberry", "box", "milk", "cream", "sugar"]) {
      expect(singularizeToken(w)).toBe(w);
      expect(singularizeToken(singularizeToken(w))).toBe(w);
    }
  });

  it("leaves short units/codes and true -ss words untouched", () => {
    expect(singularizeToken("oz")).toBe("oz");
    expect(singularizeToken("ct")).toBe("ct");
    expect(singularizeToken("lbs")).toBe("lbs"); // 3 chars — below the fold threshold
    expect(singularizeToken("gas")).toBe("gas");
    expect(singularizeToken("glass")).toBe("glass");
    expect(singularizeToken("press")).toBe("press");
  });

  it("normalizeAlias (the EXACT stored key) is never singularized", () => {
    // The fold is a fuzzy-tier heuristic only; the persisted alias key stays verbatim.
    expect(normalizeAlias("Strawberries")).toBe("strawberries");
    expect(normalizeAlias("Bananas")).toBe("bananas");
  });
});

// Duplicate-line merge for receipt receiving (conservative policy: merge only when item +
// unit + unit price are ALL identical). These pin the shape `receiptMergeKey` must satisfy.
function line(partial: Partial<ReceiptLineLike> & { description: string }): ReceiptLineLike {
  return { qty: 1, ...partial };
}

describe("receiptMergeKey (conservative policy)", () => {
  it("gives two SAME item + unit + price lines an equal, non-null key", () => {
    const a = line({ description: "MILK 12OZ", unit: "each", unit_price_cents: 300 });
    const b = line({ description: "WHOLE MILK", unit: "each", unit_price_cents: 300 });
    const ka = receiptMergeKey(a, "item-milk");
    expect(ka).not.toBeNull();
    expect(receiptMergeKey(b, "item-milk")).toBe(ka); // same resolved item → same key
  });

  it("differs when the unit price differs (a price bump stays a separate row)", () => {
    const a = line({ description: "MILK", unit: "each", unit_price_cents: 300 });
    const b = line({ description: "MILK", unit: "each", unit_price_cents: 360 });
    expect(receiptMergeKey(a, "item-milk")).not.toBe(receiptMergeKey(b, "item-milk"));
  });

  it("differs when the unit differs ('case' must not fold into 'each')", () => {
    const a = line({ description: "MILK", unit: "each", unit_price_cents: 300 });
    const b = line({ description: "MILK", unit: "case", unit_price_cents: 300 });
    expect(receiptMergeKey(a, "item-milk")).not.toBe(receiptMergeKey(b, "item-milk"));
  });

  it("folds two unmatched lines with identical printed text (→ one new item)", () => {
    const a = line({ description: "DRAGON FRUIT", unit: "each", unit_price_cents: 500 });
    const b = line({ description: "Dragon Fruit", unit: "each", unit_price_cents: 500 });
    const ka = receiptMergeKey(a, null);
    expect(ka).not.toBeNull();
    expect(receiptMergeKey(b, null)).toBe(ka); // normalized text identity, no catalog id
  });

  it("returns null (never merges) when a line has no id and no usable text", () => {
    expect(receiptMergeKey(line({ description: "" }), null)).toBeNull();
  });
});

describe("mergeReceiptLines", () => {
  it("sums qty of duplicate same-item lines into the first occurrence", () => {
    const lines: ReceiptLineLike[] = [
      line({ description: "MILK", qty: 2, unit: "each", unit_price_cents: 300 }),
      line({ description: "MILK", qty: 3, unit: "each", unit_price_cents: 300 })
    ];
    const { lines: out, mergedCount } = mergeReceiptLines(lines, ["item-milk", "item-milk"]);
    expect(out).toHaveLength(1);
    expect(out[0]?.qty).toBe(5);
    expect(out[0]?.description).toBe("MILK"); // first occurrence's fields kept
    expect(mergedCount).toBe(1);
  });

  it("keeps a price-mismatched duplicate as its own row (the operator's example)", () => {
    // MILK x2 @ $3.00, MILK x3 @ $3.00, MILK x1 @ $3.60 → x5 @ $3.00 + x1 @ $3.60.
    const lines: ReceiptLineLike[] = [
      line({ description: "MILK", qty: 2, unit: "each", unit_price_cents: 300 }),
      line({ description: "MILK", qty: 3, unit: "each", unit_price_cents: 300 }),
      line({ description: "MILK", qty: 1, unit: "each", unit_price_cents: 360 })
    ];
    const { lines: out } = mergeReceiptLines(lines, ["item-milk", "item-milk", "item-milk"]);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ qty: 5, unit_price_cents: 300 });
    expect(out[1]).toMatchObject({ qty: 1, unit_price_cents: 360 });
  });

  it("never merges across different resolved items", () => {
    const lines: ReceiptLineLike[] = [
      line({ description: "MILK", qty: 1, unit: "each", unit_price_cents: 300 }),
      line({ description: "EGGS", qty: 1, unit: "each", unit_price_cents: 300 })
    ];
    const { lines: out, mergedCount } = mergeReceiptLines(lines, ["item-milk", "item-eggs"]);
    expect(out).toHaveLength(2);
    expect(mergedCount).toBe(0);
  });

  it("preserves order and does not mutate the input array or its elements", () => {
    const lines: ReceiptLineLike[] = [
      line({ description: "A", qty: 1, unit: "each", unit_price_cents: 100 }),
      line({ description: "B", qty: 1, unit: "each", unit_price_cents: 200 }),
      line({ description: "A", qty: 4, unit: "each", unit_price_cents: 100 })
    ];
    const snapshot = structuredClone(lines);
    const { lines: out } = mergeReceiptLines(lines, ["item-a", "item-b", "item-a"]);
    expect(out.map((l) => l.description)).toEqual(["A", "B"]); // first-A anchors, order kept
    expect(out[0]?.qty).toBe(5);
    expect(lines).toEqual(snapshot); // inputs untouched
  });
});

describe("parseSizeToken", () => {
  it("parses a weight size", () => {
    expect(parseSizeToken("28 oz")).toEqual({ qty: 28, unit: "oz", kind: "weight" });
    expect(parseSizeToken("Goldbears 28 oz")).toEqual({ qty: 28, unit: "oz", kind: "weight" });
    expect(parseSizeToken("5lb bag")).toEqual({ qty: 5, unit: "lb", kind: "weight" });
    expect(parseSizeToken("500g")).toEqual({ qty: 500, unit: "g", kind: "weight" });
  });

  it("parses a volume size, preferring fl oz over oz and ml/kg over l/g", () => {
    expect(parseSizeToken("12 fl oz")).toEqual({ qty: 12, unit: "fl oz", kind: "volume" });
    expect(parseSizeToken("1.5 L")).toEqual({ qty: 1.5, unit: "L", kind: "volume" });
    expect(parseSizeToken("750 ml")).toEqual({ qty: 750, unit: "ml", kind: "volume" });
    expect(parseSizeToken("1 gal")).toEqual({ qty: 1, unit: "gal", kind: "volume" });
    expect(parseSizeToken("2 kg")).toEqual({ qty: 2, unit: "kg", kind: "weight" });
  });

  it("parses count packs and 'case of N'", () => {
    expect(parseSizeToken("24 ct")).toEqual({ qty: 24, unit: "each", kind: "count" });
    expect(parseSizeToken("case of 24")).toEqual({ qty: 24, unit: "each", kind: "count" });
    expect(parseSizeToken("6 pack")).toEqual({ qty: 6, unit: "each", kind: "count" });
  });

  it("multiplies an 'N x M unit' pack", () => {
    expect(parseSizeToken("4 x 12 oz")).toEqual({ qty: 48, unit: "oz", kind: "weight" });
    expect(parseSizeToken("2×12 fl oz")).toEqual({ qty: 24, unit: "fl oz", kind: "volume" });
  });

  it("returns null when no size is legible (fail-soft)", () => {
    expect(parseSizeToken("Gold Bears")).toBeNull();
    expect(parseSizeToken("Plastic Spoons")).toBeNull();
    expect(parseSizeToken("")).toBeNull();
    expect(parseSizeToken(null)).toBeNull();
  });
});

describe("baseProductKey", () => {
  it("collapses the same product at different sizes to one key", () => {
    // The screenshot case: a 28oz bag and an unsized 'Gold Bears' line are the SAME product.
    const k1 = baseProductKey({ canonicalName: "Goldbears 28 oz" });
    const k2 = baseProductKey({ description: "Gold Bears" });
    expect(k1).toBe(k2);
    expect(k1).toBe("goldbear");
  });

  it("groups sizes of a named product and ignores brand drift", () => {
    expect(baseProductKey({ canonicalName: "Whole Milk 12 oz" })).toBe(
      baseProductKey({ canonicalName: "Whole Milk 1 gal" })
    );
  });

  it("does not collapse genuinely different products", () => {
    expect(baseProductKey({ canonicalName: "Whole Milk 12 oz" })).not.toBe(
      baseProductKey({ canonicalName: "Almond Milk 12 oz" })
    );
  });

  it("prefers canonicalName, falls back to description, and is empty for blank input", () => {
    expect(baseProductKey({ canonicalName: "Rainbow Sprinkles 8 oz", description: "RNBW SPRNKL" })).toBe(
      "rainbowsprinkle"
    );
    expect(baseProductKey({ description: "" })).toBe("");
  });
});

describe("categoryFromText", () => {
  it("maps frozen-dessert toppings (candy/gummy/syrup) to 'topping', never 'dairy'", () => {
    expect(categoryFromText("Rainbow Sprinkles")).toBe("topping");
    expect(categoryFromText("Gummy Bears")).toBe("topping");
    expect(categoryFromText("Strawberry Syrup")).toBe("topping");
    expect(categoryFromText("Chocolate Chips")).toBe("topping");
  });

  it("maps real dairy to 'dairy'", () => {
    expect(categoryFromText("Whole Milk")).toBe("dairy");
    expect(categoryFromText("Heavy Cream")).toBe("dairy");
    expect(categoryFromText("Vanilla Yogurt")).toBe("dairy");
  });

  it("maps packaging and other buckets", () => {
    expect(categoryFromText("Plastic Cups")).toBe("packaging");
    expect(categoryFromText("Strawberries")).toBe("fruit");
    expect(categoryFromText("Cane Sugar")).toBe("sweetener");
    expect(categoryFromText("Matcha Powder")).toBe("powder");
  });

  it("returns null for an opaque brand name (caller defaults to Other Food, not dairy)", () => {
    expect(categoryFromText("Gold Bears")).toBeNull();
    expect(categoryFromText("")).toBeNull();
    expect(categoryFromText(null)).toBeNull();
  });
});

describe("parseSizeToken — fraction guard", () => {
  it("never mis-parses a fraction's denominator as the size", () => {
    // "1/2 gal" must NOT become 2 gal; with no clean number-adjacent-unit it's unparseable -> null.
    expect(parseSizeToken("1/2 gal")).toBeNull();
    expect(parseSizeToken("Oat Milk 1/2 gal")).toBeNull();
    // A clean size right after still parses (the guard only blocks a digit/slash immediately before).
    expect(parseSizeToken("12 oz")).toEqual({ qty: 12, unit: "oz", kind: "weight" });
    expect(parseSizeToken("0.5 gal")).toEqual({ qty: 0.5, unit: "gal", kind: "volume" });
  });
});

describe("planScanGrouping", () => {
  const line = (index: number, matchId: string | null, canonicalName: string): Parameters<typeof planScanGrouping>[0][number] => ({
    index,
    matchId,
    canonicalName,
  });

  it("groups >=2 same-product new lines (different sizes) into one family with parsed packs", () => {
    const plan = planScanGrouping(
      [line(0, null, "Goldbears 28 oz"), line(1, null, "Gold Bears 5 lb")],
      [],
    );
    expect(plan[0]!.itemGroup).toBe("fam:goldbear");
    expect(plan[1]!.itemGroup).toBe("fam:goldbear");
    expect(plan[0]!.itemGroup).toBe(plan[1]!.itemGroup); // same item, two packs
    expect(plan[0]!.pack).toEqual({ qty: 28, unit: "oz", kind: "weight" });
    expect(plan[1]!.pack).toEqual({ qty: 5, unit: "lb", kind: "weight" });
    expect(plan[0]!.targetItemId).toBeNull();
  });

  it("maps a new size onto an EXISTING item it matches by base name", () => {
    const plan = planScanGrouping(
      [line(0, null, "Gold Bears 5 lb")],
      [{ id: "item-gb", name: "Goldbears 28 oz" }], // base key "goldbear" already in the catalog
    );
    expect(plan[0]!.targetItemId).toBe("item-gb");
    expect(plan[0]!.itemGroup).toBeNull();
    expect(plan[0]!.pack).toEqual({ qty: 5, unit: "lb", kind: "weight" });
  });

  it("leaves an already-matched line untouched", () => {
    const plan = planScanGrouping([line(0, "item-x", "Whole Milk 12 oz")], [{ id: "item-x", name: "Whole Milk" }]);
    expect(plan[0]).toEqual({ index: 0, targetItemId: null, itemGroup: null, pack: null });
  });

  it("a lone new line gets its pack but no group", () => {
    const plan = planScanGrouping([line(0, null, "Rainbow Sprinkles 8 oz")], []);
    expect(plan[0]!.itemGroup).toBeNull();
    expect(plan[0]!.targetItemId).toBeNull();
    expect(plan[0]!.pack).toEqual({ qty: 8, unit: "oz", kind: "weight" });
  });

  it("never auto-maps onto an AMBIGUOUS base key (two catalog items share it)", () => {
    const plan = planScanGrouping(
      [line(0, null, "Milk 12 oz")],
      [
        { id: "item-a", name: "Milk 1 gal" },
        { id: "item-b", name: "Milk 2 L" },
      ],
    );
    // base key "milk" maps to two items -> ambiguous -> not auto-mapped (operator picks).
    expect(plan[0]!.targetItemId).toBeNull();
  });
});

describe("convertSize", () => {
  it("converts within a kind via exact factors", () => {
    expect(convertSize({ qty: 5, unit: "lb", kind: "weight" }, "oz")).toBe(80); // lb->oz = x16
    expect(convertSize({ qty: 1, unit: "gal", kind: "volume" }, "fl oz")).toBe(128); // gal->fl oz
    expect(convertSize({ qty: 1, unit: "L", kind: "volume" }, "ml")).toBe(1000);
    expect(convertSize({ qty: 2, unit: "kg", kind: "weight" }, "g")).toBe(2000);
  });
  it("passes through the same unit and refuses cross-kind / unknown units", () => {
    expect(convertSize({ qty: 28, unit: "oz", kind: "weight" }, "oz")).toBe(28);
    expect(convertSize({ qty: 1, unit: "oz", kind: "weight" }, "ml")).toBeNull(); // weight->volume
    expect(convertSize({ qty: 1, unit: "bag", kind: "count" }, "oz")).toBeNull(); // unknown unit
  });
});

describe("chooseFamilyBaseUnit", () => {
  it("picks the most granular unit among same-kind sizes", () => {
    expect(chooseFamilyBaseUnit([{ qty: 28, unit: "oz", kind: "weight" }, { qty: 5, unit: "lb", kind: "weight" }])).toBe("oz");
    expect(chooseFamilyBaseUnit([{ qty: 1, unit: "L", kind: "volume" }, { qty: 500, unit: "ml", kind: "volume" }])).toBe("ml");
  });
  it("returns null for mixed kinds or no known unit", () => {
    expect(chooseFamilyBaseUnit([{ qty: 1, unit: "oz", kind: "weight" }, { qty: 1, unit: "gal", kind: "volume" }])).toBeNull();
    expect(chooseFamilyBaseUnit([])).toBeNull();
  });
});

describe("resolveScanPacks", () => {
  const line = (index: number, matchId: string | null, canonicalName: string): Parameters<typeof resolveScanPacks>[0][number] => ({
    index,
    matchId,
    canonicalName,
  });

  it("resolves a multi-size family to one base unit with converted packs", () => {
    const out = resolveScanPacks([line(0, null, "Goldbears 28 oz"), line(1, null, "Gold Bears 5 lb")], []);
    expect(out[0]!.itemGroup).toBe("fam:goldbear");
    expect(out[1]!.itemGroup).toBe("fam:goldbear");
    expect(out[0]!.baseUnit).toBe("oz");
    expect(out[1]!.baseUnit).toBe("oz");
    expect(out[0]!.pack).toEqual({ label: "28 oz", baseQtyPerPack: 28 });
    expect(out[1]!.pack).toEqual({ label: "5 lb", baseQtyPerPack: 80 }); // 5 lb -> 80 oz
    expect(out[0]!.needsPackInput).toBe(false);
  });

  it("keeps a no-size family member in the family but flags it for operator pack entry", () => {
    const out = resolveScanPacks([line(0, null, "Goldbears 28 oz"), line(1, null, "Gold Bears")], []);
    expect(out[1]!.itemGroup).toBe("fam:goldbear");
    expect(out[1]!.baseUnit).toBe("oz"); // inherited from the sibling that had a size
    expect(out[1]!.pack).toBeNull();
    expect(out[1]!.needsPackInput).toBe(true);
  });

  it("adds a new size onto an existing item, converted into that item's base unit", () => {
    const out = resolveScanPacks(
      [line(0, null, "Gold Bears 5 lb")],
      [{ id: "item-gb", name: "Goldbears 28 oz", unit: "oz" }],
    );
    expect(out[0]!.targetItemId).toBe("item-gb");
    expect(out[0]!.baseUnit).toBe("oz");
    expect(out[0]!.pack).toEqual({ label: "5 lb", baseQtyPerPack: 80 });
  });

  it("flags new-pack-of-existing for operator input when the unit can't convert", () => {
    const out = resolveScanPacks(
      [line(0, null, "Gold Bears 5 lb")],
      [{ id: "item-gb", name: "Goldbears 28 oz", unit: "bag" }], // "bag" isn't a convertible unit
    );
    expect(out[0]!.targetItemId).toBe("item-gb");
    expect(out[0]!.pack).toBeNull();
    expect(out[0]!.needsPackInput).toBe(true);
  });

  it("leaves a lone new line and a matched line flat (no auto pack)", () => {
    const lone = resolveScanPacks([line(0, null, "Rainbow Sprinkles 8 oz")], []);
    expect(lone[0]).toEqual({ index: 0, targetItemId: null, itemGroup: null, baseUnit: null, pack: null, needsPackInput: false });
    const matched = resolveScanPacks([line(0, "item-x", "Whole Milk 12 oz")], [{ id: "item-x", name: "Whole Milk", unit: "oz" }]);
    expect(matched[0]!.pack).toBeNull();
    expect(matched[0]!.needsPackInput).toBe(false);
  });
});

describe("baseProductName", () => {
  it("strips the size token but keeps case + spacing", () => {
    expect(baseProductName("Gummy Bears 28 Oz")).toBe("Gummy Bears");
    expect(baseProductName("Goldbears 28 oz")).toBe("Goldbears");
    expect(baseProductName("Whole Milk 1/2 gal")).toBe("Whole Milk 1/2 gal"); // fraction not a size -> kept
    expect(baseProductName("Gold Bears")).toBe("Gold Bears"); // no size -> unchanged
    expect(baseProductName("")).toBe("");
  });
});
