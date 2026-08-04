import type { PrismaClient } from "@rop/db-inventory";

import {
  setRecipeBom,
  syncRecipesFromClover,
  type CloverMenuItem,
  type RecipeBomLine
} from "./inventory-store.js";

// Importer for the owner-filled BOM template (the CSV generated from the live
// Clover menu — ADR-0028). It establishes the catalog STRUCTURE so depletion can
// run: ingredient/packaging items (stock + cost default to 0; the owner sets
// real on-hand via a count and costs via the editor), the menu items as recipes
// carrying their clover_item_id, and each recipe's BOM. Modifier-level
// consumption is a later slice.

// --- CSV parsing (RFC-4180-ish: quoted fields, embedded commas/quotes) ---
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charAt(i);
    if (inQuotes) {
      if (c === '"') {
        if (text.charAt(i + 1) === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text.charAt(i + 1) === "\n") {
        i++;
      }
      row.push(field);
      field = "";
      rows.push(row);
      row = [];
    } else {
      field += c;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((cell) => cell.trim() !== ""));
}

// --- template → import plan ---
// [csv column prefix, ingredient display name] — packaging counts.
const PACKAGING_COLUMNS: ReadonlyArray<readonly [string, string]> = [
  ["cup_qty", "Cup"],
  ["lid_qty", "Lid"],
  ["spoon_qty", "Spoon"],
  ["straw_qty", "Straw"],
  ["napkin_qty", "Napkin"]
];

const CAT_PACKAGING = { id: "cat-packaging", name: "Packaging", color: "slate" };
const CAT_INGREDIENT = { id: "cat-ingredient", name: "Ingredients", color: "wheat" };

function slug(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

interface IngredientDraft {
  id: string;
  name: string;
  unit: string;
  categoryId: string;
}

export interface BomPlan {
  categories: Array<{ id: string; name: string; color: string }>;
  ingredients: IngredientDraft[];
  recipes: CloverMenuItem[];
  boms: Array<{ recipeId: string; lines: RecipeBomLine[] }>;
}

// Parse "name:qty[unit]; name:qty[unit]" → [{ name, qty, unit }]. Tolerant:
// skips segments without a parseable `name:qty`.
function parseIngredientList(raw: string): Array<{ name: string; qty: number; unit: string }> {
  const out: Array<{ name: string; qty: number; unit: string }> = [];
  for (const part of raw.split(";")) {
    const seg = part.trim();
    if (!seg) {
      continue;
    }
    const colon = seg.lastIndexOf(":");
    if (colon < 0) {
      continue;
    }
    const name = seg.slice(0, colon).trim();
    const m = seg
      .slice(colon + 1)
      .trim()
      .match(/^([0-9]*\.?[0-9]+)\s*([a-zA-Z]*)$/);
    if (!name || !m) {
      continue;
    }
    out.push({ name, qty: parseFloat(m[1] ?? "0"), unit: m[2] || "ea" });
  }
  return out;
}

export function buildBomPlan(rows: string[][]): BomPlan {
  if (rows.length === 0) {
    return { categories: [], ingredients: [], recipes: [], boms: [] };
  }
  const header = rows[0]!.map((h) => h.trim().toLowerCase());
  const col = (prefix: string) => header.findIndex((h) => h.startsWith(prefix.toLowerCase()));
  const idx = {
    include: col("include"),
    cloverItemId: col("clover_item_id"),
    name: col("menu_item"),
    category: col("category"),
    price: col("price"),
    main: col("main"),
    other: col("other_ingredients")
  };
  const pkgIdx = PACKAGING_COLUMNS.map(([c]) => col(c));

  const ingredients = new Map<string, IngredientDraft>();
  const recipes: CloverMenuItem[] = [];
  const boms: Array<{ recipeId: string; lines: RecipeBomLine[] }> = [];

  const addIngredient = (name: string, unit: string, packaging: boolean): string => {
    const id = `ing-${slug(name)}`;
    if (!ingredients.has(id)) {
      ingredients.set(id, {
        id,
        name,
        unit,
        categoryId: packaging ? CAT_PACKAGING.id : CAT_INGREDIENT.id
      });
    }
    return id;
  };

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r]!;
    const cell = (i: number): string => (i >= 0 && i < row.length ? row[i]!.trim() : "");
    if (cell(idx.include).toUpperCase() !== "Y") {
      continue;
    }
    const cloverItemId = cell(idx.cloverItemId);
    const name = cell(idx.name);
    if (!cloverItemId || !name) {
      continue;
    }
    const priceCents = Math.round((parseFloat(cell(idx.price)) || 0) * 100);
    recipes.push({ cloverItemId, name, category: cell(idx.category) || "Uncategorized", priceCents });

    const lines: RecipeBomLine[] = [];
    PACKAGING_COLUMNS.forEach(([, ingName], k) => {
      const qty = parseFloat(cell(pkgIdx[k]!));
      if (qty > 0) {
        lines.push({ sku: addIngredient(ingName, "ea", true), qty });
      }
    });
    for (const i of [idx.main, idx.other]) {
      if (i < 0) {
        continue;
      }
      for (const ing of parseIngredientList(cell(i))) {
        lines.push({ sku: addIngredient(ing.name, ing.unit, false), qty: ing.qty });
      }
    }
    boms.push({ recipeId: cloverItemId, lines });
  }

  return {
    categories: [CAT_PACKAGING, CAT_INGREDIENT],
    ingredients: [...ingredients.values()],
    recipes,
    boms
  };
}

export interface ImportResult {
  categories: number;
  ingredientsCreated: number;
  ingredientsUpdated: number;
  recipes: { created: number; updated: number };
  bomsSet: number;
  bomsSkipped: number;
}

// Apply a BomPlan to the inventory DB. Idempotent: re-running upserts catalog +
// recipes and replaces BOMs. Ingredient on-hand/cost default to 0 (owner refines
// via count + editor); this establishes structure so depletion runs.
export async function importBom(prisma: PrismaClient, plan: BomPlan): Promise<ImportResult> {
  for (const c of plan.categories) {
    await prisma.inventoryCategory.upsert({
      where: { id: c.id },
      create: { id: c.id, name: c.name, color: c.color },
      update: { name: c.name, color: c.color }
    });
  }

  let ingredientsCreated = 0;
  let ingredientsUpdated = 0;
  for (const ing of plan.ingredients) {
    const existing = await prisma.inventoryItem.findUnique({
      where: { id: ing.id },
      select: { id: true }
    });
    await prisma.inventoryItem.upsert({
      where: { id: ing.id },
      create: {
        id: ing.id,
        sku: ing.id.toUpperCase(),
        name: ing.name,
        categoryId: ing.categoryId,
        unit: ing.unit,
        onHand: 0,
        parMin: 0,
        parMax: 0,
        costCents: 0,
        vendor: "",
        shelfDays: 365,
        lastCounted: ""
      },
      update: { name: ing.name, unit: ing.unit, categoryId: ing.categoryId }
    });
    if (existing) {
      ingredientsUpdated++;
    } else {
      ingredientsCreated++;
    }
  }

  const recipes = await syncRecipesFromClover(prisma, plan.recipes);

  let bomsSet = 0;
  let bomsSkipped = 0;
  for (const b of plan.boms) {
    const n = await setRecipeBom(prisma, b.recipeId, b.lines);
    if (n === null) {
      bomsSkipped++;
    } else {
      bomsSet++;
    }
  }

  return {
    categories: plan.categories.length,
    ingredientsCreated,
    ingredientsUpdated,
    recipes,
    bomsSet,
    bomsSkipped
  };
}
