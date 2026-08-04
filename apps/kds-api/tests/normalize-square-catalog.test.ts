import { describe, expect, it } from "vitest";

import {
  normalizeSquareCatalog,
  summarizeSquareCatalog,
  type SquareCatalogObject,
} from "../src/domain/normalize-square-catalog.js";

const LOCATION = "LV78H3YNW202D";
const OTHER_LOCATION = "LXXXOTHERXXX";

// A realistic-ish catalog: two categories, a modifier list shared by two items,
// one variable-priced item, plus per-location and deletion edge cases.
function fixture(): SquareCatalogObject[] {
  return [
    { type: "CATEGORY", id: "CAT_SCOOPS", categoryData: { name: "Scoops" } },
    { type: "CATEGORY", id: "CAT_DRINKS", categoryData: { name: "Drinks" } },
    {
      type: "MODIFIER_LIST",
      id: "ML_TOPPINGS",
      modifierListData: {
        name: "Toppings",
        selectionType: "MULTIPLE",
        maxSelectedModifiers: 3n,
        minSelectedModifiers: 0n,
        modifiers: [
          { type: "MODIFIER", id: "MOD_SPRINKLES", modifierData: { name: "Sprinkles", priceMoney: { amount: 0n, currency: "USD" } } },
          { type: "MODIFIER", id: "MOD_FUDGE", modifierData: { name: "Hot Fudge", priceMoney: { amount: 75n, currency: "USD" } } },
        ],
      },
    },
    {
      type: "ITEM",
      id: "ITEM_VANILLA",
      itemData: {
        name: "Vanilla Scoop",
        description: "Single scoop",
        reportingCategory: { id: "CAT_SCOOPS" },
        modifierListInfo: [{ modifierListId: "ML_TOPPINGS", enabled: true }],
        variations: [
          {
            type: "ITEM_VARIATION",
            id: "VAR_VANILLA",
            itemVariationData: {
              name: "Regular",
              pricingType: "FIXED_PRICING",
              priceMoney: { amount: 450n, currency: "USD" },
              // A re-price at the BOUND location only.
              locationOverrides: [{ locationId: LOCATION, priceMoney: { amount: 500n, currency: "USD" } }],
            },
          },
        ],
      },
    },
    {
      type: "ITEM",
      id: "ITEM_MARKET",
      itemData: {
        name: "Market Price Sundae",
        reportingCategory: { id: "CAT_SCOOPS" },
        variations: [
          {
            type: "ITEM_VARIATION",
            id: "VAR_MARKET",
            itemVariationData: { name: "Regular", pricingType: "VARIABLE_PRICING" },
          },
        ],
      },
    },
    {
      type: "ITEM",
      id: "ITEM_COLA",
      itemData: {
        name: "Cola",
        reportingCategory: { id: "CAT_DRINKS" },
        variations: [
          {
            type: "ITEM_VARIATION",
            id: "VAR_COLA",
            itemVariationData: { name: "Regular", pricingType: "FIXED_PRICING", priceMoney: { amount: 250n, currency: "USD" } },
          },
        ],
      },
    },
  ];
}

describe("normalizeSquareCatalog", () => {
  it("normalizes items, joins modifier lists by id, and applies the location price override", () => {
    const menu = normalizeSquareCatalog(fixture(), LOCATION);

    expect(menu.categories).toEqual(["Scoops", "Drinks"]);

    const vanilla = menu.items.find((item) => item.id === "ITEM_VANILLA");
    expect(vanilla).toBeDefined();
    // 500 (location override) wins over the 450 base price.
    expect(vanilla?.priceCents).toBe(500);
    expect(vanilla?.category).toBe("Scoops");
    expect(vanilla?.description).toBe("Single scoop");
    expect(vanilla?.modifierGroups).toHaveLength(1);
    const toppings = vanilla?.modifierGroups[0];
    expect(toppings?.name).toBe("Toppings");
    expect(toppings?.minSelections).toBe(0);
    expect(toppings?.maxSelections).toBe(3);
    expect(toppings?.modifiers).toEqual([
      { id: "MOD_SPRINKLES", name: "Sprinkles", priceDeltaCents: 0, group: "Toppings" },
      { id: "MOD_FUDGE", name: "Hot Fudge", priceDeltaCents: 75, group: "Toppings" },
    ]);
  });

  it("falls back to the base price when there is no override for the bound location", () => {
    const menu = normalizeSquareCatalog(fixture(), OTHER_LOCATION);
    const vanilla = menu.items.find((item) => item.id === "ITEM_VANILLA");
    expect(vanilla?.priceCents).toBe(450);
  });

  it("prices a VARIABLE_PRICING item at 0 (no fixed amount), still listing it", () => {
    const menu = normalizeSquareCatalog(fixture(), LOCATION);
    const market = menu.items.find((item) => item.id === "ITEM_MARKET");
    expect(market).toBeDefined();
    expect(market?.priceCents).toBe(0);
  });

  it("never emits a bigint (the v44 JSON.stringify footgun) — output is JSON-safe", () => {
    const menu = normalizeSquareCatalog(fixture(), LOCATION);
    // Would throw "Do not know how to serialize a BigInt" if any bigint leaked.
    expect(() => JSON.stringify(menu)).not.toThrow();
    for (const item of menu.items) {
      expect(typeof item.priceCents).toBe("number");
    }
  });

  it("skips deleted and archived items", () => {
    const objects = fixture();
    objects.push({
      type: "ITEM",
      id: "ITEM_DELETED",
      isDeleted: true,
      itemData: { name: "Old Flavor", variations: [] },
    });
    objects.push({
      type: "ITEM",
      id: "ITEM_ARCHIVED",
      itemData: { name: "Archived Flavor", isArchived: true, variations: [] },
    });
    const menu = normalizeSquareCatalog(objects, LOCATION);
    expect(menu.items.map((item) => item.id)).not.toContain("ITEM_DELETED");
    expect(menu.items.map((item) => item.id)).not.toContain("ITEM_ARCHIVED");
  });

  it("filters items by present-at-location (absent / not-present-at-all)", () => {
    const objects = fixture();
    // Absent at the bound location.
    objects.push({
      type: "ITEM",
      id: "ITEM_ABSENT",
      absentAtLocationIds: [LOCATION],
      itemData: {
        name: "Hidden Here",
        variations: [
          { type: "ITEM_VARIATION", id: "V_ABSENT", itemVariationData: { pricingType: "FIXED_PRICING", priceMoney: { amount: 100n } } },
        ],
      },
    });
    // Present only at another location.
    objects.push({
      type: "ITEM",
      id: "ITEM_OTHER_ONLY",
      presentAtAllLocations: false,
      presentAtLocationIds: [OTHER_LOCATION],
      itemData: {
        name: "Other Store Only",
        variations: [
          { type: "ITEM_VARIATION", id: "V_OTHER", itemVariationData: { pricingType: "FIXED_PRICING", priceMoney: { amount: 100n } } },
        ],
      },
    });
    const ids = normalizeSquareCatalog(objects, LOCATION).items.map((item) => item.id);
    expect(ids).not.toContain("ITEM_ABSENT");
    expect(ids).not.toContain("ITEM_OTHER_ONLY");
  });

  it("uses 'Menu' as the category fallback for an uncategorized item", () => {
    const objects: SquareCatalogObject[] = [
      {
        type: "ITEM",
        id: "ITEM_UNCAT",
        itemData: {
          name: "Mystery",
          variations: [
            { type: "ITEM_VARIATION", id: "V_UNCAT", itemVariationData: { pricingType: "FIXED_PRICING", priceMoney: { amount: 300n } } },
          ],
        },
      },
    ];
    const menu = normalizeSquareCatalog(objects, LOCATION);
    expect(menu.categories).toEqual(["Menu"]);
    expect(menu.items[0]?.category).toBe("Menu");
  });

  it("defaults a SINGLE-selection modifier list with no max to maxSelections 1", () => {
    const objects: SquareCatalogObject[] = [
      {
        type: "MODIFIER_LIST",
        id: "ML_SIZE",
        modifierListData: {
          name: "Size",
          selectionType: "SINGLE",
          modifiers: [
            { type: "MODIFIER", id: "M_SM", modifierData: { name: "Small", priceMoney: { amount: 0n } } },
            { type: "MODIFIER", id: "M_LG", modifierData: { name: "Large", priceMoney: { amount: 100n } } },
          ],
        },
      },
      {
        type: "ITEM",
        id: "ITEM_SIZED",
        itemData: {
          name: "Sundae",
          modifierListInfo: [{ modifierListId: "ML_SIZE" }],
          variations: [
            { type: "ITEM_VARIATION", id: "V_SIZED", itemVariationData: { pricingType: "FIXED_PRICING", priceMoney: { amount: 600n } } },
          ],
        },
      },
    ];
    const group = normalizeSquareCatalog(objects, LOCATION).items[0]?.modifierGroups[0];
    expect(group?.maxSelections).toBe(1);
    expect(group?.minSelections).toBe(0);
  });

  it("honors a per-item modifierListInfo min/max override over the list-level value", () => {
    const objects: SquareCatalogObject[] = [
      {
        type: "MODIFIER_LIST",
        id: "ML_TOP",
        modifierListData: {
          name: "Toppings",
          selectionType: "MULTIPLE",
          minSelectedModifiers: 0n,
          maxSelectedModifiers: 5n,
          modifiers: [{ type: "MODIFIER", id: "M_A", modifierData: { name: "A", priceMoney: { amount: 0n } } }],
        },
      },
      {
        type: "ITEM",
        id: "ITEM_TOP",
        itemData: {
          name: "Item",
          modifierListInfo: [{ modifierListId: "ML_TOP", minSelectedModifiers: 1, maxSelectedModifiers: 2 }],
          variations: [
            { type: "ITEM_VARIATION", id: "V_TOP", itemVariationData: { pricingType: "FIXED_PRICING", priceMoney: { amount: 600n } } },
          ],
        },
      },
    ];
    const group = normalizeSquareCatalog(objects, LOCATION).items[0]?.modifierGroups[0];
    expect(group?.minSelections).toBe(1);
    expect(group?.maxSelections).toBe(2);
  });

  it("drops a disabled modifierListInfo and an unknown modifier-list reference", () => {
    const objects: SquareCatalogObject[] = [
      {
        type: "ITEM",
        id: "ITEM_X",
        itemData: {
          name: "X",
          modifierListInfo: [
            { modifierListId: "ML_GONE" }, // not in the catalog
            { modifierListId: "ML_TOPPINGS", enabled: false }, // disabled
          ],
          variations: [
            { type: "ITEM_VARIATION", id: "V_X", itemVariationData: { pricingType: "FIXED_PRICING", priceMoney: { amount: 100n } } },
          ],
        },
      },
      {
        type: "MODIFIER_LIST",
        id: "ML_TOPPINGS",
        modifierListData: { name: "Toppings", modifiers: [] },
      },
    ];
    const item = normalizeSquareCatalog(objects, LOCATION).items[0];
    expect(item?.modifierGroups).toEqual([]);
  });
});

describe("summarizeSquareCatalog", () => {
  it("counts visible items + categories from the menu and dedups catalog modifiers", () => {
    const { menu, counts } = summarizeSquareCatalog(fixture(), LOCATION);
    expect(counts.itemCount).toBe(menu.items.length);
    expect(counts.itemCount).toBe(3); // vanilla, market, cola
    expect(counts.categoryCount).toBe(2); // Scoops, Drinks
    expect(counts.modifierCount).toBe(2); // Sprinkles + Hot Fudge (one shared list)
  });
});
