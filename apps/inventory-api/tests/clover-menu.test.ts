import { describe, expect, it } from "vitest";

import {
  parseCatalogItem,
  selectRecipes,
  shouldMirrorAsRecipe,
  toCloverMenuItem,
  type CloverCatalogItem
} from "../src/lib/clover-menu.js";

// A valid menu item by default; override fields per case.
function item(partial: Partial<CloverCatalogItem>): CloverCatalogItem {
  return {
    id: "id-1",
    name: "X",
    priceCents: 599,
    priceType: "FIXED",
    hidden: false,
    available: true,
    categoryNames: ["BUBBLE TEA"],
    ...partial
  };
}

describe("parseCatalogItem", () => {
  it("normalizes the Clover items?expand=categories shape", () => {
    const raw = {
      id: "ABC123",
      name: "Mango Bubble Tea",
      price: 599,
      priceType: "FIXED",
      categories: { elements: [{ id: "c1", name: "BUBBLE TEA" }] }
    };
    expect(parseCatalogItem(raw)).toEqual({
      id: "ABC123",
      name: "Mango Bubble Tea",
      priceCents: 599,
      priceType: "FIXED",
      hidden: false,
      available: true,
      categoryNames: ["BUBBLE TEA"]
    });
  });

  it("is defensive about missing / malformed fields", () => {
    expect(parseCatalogItem({})).toEqual({
      id: "",
      name: "",
      priceCents: 0,
      priceType: "FIXED",
      hidden: false,
      available: true,
      categoryNames: []
    });
    expect(parseCatalogItem(null).categoryNames).toEqual([]);
    expect(parseCatalogItem({ categories: { elements: "nope" } }).categoryNames).toEqual([]);
  });
});

describe("toCloverMenuItem", () => {
  it("maps id/name/price and the first category", () => {
    expect(
      toCloverMenuItem(item({ id: "X1", name: "Taro Bubble Tea", priceCents: 599 }))
    ).toEqual({ cloverItemId: "X1", name: "Taro Bubble Tea", category: "BUBBLE TEA", priceCents: 599 });
  });
});

describe("shouldMirrorAsRecipe (default policy)", () => {
  it("keeps a fixed-price item in a menu category", () => {
    expect(shouldMirrorAsRecipe(item({ name: "Coffee", categoryNames: ["HOT DRINKS"], priceCents: 169 }))).toBe(true);
  });

  it("drops uncategorized retail / junk (LIGHT BULB, RED BULL)", () => {
    expect(shouldMirrorAsRecipe(item({ name: "LIGHT BULB", categoryNames: [], priceCents: 499 }))).toBe(false);
    expect(shouldMirrorAsRecipe(item({ name: "RED BULL", categoryNames: [], priceCents: 365 }))).toBe(false);
  });

  it("drops $0 modifier placeholders (Whipped Cream)", () => {
    expect(shouldMirrorAsRecipe(item({ name: "Whipped Cream", categoryNames: [], priceCents: 0 }))).toBe(false);
  });

  it("drops variable-price fees / gift cards", () => {
    expect(
      shouldMirrorAsRecipe(item({ name: "Gift card", categoryNames: [], priceType: "VARIABLE", priceCents: 0 }))
    ).toBe(false);
  });

  it("drops hidden items (Delivery Fee)", () => {
    expect(
      shouldMirrorAsRecipe(item({ name: "Delivery Fee", hidden: true, priceType: "VARIABLE", categoryNames: [] }))
    ).toBe(false);
  });

  it("drops in-category junk by exact name (TEST_ITEM in COLD DRINKS)", () => {
    expect(shouldMirrorAsRecipe(item({ name: "TEST_ITEM", categoryNames: ["COLD DRINKS"], priceCents: 11 }))).toBe(false);
  });
});

describe("selectRecipes", () => {
  it("filters junk and maps the survivors to recipe DTOs", () => {
    const catalog: CloverCatalogItem[] = [
      item({ id: "bt", name: "Mango Bubble Tea", categoryNames: ["BUBBLE TEA"], priceCents: 599 }),
      item({ id: "ric", name: "VANILLA ROLLED ICE CREAM", categoryNames: ["ROLLED ICE CREAM"], priceCents: 699 }),
      item({ id: "junk", name: "LIGHT BULB", categoryNames: [], priceCents: 499 }),
      item({ id: "test", name: "TEST_ITEM", categoryNames: ["COLD DRINKS"], priceCents: 11 }),
      item({ id: "wc", name: "Whipped Cream", categoryNames: [], priceCents: 0 })
    ];
    expect(selectRecipes(catalog)).toEqual([
      { cloverItemId: "bt", name: "Mango Bubble Tea", category: "BUBBLE TEA", priceCents: 599 },
      { cloverItemId: "ric", name: "VANILLA ROLLED ICE CREAM", category: "ROLLED ICE CREAM", priceCents: 699 }
    ]);
  });
});
