import type {
  OrderMenuItem,
  OrderMenuModifier,
  OrderMenuModifierGroup,
  OrderMenuResponse,
} from "@rop/contracts";

/**
 * Normalize a Clover inventory snapshot (items + modifier groups) into the
 * POS-neutral OrderMenuResponse the customer ordering surface consumes.
 *
 * Defensive on purpose (mirrors normalize-order.ts): Clover sub-collections
 * arrive either as a bare array or as `{ elements: [...] }`, fields can be
 * absent, and prices are integer cents. We read the merchant's REAL Clover
 * catalog (the "menu = Clover inventory" decision, ADR-0027), so we tolerate
 * shape drift rather than trust a fixed schema.
 */

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

// Clover returns a sub-collection as a bare array OR as `{ elements: [...] }`.
function toElements(value: unknown): JsonRecord[] {
  if (Array.isArray(value)) {
    return value.map(asRecord).filter((entry): entry is JsonRecord => entry !== null);
  }
  const record = asRecord(value);
  if (record && Array.isArray(record.elements)) {
    return record.elements.map(asRecord).filter((entry): entry is JsonRecord => entry !== null);
  }
  return [];
}

function buildModifierGroupMap(
  rawModifierGroups: JsonRecord,
): Map<string, OrderMenuModifierGroup> {
  const map = new Map<string, OrderMenuModifierGroup>();

  for (const group of toElements(rawModifierGroups)) {
    const id = asString(group.id);
    if (!id) {
      continue;
    }
    const groupName = asString(group.name) ?? "";

    const modifiers: OrderMenuModifier[] = [];
    for (const mod of toElements(group.modifiers)) {
      const modId = asString(mod.id);
      if (!modId || asBoolean(mod.available) === false) {
        continue;
      }
      modifiers.push({
        id: modId,
        name: asString(mod.name) ?? "",
        priceDeltaCents: asNumber(mod.price) ?? 0,
        group: groupName,
      });
    }

    const maxAllowed = asNumber(group.maxAllowed) ?? 0;
    map.set(id, {
      id,
      name: groupName,
      minSelections: Math.max(0, asNumber(group.minRequired) ?? 0),
      // Clover uses 0 (or absent) for "no upper bound"; the contract requires at
      // least 1, so fall back to the number of available choices.
      maxSelections: maxAllowed > 0 ? maxAllowed : Math.max(1, modifiers.length),
      modifiers,
    });
  }

  return map;
}

export function normalizeMenu(
  rawItems: JsonRecord,
  rawModifierGroups: JsonRecord,
): OrderMenuResponse {
  const groupMap = buildModifierGroupMap(rawModifierGroups);
  const items: OrderMenuItem[] = [];
  const categories: string[] = [];

  for (const item of toElements(rawItems)) {
    const id = asString(item.id);
    if (!id) {
      continue;
    }
    // Hidden on Register, or unavailable across channels → off the online menu.
    if (asBoolean(item.hidden) === true || asBoolean(item.available) === false) {
      continue;
    }

    const categoryName =
      toElements(item.categories)
        .map((category) => asString(category.name))
        .find((name): name is string => name !== null) ?? "Menu";
    if (!categories.includes(categoryName)) {
      categories.push(categoryName);
    }

    const modifierGroups: OrderMenuModifierGroup[] = [];
    for (const ref of toElements(item.modifierGroups)) {
      const group = groupMap.get(asString(ref.id) ?? "");
      if (group) {
        modifierGroups.push(group);
      }
    }

    items.push({
      id,
      name: asString(item.name) ?? "",
      description: null,
      priceCents: asNumber(item.price) ?? 0,
      category: categoryName,
      imageUrl: null,
      available: true,
      modifierGroups,
    });
  }

  return { categories, items };
}
