import { describe, expect, it } from "vitest";
import type { SquareCatalogObject } from "../src/domain/normalize-square-catalog.js";

import { selectSquareRecipes } from "../src/domain/square-recipe-mirror.js";

const LOC = "LOC1";

function category(id: string, name: string): SquareCatalogObject {
  return { id, type: "CATEGORY", categoryData: { name } };
}

function variation(
  id: string,
  name: string,
  amount: number | null,
  opts: { variable?: boolean; deleted?: boolean } = {}
): SquareCatalogObject {
  return {
    id,
    type: "ITEM_VARIATION",
    isDeleted: opts.deleted ?? false,
    itemVariationData: {
      name,
      pricingType: opts.variable ? "VARIABLE_PRICING" : "FIXED_PRICING",
      priceMoney: amount == null ? null : { amount: BigInt(amount), currency: "USD" }
    }
  };
}

function item(
  id: string,
  name: string,
  variations: SquareCatalogObject[],
  opts: { catId?: string; archived?: boolean; absentAt?: string[] } = {}
): SquareCatalogObject {
  return {
    id,
    type: "ITEM",
    presentAtAllLocations: opts.absentAt ? false : true,
    presentAtLocationIds: [LOC],
    absentAtLocationIds: opts.absentAt ?? [],
    itemData: {
      name,
      reportingCategory: opts.catId ? { id: opts.catId } : undefined,
      isArchived: opts.archived ?? false,
      variations
    }
  };
}

describe("selectSquareRecipes (per ITEM_VARIATION)", () => {
  it("keys a single-variation item by the VARIATION id, not the item id", () => {
    const rows = selectSquareRecipes(
      [
        category("cat1", "ROLLED ICE CREAM"),
        item("ITEM_VAN", "Vanilla Roll", [variation("VAR_VAN", "Regular", 699)], { catId: "cat1" })
      ],
      LOC
    );
    expect(rows).toEqual([
      { squareCatalogObjectId: "VAR_VAN", name: "Vanilla Roll", category: "ROLLED ICE CREAM", priceCents: 699 }
    ]);
    // The crux of the fix: the join key is the variation id (what orders carry), NOT "ITEM_VAN".
    expect(rows[0]!.squareCatalogObjectId).not.toBe("ITEM_VAN");
  });

  it("emits one row per variation for a multi-variation item, disambiguating the name", () => {
    const rows = selectSquareRecipes(
      [
        item("ITEM_TEA", "Bubble Tea", [
          variation("VAR_REG", "Regular", 500),
          variation("VAR_LRG", "Large", 650)
        ])
      ],
      LOC
    );
    expect(rows).toEqual([
      { squareCatalogObjectId: "VAR_REG", name: "Bubble Tea (Regular)", category: "Menu", priceCents: 500 },
      { squareCatalogObjectId: "VAR_LRG", name: "Bubble Tea (Large)", category: "Menu", priceCents: 650 }
    ]);
  });

  it("drops $0 and VARIABLE_PRICING variations", () => {
    const rows = selectSquareRecipes(
      [
        item("ITEM_X", "Mixed", [
          variation("VAR_PAID", "Regular", 400),
          variation("VAR_FREE", "Free Mod", 0),
          variation("VAR_VAR", "Ask", null, { variable: true })
        ])
      ],
      LOC
    );
    expect(rows.map((r) => r.squareCatalogObjectId)).toEqual(["VAR_PAID"]);
  });

  it("drops archived items, deleted variations, and items absent at the location", () => {
    const rows = selectSquareRecipes(
      [
        item("ITEM_ARCH", "Archived", [variation("VAR_A", "Regular", 500)], { archived: true }),
        item("ITEM_ABSENT", "Absent Here", [variation("VAR_B", "Regular", 500)], { absentAt: [LOC] }),
        item("ITEM_DEL", "Has Deleted Var", [variation("VAR_C", "Regular", 500, { deleted: true })]),
        item("ITEM_OK", "Keep Me", [variation("VAR_OK", "Regular", 500)])
      ],
      LOC
    );
    expect(rows.map((r) => r.squareCatalogObjectId)).toEqual(["VAR_OK"]);
  });

  it("drops structurally-empty items and returns [] for an empty catalog", () => {
    expect(selectSquareRecipes([], LOC)).toEqual([]);
    const rows = selectSquareRecipes(
      [item("ITEM_NONAME", "  ", [variation("VAR_N", "Regular", 500)])],
      LOC
    );
    expect(rows).toEqual([]);
  });
});
