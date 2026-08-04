import type { SquareRecipeImport } from "@rop/contracts";

import {
  type SquareCatalogObject,
  isPresentAtLocation,
  resolveCategoryName,
  variationPriceCents
} from "./normalize-square-catalog.js";

// Map a raw Square catalog down to the flat recipe-mirror rows that seed inventory
// recipes (store #2; docs/square-onboarding.md). The Square sibling of clover-menu.ts's
// selectRecipes.
//
// CRITICAL — key by the ITEM_VARIATION id, NOT the ITEM id. A Square order line
// references the catalog *variation* (`catalogObjectId` = the variation id), and the
// analytics sold-items feed carries that same variation id as `square_catalog_item_id`.
// The depletion join (depleteSoldItems) matches a recipe by that id, so the recipe must
// be keyed by the variation id or the id-join misses and silently falls back to name
// matching. This is why we read the RAW catalog (which exposes each item's variations)
// rather than the normalized menu (which collapses an item to one ITEM id).
//
// One row PER VARIATION: a single-variation item yields one recipe (its sole SKU);
// a multi-variation item ("Regular"/"Large") yields one recipe per SKU, since different
// sizes can deplete different amounts. The name disambiguates multi-variation items as
// "<item> (<variation>)" so the recipe list stays readable; single-variation items keep
// the clean item name.
//
// Why a filter: we drop $0 / non-priced variations (modifier placeholders,
// gift-card-shaped items) and structurally-empty rows, mirroring the Clover rule that a
// recipe must have a real sell price. present-at-location + archived/deleted filtering
// reuses the menu normalizer's helpers so the two never drift.
export function selectSquareRecipes(
  objects: SquareCatalogObject[],
  locationId: string
): SquareRecipeImport {
  const categoryNames = new Map<string, string>();
  for (const obj of objects) {
    if (obj.type === "CATEGORY" && obj.id && !obj.isDeleted) {
      categoryNames.set(obj.id, obj.categoryData?.name ?? "");
    }
  }

  const rows: SquareRecipeImport = [];
  for (const obj of objects) {
    if (obj.type !== "ITEM" || !obj.id || obj.isDeleted) {
      continue;
    }
    const item = obj.itemData;
    if (!item || item.isArchived === true || !isPresentAtLocation(obj, locationId)) {
      continue;
    }
    const itemName = (item.name ?? "").trim();
    if (itemName === "") {
      continue; // structurally invalid
    }
    const category = resolveCategoryName(item, categoryNames);

    const variations = (item.variations ?? []).filter(
      (v) => v.type === "ITEM_VARIATION" && !v.isDeleted && typeof v.id === "string" && v.id !== ""
    );
    const multiVariation = variations.length > 1;

    for (const variation of variations) {
      const data = variation.itemVariationData;
      if (!data || data.pricingType === "VARIABLE_PRICING") {
        continue; // variable price = not a fixed-price plated SKU
      }
      const priceCents = variationPriceCents(data, locationId) ?? 0;
      if (priceCents <= 0) {
        continue; // $0 = modifier / placeholder, not a plated recipe
      }
      const variationName = (data.name ?? "").trim();
      const name =
        multiVariation && variationName !== "" ? `${itemName} (${variationName})` : itemName;
      rows.push({
        squareCatalogObjectId: variation.id as string,
        name,
        category,
        priceCents
      });
    }
  }
  return rows;
}
