import type {
  OrderMenuItem,
  OrderMenuModifier,
  OrderMenuModifierGroup,
  OrderMenuResponse,
} from "@rop/contracts";

import { squareMoneyToCents } from "./square-money.js";

/**
 * Normalize a Square catalog snapshot (items + item variations + modifier lists +
 * categories, read flat from `catalog.list`) into the POS-neutral
 * OrderMenuResponse the ordering surface consumes — the Square sibling of
 * normalize-menu.ts (Clover).
 *
 * Defensive on purpose (mirrors normalize-menu.ts), but typed against a minimal
 * structural slice of the Square v44 catalog model rather than `square`'s SDK
 * types, so the transform is unit-testable with plain fixtures and decoupled from
 * the vendor package.
 *
 * The structural seams that differ from Clover and bite if mishandled:
 *  - **Price lives on ITEM_VARIATION, not the item.** A single-price item is one
 *    "Regular" variation; we take the first FIXED-priced variation as the item's
 *    price. `VARIABLE_PRICING` variations carry no amount → priced 0 (read-only
 *    menu; checkout is deferred and will resolve true variation pricing).
 *  - **`Money.amount` is `bigint`** (the #1 v44 footgun: `JSON.stringify` throws
 *    on bigint). moneyToCents coerces at this boundary so no bigint escapes.
 *  - **Relationships are by id, flat.** Items reference modifier lists via
 *    `modifierListInfo[].modifierListId` and categories via `reportingCategory` /
 *    `categories` / `categoryId`; we index the MODIFIER_LIST + CATEGORY objects
 *    and join. (Modifier lists carry their MODIFIERs embedded.)
 *  - **Per-location visibility + price.** `presentAtAllLocations` /
 *    `absentAtLocationIds` / `presentAtLocationIds` gate an object at the bound
 *    location; `ItemVariation.locationOverrides` can re-price it there.
 */

export interface SquareMoney {
  amount?: bigint | number | null;
  currency?: string | null;
}

export interface SquareItemVariationData {
  name?: string | null;
  pricingType?: string | null; // "FIXED_PRICING" | "VARIABLE_PRICING"
  priceMoney?: SquareMoney | null;
  locationOverrides?: Array<{ locationId?: string | null; priceMoney?: SquareMoney | null }> | null;
}

export interface SquareModifierData {
  name?: string | null;
  priceMoney?: SquareMoney | null;
  modifierListId?: string | null;
}

export interface SquareModifierListData {
  name?: string | null;
  selectionType?: string | null; // "SINGLE" | "MULTIPLE"
  modifiers?: SquareCatalogObject[] | null;
  minSelectedModifiers?: bigint | number | null;
  maxSelectedModifiers?: bigint | number | null;
}

export interface SquareItemModifierListInfo {
  modifierListId: string;
  enabled?: boolean | null;
  minSelectedModifiers?: number | null;
  maxSelectedModifiers?: number | null;
}

export interface SquareItemData {
  name?: string | null;
  description?: string | null;
  descriptionPlaintext?: string | null;
  categoryId?: string | null;
  categories?: Array<{ id?: string | null }> | null;
  reportingCategory?: { id?: string | null } | null;
  modifierListInfo?: SquareItemModifierListInfo[] | null;
  variations?: SquareCatalogObject[] | null;
  isArchived?: boolean | null;
}

export interface SquareCategoryData {
  name?: string | null;
}

// The wrapper object. Square sets the `<type>_data` field matching `type`; we
// only model the fields this transform reads.
export interface SquareCatalogObject {
  id?: string | null;
  type?: string | null;
  isDeleted?: boolean | null;
  presentAtAllLocations?: boolean | null;
  presentAtLocationIds?: string[] | null;
  absentAtLocationIds?: string[] | null;
  itemData?: SquareItemData | null;
  itemVariationData?: SquareItemVariationData | null;
  modifierListData?: SquareModifierListData | null;
  modifierData?: SquareModifierData | null;
  categoryData?: SquareCategoryData | null;
}

// Coerce a Square Money amount to integer cents via the shared bigint-safe seam.
function moneyToCents(money: SquareMoney | null | undefined): number {
  return squareMoneyToCents(money);
}

// bigint | number | null → number | null (for min/max selection counts).
function toNumber(value: bigint | number | null | undefined): number | null {
  if (typeof value === "bigint") {
    return Number(value);
  }
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

// Whether a catalog object is visible at the bound location. Absent wins; then an
// explicit not-at-all-locations narrows to the present list; otherwise visible.
// Exported so the recipe-mirror (square-recipe-mirror.ts) reuses the same
// location/category/price resolution instead of drifting its own copy.
export function isPresentAtLocation(obj: SquareCatalogObject, locationId: string): boolean {
  if ((obj.absentAtLocationIds ?? []).includes(locationId)) {
    return false;
  }
  if (obj.presentAtAllLocations === false) {
    return (obj.presentAtLocationIds ?? []).includes(locationId);
  }
  return true;
}

export function resolveCategoryName(item: SquareItemData, categoryNames: Map<string, string>): string {
  const refId =
    item.reportingCategory?.id ??
    item.categories?.find((category) => Boolean(category.id))?.id ??
    item.categoryId ??
    null;
  if (refId) {
    const name = categoryNames.get(refId);
    if (name) {
      return name;
    }
  }
  // Mirror normalize-menu.ts's fallback so an uncategorized item still renders.
  return "Menu";
}

// The variation price at the bound location: a location override (when it sets a
// price) wins over the base price.
export function variationPriceCents(
  data: SquareItemVariationData,
  locationId: string,
): number | null {
  const override = (data.locationOverrides ?? []).find((entry) => entry.locationId === locationId);
  if (override?.priceMoney) {
    return moneyToCents(override.priceMoney);
  }
  if (data.priceMoney) {
    return moneyToCents(data.priceMoney);
  }
  return null;
}

// Item price = the first FIXED-priced variation's (location-resolved) price.
// VARIABLE_PRICING variations are skipped (no amount); 0 if none price out.
function resolveItemPrice(item: SquareItemData, locationId: string): number {
  for (const variation of item.variations ?? []) {
    if (variation.type !== "ITEM_VARIATION" || variation.isDeleted) {
      continue;
    }
    const data = variation.itemVariationData;
    if (!data || data.pricingType === "VARIABLE_PRICING") {
      continue;
    }
    const cents = variationPriceCents(data, locationId);
    if (cents != null) {
      return Math.max(0, cents);
    }
  }
  return 0;
}

function buildModifierGroup(
  info: SquareItemModifierListInfo,
  listObj: SquareCatalogObject,
  locationId: string,
): OrderMenuModifierGroup | null {
  const list = listObj.modifierListData;
  if (!list) {
    return null;
  }
  const groupName = list.name ?? "";

  const modifiers: OrderMenuModifier[] = [];
  for (const mod of list.modifiers ?? []) {
    if (mod.type !== "MODIFIER" || mod.isDeleted || !mod.id) {
      continue;
    }
    if (!isPresentAtLocation(mod, locationId)) {
      continue;
    }
    const data = mod.modifierData;
    if (!data) {
      continue;
    }
    modifiers.push({
      id: mod.id,
      name: data.name ?? "",
      priceDeltaCents: moneyToCents(data.priceMoney),
      group: groupName,
    });
  }

  // min: per-item override, else list-level, else 0. Square uses -1/0 for "no
  // limit" on max → fall back to the SINGLE-selection radio (1) or the choice
  // count, since the contract requires maxSelections >= 1.
  const min = toNumber(info.minSelectedModifiers) ?? toNumber(list.minSelectedModifiers) ?? 0;
  let max = toNumber(info.maxSelectedModifiers) ?? toNumber(list.maxSelectedModifiers);
  if (max == null || max <= 0) {
    max = list.selectionType === "SINGLE" ? 1 : Math.max(1, modifiers.length);
  }

  return {
    id: info.modifierListId,
    name: groupName,
    minSelections: Math.max(0, min),
    maxSelections: Math.max(1, max),
    modifiers,
  };
}

function resolveModifierGroups(
  item: SquareItemData,
  modifierLists: Map<string, SquareCatalogObject>,
  locationId: string,
): OrderMenuModifierGroup[] {
  const groups: OrderMenuModifierGroup[] = [];
  for (const info of item.modifierListInfo ?? []) {
    if (info.enabled === false) {
      continue;
    }
    const listObj = modifierLists.get(info.modifierListId);
    if (!listObj || !isPresentAtLocation(listObj, locationId)) {
      continue;
    }
    const group = buildModifierGroup(info, listObj, locationId);
    if (group) {
      groups.push(group);
    }
  }
  return groups;
}

export function normalizeSquareCatalog(
  objects: SquareCatalogObject[],
  locationId: string,
): OrderMenuResponse {
  const categoryNames = new Map<string, string>();
  const modifierLists = new Map<string, SquareCatalogObject>();
  for (const obj of objects) {
    if (obj.isDeleted || !obj.id) {
      continue;
    }
    if (obj.type === "CATEGORY") {
      categoryNames.set(obj.id, obj.categoryData?.name ?? "");
    } else if (obj.type === "MODIFIER_LIST") {
      modifierLists.set(obj.id, obj);
    }
  }

  const items: OrderMenuItem[] = [];
  const categories: string[] = [];

  for (const obj of objects) {
    if (obj.type !== "ITEM" || !obj.id || obj.isDeleted) {
      continue;
    }
    const item = obj.itemData;
    if (!item || item.isArchived === true) {
      continue;
    }
    if (!isPresentAtLocation(obj, locationId)) {
      continue;
    }

    const categoryName = resolveCategoryName(item, categoryNames);
    if (!categories.includes(categoryName)) {
      categories.push(categoryName);
    }

    items.push({
      id: obj.id,
      name: item.name ?? "",
      description: item.description ?? item.descriptionPlaintext ?? null,
      priceCents: resolveItemPrice(item, locationId),
      category: categoryName,
      imageUrl: null,
      available: true,
      modifierGroups: resolveModifierGroups(item, modifierLists, locationId),
    });
  }

  return { categories, items };
}

export interface SquareCatalogCounts {
  itemCount: number;
  modifierCount: number;
  categoryCount: number;
}

/**
 * Counts surfaced after a catalog import ("imported N items, M modifiers").
 * itemCount / categoryCount come from the normalized menu (what's actually
 * visible at the bound location); modifierCount tallies the catalog's live
 * MODIFIER objects (the modifier library size), deduped by id since one modifier
 * list is shared across many items.
 */
export function summarizeSquareCatalog(
  objects: SquareCatalogObject[],
  locationId: string,
): { menu: OrderMenuResponse; counts: SquareCatalogCounts } {
  const menu = normalizeSquareCatalog(objects, locationId);

  const modifierIds = new Set<string>();
  for (const obj of objects) {
    if (obj.type !== "MODIFIER_LIST" || obj.isDeleted) {
      continue;
    }
    for (const mod of obj.modifierListData?.modifiers ?? []) {
      if (mod.type === "MODIFIER" && !mod.isDeleted && mod.id && isPresentAtLocation(mod, locationId)) {
        modifierIds.add(mod.id);
      }
    }
  }

  return {
    menu,
    counts: {
      itemCount: menu.items.length,
      modifierCount: modifierIds.size,
      categoryCount: menu.categories.length,
    },
  };
}
