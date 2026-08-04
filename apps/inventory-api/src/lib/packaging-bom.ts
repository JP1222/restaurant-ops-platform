import type { PrismaClient } from "@rop/db-inventory";

import { setRecipeBom, type CloverMenuItem, type RecipeBomLine } from "./inventory-store.js";

// Packaging-BOM bootstrap (ADR-0028, docs/inventory-bom-bootstrap-handoff.md).
// Writes the reliable "1:1 per sold unit" packaging slice of each recipe's BOM so
// sales-driven depletion moves real stock. Ingredient BOMs (free-poured) come later.
//
// Item mapping decided with the owner against the LIVE catalog (2026-06-16):
//   rolled ice cream  -> NEW "12oz Paper Cup" + EXISTING per-piece "Spoon"
//   bubble tea / smoothie -> NEW "Plastic Cup" + "Straw" + "Cup Lid" (shared cup + lid)
//   the old miscategorized "12oz Cups" item is retired (soft-delete) for the clean one.
// These prod item ids are instance data for this single merchant — kept here (with the
// rest of the mapping) so the importer is self-contained; revisit if the catalog changes.

export const PACKAGING_CATEGORY_ID = "packaging"; // existing "Cups & Packaging"

// Existing per-piece spoon the shop already receives against (reused, not recreated).
export const SPOON_ITEM_ID = "item-3a3b2d69-0e43-4a66-bf61-24c2ede01f1b";

// Old cup item to retire (soft-delete) — superseded by ing-12oz-paper-cup.
export const ARCHIVE_ITEM_IDS: readonly string[] = ["item-5fa8f75b-62d2-4be1-b83d-4483b7eaaa6b"];

export interface PackagingItem {
  id: string;
  name: string;
  unit: string;
}

// New packaging items to create under PACKAGING_CATEGORY_ID (Spoon is reused, not here).
export const PACKAGING_ITEMS_TO_CREATE: readonly PackagingItem[] = [
  { id: "ing-12oz-paper-cup", name: "12oz Paper Cup", unit: "each" },
  { id: "ing-plastic-cup", name: "Plastic Cup", unit: "each" },
  { id: "ing-straw", name: "Straw", unit: "each" },
  { id: "ing-cup-lid", name: "Cup Lid", unit: "each" }
];

export type PackagingType = "rolled-icecream" | "bubble-tea" | "smoothie" | "iced-tea" | "iced-plain";

const CUP_STRAW_LID: readonly RecipeBomLine[] = [
  { sku: "ing-plastic-cup", qty: 1 },
  { sku: "ing-straw", qty: 1 },
  { sku: "ing-cup-lid", qty: 1 }
];

export const PACKAGING_BY_TYPE: Readonly<Record<PackagingType, readonly RecipeBomLine[]>> = {
  "rolled-icecream": [
    { sku: "ing-12oz-paper-cup", qty: 1 },
    { sku: SPOON_ITEM_ID, qty: 1 }
  ],
  "bubble-tea": CUP_STRAW_LID,
  smoothie: CUP_STRAW_LID,
  // Iced teas (Ice Thai Tea, Ice Chocolate, Iced Tea): same cold cup + straw + lid.
  "iced-tea": CUP_STRAW_LID,
  // Cup of Ice / Cup of Water: cold cup + lid, no straw.
  "iced-plain": [
    { sku: "ing-plastic-cup", qty: 1 },
    { sku: "ing-cup-lid", qty: 1 }
  ]
};

// Every sku the packaging importer manages — the replace-set for the additive merge.
export const PACKAGING_SKUS: ReadonlySet<string> = new Set([
  SPOON_ITEM_ID,
  ...PACKAGING_ITEMS_TO_CREATE.map((i) => i.id)
]);

// Clover category -> packaging type. Cold/hot drinks are deliberately absent (their
// packaging rule isn't defined yet) so they fall through to `skipped`.
const CATEGORY_TO_TYPE: Readonly<Record<string, PackagingType>> = {
  "ROLLED ICE CREAM": "rolled-icecream",
  SPECIALS: "rolled-icecream",
  "BUBBLE TEA": "bubble-tea",
  SMOOTHIE: "smoothie"
};

export function categoryToPackagingType(category: string): PackagingType | null {
  return CATEGORY_TO_TYPE[category] ?? null;
}

// Per-item overrides for the COLD DRINKS bucket, where one Clover category holds
// mixed packaging (owner decisions 2026-06-16): some iced drinks get a cup, the
// bottled ones (Bottle Water/Drink, Starbucks Frappuccino) and Coffee get none.
// Keyed by exact Clover item name; consulted only when the category map is empty.
const COLD_DRINK_ITEM_TYPES: Readonly<Record<string, PackagingType>> = {
  "Ice Thai Tea": "iced-tea",
  "Ice Chocolate": "iced-tea",
  "Iced Tea": "iced-tea",
  "Cup of Ice": "iced-plain",
  "Cup of Water": "iced-plain"
};

// Resolve a recipe to its packaging type: the dessert/tea category map first,
// then the per-item cold-drink override. null = no packaging (bottled / skipped).
export function classifyPackaging(recipe: CloverMenuItem): PackagingType | null {
  return categoryToPackagingType(recipe.category) ?? COLD_DRINK_ITEM_TYPES[recipe.name] ?? null;
}

// Additive merge: keep existing NON-packaging lines, replace only the packaging ones.
// Idempotent, and safe to re-run after ingredient BOMs exist — it never wipes them
// (the gotcha called out in the handoff: setRecipeBom is a full-set replace).
export function mergeBomLines(
  existing: readonly RecipeBomLine[],
  packaging: readonly RecipeBomLine[],
  replaceSkus: ReadonlySet<string> = PACKAGING_SKUS
): RecipeBomLine[] {
  return [...existing.filter((l) => !replaceSkus.has(l.sku)), ...packaging];
}

export interface PackagingPlanEntry {
  recipeId: string;
  name: string;
  type: PackagingType;
  lines: RecipeBomLine[];
}

export interface PackagingPlan {
  matched: PackagingPlanEntry[];
  skipped: Array<{ name: string; category: string }>;
}

// Pure: classify the mirrored recipes into packaging types + lines.
export function planPackaging(recipes: readonly CloverMenuItem[]): PackagingPlan {
  const matched: PackagingPlanEntry[] = [];
  const skipped: Array<{ name: string; category: string }> = [];
  for (const r of recipes) {
    const type = classifyPackaging(r);
    if (!type) {
      skipped.push({ name: r.name, category: r.category });
      continue;
    }
    matched.push({ recipeId: r.cloverItemId, name: r.name, type, lines: [...PACKAGING_BY_TYPE[type]] });
  }
  return { matched, skipped };
}

export interface ApplyPackagingResult {
  itemsCreated: number;
  itemsArchived: number;
  recipesUpdated: number;
  recipesMissing: string[];
}

// DB apply for local / test / integration / a future deployed run. The prod
// no-deploy one-off uses an inline container runner that mirrors this exactly
// (this code isn't in the deployed image yet) — keep the two in sync.
export async function applyPackagingBom(prisma: PrismaClient, plan: PackagingPlan): Promise<ApplyPackagingResult> {
  // 1. ensure the packaging category exists (no-op in prod where it already does)
  await prisma.inventoryCategory.upsert({
    where: { id: PACKAGING_CATEGORY_ID },
    create: { id: PACKAGING_CATEGORY_ID, name: "Cups & Packaging", color: "slate" },
    update: {}
  });

  // 2. create the new packaging items (idempotent)
  let itemsCreated = 0;
  for (const item of PACKAGING_ITEMS_TO_CREATE) {
    const existing = await prisma.inventoryItem.findUnique({ where: { id: item.id }, select: { id: true } });
    await prisma.inventoryItem.upsert({
      where: { id: item.id },
      create: {
        id: item.id,
        sku: item.id.toUpperCase(),
        name: item.name,
        categoryId: PACKAGING_CATEGORY_ID,
        unit: item.unit,
        onHand: 0,
        parMin: 0,
        parMax: 0,
        costCents: 0,
        vendor: "",
        shelfDays: 365,
        lastCounted: ""
      },
      update: { name: item.name, unit: item.unit, categoryId: PACKAGING_CATEGORY_ID }
    });
    if (!existing) {
      itemsCreated += 1;
    }
  }

  // 3. retire superseded items via soft-delete — never hard-delete (orphans history)
  let itemsArchived = 0;
  for (const id of ARCHIVE_ITEM_IDS) {
    const row = await prisma.inventoryItem.findUnique({ where: { id }, select: { archivedAt: true } });
    if (row && row.archivedAt === null) {
      await prisma.inventoryItem.update({ where: { id }, data: { archivedAt: new Date() } });
      itemsArchived += 1;
    }
  }

  // 4. write each recipe's packaging BOM via the additive merge
  let recipesUpdated = 0;
  const recipesMissing: string[] = [];
  for (const entry of plan.matched) {
    const existing = await prisma.inventoryRecipeLine.findMany({
      where: { recipeId: entry.recipeId },
      select: { sku: true, qty: true }
    });
    const merged = mergeBomLines(existing, entry.lines);
    const n = await setRecipeBom(prisma, entry.recipeId, merged);
    if (n === null) {
      recipesMissing.push(entry.recipeId);
    } else {
      recipesUpdated += 1;
    }
  }

  return { itemsCreated, itemsArchived, recipesUpdated, recipesMissing };
}
