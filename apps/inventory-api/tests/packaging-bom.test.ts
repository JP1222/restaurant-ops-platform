import { describe, expect, it } from "vitest";

import type { CloverMenuItem, RecipeBomLine } from "../src/lib/inventory-store.js";
import {
  categoryToPackagingType,
  classifyPackaging,
  mergeBomLines,
  planPackaging,
  PACKAGING_SKUS,
  SPOON_ITEM_ID
} from "../src/lib/packaging-bom.js";

function coldDrink(name: string): CloverMenuItem {
  return { cloverItemId: `cd-${name}`, name, category: "COLD DRINKS", priceCents: 219 };
}

describe("categoryToPackagingType", () => {
  it("maps the dessert/tea categories; SPECIALS counts as rolled ice cream", () => {
    expect(categoryToPackagingType("ROLLED ICE CREAM")).toBe("rolled-icecream");
    expect(categoryToPackagingType("SPECIALS")).toBe("rolled-icecream");
    expect(categoryToPackagingType("BUBBLE TEA")).toBe("bubble-tea");
    expect(categoryToPackagingType("SMOOTHIE")).toBe("smoothie");
  });

  it("returns null for categories with no packaging rule (cold/hot drinks)", () => {
    expect(categoryToPackagingType("COLD DRINKS")).toBeNull();
    expect(categoryToPackagingType("HOT DRINKS")).toBeNull();
    expect(categoryToPackagingType("Uncategorized")).toBeNull();
  });
});

describe("classifyPackaging (per-item cold-drink overrides)", () => {
  it("gives iced teas a cup + straw + lid", () => {
    for (const name of ["Ice Thai Tea", "Ice Chocolate", "Iced Tea"]) {
      expect(classifyPackaging(coldDrink(name))).toBe("iced-tea");
    }
  });

  it("gives Cup of Ice / Cup of Water a cup + lid (no straw)", () => {
    expect(classifyPackaging(coldDrink("Cup of Ice"))).toBe("iced-plain");
    expect(classifyPackaging(coldDrink("Cup of Water"))).toBe("iced-plain");
  });

  it("gives bottled drinks / Frappuccino / Coffee no packaging", () => {
    expect(classifyPackaging(coldDrink("Bottle Water"))).toBeNull();
    expect(classifyPackaging(coldDrink("Bottle Drink"))).toBeNull();
    expect(classifyPackaging(coldDrink("Starbucks Frappuccino"))).toBeNull();
    expect(classifyPackaging({ cloverItemId: "c", name: "Coffee", category: "HOT DRINKS", priceCents: 169 })).toBeNull();
  });

  it("still resolves dessert/tea via the category map (not the name override)", () => {
    expect(classifyPackaging({ cloverItemId: "r", name: "Vanilla Rolled", category: "ROLLED ICE CREAM", priceCents: 699 })).toBe(
      "rolled-icecream"
    );
  });
});

describe("mergeBomLines (additive, packaging-only replace)", () => {
  const ingredient: RecipeBomLine = { sku: "ing-tapioca", qty: 2 };
  const packaging: RecipeBomLine[] = [
    { sku: "ing-plastic-cup", qty: 1 },
    { sku: "ing-straw", qty: 1 }
  ];

  it("keeps non-packaging (ingredient) lines and appends packaging", () => {
    expect(mergeBomLines([ingredient], packaging)).toEqual([ingredient, ...packaging]);
  });

  it("replaces stale packaging lines instead of duplicating them (idempotent re-run)", () => {
    const existing: RecipeBomLine[] = [ingredient, { sku: "ing-plastic-cup", qty: 9 }, { sku: SPOON_ITEM_ID, qty: 5 }];
    // Re-running with the same packaging set must not duplicate cup lines or leave the stale qty 9 / the spoon.
    expect(mergeBomLines(existing, packaging)).toEqual([ingredient, ...packaging]);
  });

  it("on a fresh recipe (no lines) yields exactly the packaging", () => {
    expect(mergeBomLines([], packaging)).toEqual(packaging);
  });

  it("PACKAGING_SKUS includes the reused existing Spoon id", () => {
    expect(PACKAGING_SKUS.has(SPOON_ITEM_ID)).toBe(true);
  });
});

describe("planPackaging", () => {
  function recipe(partial: Partial<CloverMenuItem>): CloverMenuItem {
    return { cloverItemId: "id", name: "X", category: "BUBBLE TEA", priceCents: 599, ...partial };
  }

  it("classifies recipes and emits the right lines per type; skips drinks", () => {
    const recipes: CloverMenuItem[] = [
      recipe({ cloverItemId: "ric", name: "Vanilla Rolled", category: "ROLLED ICE CREAM" }),
      recipe({ cloverItemId: "spc", name: "Special #1", category: "SPECIALS" }),
      recipe({ cloverItemId: "bt", name: "Mango Bubble Tea", category: "BUBBLE TEA" }),
      recipe({ cloverItemId: "sm", name: "Mango Smoothie", category: "SMOOTHIE" }),
      recipe({ cloverItemId: "cd", name: "Coffee", category: "HOT DRINKS" })
    ];
    const plan = planPackaging(recipes);

    expect(plan.matched).toHaveLength(4);
    expect(plan.skipped).toEqual([{ name: "Coffee", category: "HOT DRINKS" }]);

    const rolled = plan.matched.find((m) => m.recipeId === "ric");
    expect(rolled?.type).toBe("rolled-icecream");
    expect(rolled?.lines).toEqual([
      { sku: "ing-12oz-paper-cup", qty: 1 },
      { sku: SPOON_ITEM_ID, qty: 1 }
    ]);

    const special = plan.matched.find((m) => m.recipeId === "spc");
    expect(special?.type).toBe("rolled-icecream");

    const bubble = plan.matched.find((m) => m.recipeId === "bt");
    expect(bubble?.lines).toEqual([
      { sku: "ing-plastic-cup", qty: 1 },
      { sku: "ing-straw", qty: 1 },
      { sku: "ing-cup-lid", qty: 1 }
    ]);

    // bubble tea and smoothie share the same cup + lid
    const smoothie = plan.matched.find((m) => m.recipeId === "sm");
    expect(smoothie?.lines).toEqual(bubble?.lines);
  });
});
