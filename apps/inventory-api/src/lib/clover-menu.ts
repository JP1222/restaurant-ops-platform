import type { CloverMenuItem } from "./inventory-store.js";

// Minimal read-only Clover catalog fetch for the recipe-mirror importer
// (ADR-0028). inventory-api has no Clover client of its own, and lifting
// analytics-api's would cross an app boundary (Iron Law 1) — so this is a small,
// dependency-free GET against the same `items?expand=categories` endpoint
// analytics + kds use. One-shot use (a single ~50-item store), so no rate
// limiter; offset pagination is here only for safety.

// The slice of a Clover catalog item we need to mirror as a recipe. Prices are
// integer cents on the wire (Clover convention).
export interface CloverCatalogItem {
  id: string;
  name: string;
  priceCents: number;
  priceType: string; // "FIXED" | "VARIABLE" | "PER_UNIT" — fees/gift cards are VARIABLE
  hidden: boolean;
  available: boolean;
  categoryNames: string[];
}

export interface FetchCatalogOptions {
  baseUrl: string;
  merchantId: string;
  token: string;
  // Injectable for tests; defaults to global fetch in the script runner.
  fetchImpl?: typeof fetch;
}

// Normalize one raw Clover item (defensive about missing/odd fields — this is
// untrusted external JSON).
export function parseCatalogItem(raw: unknown): CloverCatalogItem {
  const r = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  return {
    id: typeof r.id === "string" ? r.id : "",
    name: typeof r.name === "string" ? r.name : "",
    priceCents: typeof r.price === "number" && Number.isFinite(r.price) ? r.price : 0,
    priceType: typeof r.priceType === "string" ? r.priceType : "FIXED",
    hidden: r.hidden === true,
    available: r.available !== false,
    categoryNames: readCategoryNames(r.categories)
  };
}

function readCategoryNames(categories: unknown): string[] {
  if (typeof categories !== "object" || categories === null) {
    return [];
  }
  const elements = (categories as { elements?: unknown }).elements;
  if (!Array.isArray(elements)) {
    return [];
  }
  const names: string[] = [];
  for (const el of elements) {
    if (typeof el === "object" && el !== null) {
      const name = (el as { name?: unknown }).name;
      if (typeof name === "string" && name.trim() !== "") {
        names.push(name);
      }
    }
  }
  return names;
}

// Fetch the full Clover catalog (items + their categories), paginated.
export async function fetchCloverCatalog(opts: FetchCatalogOptions): Promise<CloverCatalogItem[]> {
  const doFetch = opts.fetchImpl ?? fetch;
  const items: CloverCatalogItem[] = [];
  const limit = 1000;
  let offset = 0;
  for (;;) {
    const url = `${opts.baseUrl}/v3/merchants/${opts.merchantId}/items?expand=categories&limit=${limit}&offset=${offset}`;
    const response = await doFetch(url, {
      headers: { authorization: `Bearer ${opts.token}`, accept: "application/json" }
    });
    if (!response.ok) {
      throw new Error(`Clover items request failed with ${response.status}.`);
    }
    const body = (await response.json()) as { elements?: unknown };
    const elements = Array.isArray(body.elements) ? body.elements : [];
    for (const el of elements) {
      items.push(parseCatalogItem(el));
    }
    if (elements.length < limit) {
      return items;
    }
    offset += limit;
  }
}

// ---------------------------------------------------------------------------
// Which Clover catalog items become inventory recipes?
//
// The catalog is a SUPERSET of the sellable menu — it also holds hidden fees,
// gift cards, $0 modifier placeholders (Whipped Cream), and junk/test rows
// (TEST_ITEM, LIGHT BULB, REGULAR). Mirroring those would litter the recipe
// list and the sales-depletion matcher. This predicate is the gate.
//
// Default policy (this is the one real judgment call — tune it to the catalog):
//   • keep only items in a known menu category (drops all the uncategorized
//     junk: energy drinks, gift card, fees, light bulb…)
//   • drop hidden, non-FIXED-price, and $0 items (fees / gift cards / modifiers)
//   • drop a small exact-name denylist for junk that sits INSIDE a kept
//     category (TEST_ITEM lives in COLD DRINKS, so the allowlist alone misses it)
// ---------------------------------------------------------------------------

// Clover categories that ARE the sellable menu (verified against the live
// catalog 2026-06-16). Uncategorized items fall outside this set and are dropped.
const MENU_CATEGORIES: ReadonlySet<string> = new Set([
  "ROLLED ICE CREAM",
  "SPECIALS",
  "BUBBLE TEA",
  "SMOOTHIE",
  "COLD DRINKS",
  "HOT DRINKS"
  // "EXTRA TOPPING"  // ← judgment call: are these standalone recipes, or add-ons
  //                     handled via the modifier-depletion path? Uncomment to mirror them.
]);

// Exact-name junk living inside a kept category (the allowlist wouldn't catch it).
const JUNK_NAMES: ReadonlySet<string> = new Set(["TEST_ITEM"]);

export function shouldMirrorAsRecipe(item: CloverCatalogItem): boolean {
  if (item.id === "" || item.name === "") {
    return false; // structurally invalid
  }
  if (item.hidden) {
    return false; // hidden in the POS (e.g. Delivery Fee)
  }
  if (item.priceType !== "FIXED") {
    return false; // variable price = fee / gift card, not a plated item
  }
  if (item.priceCents <= 0) {
    return false; // $0 = modifier / placeholder (Whipped Cream, dup Cup of Water)
  }
  if (JUNK_NAMES.has(item.name)) {
    return false; // explicit in-category junk
  }
  return item.categoryNames.some((name) => MENU_CATEGORIES.has(name));
}

// Map a kept catalog item to the recipe-sync DTO. First category wins (every
// live item has exactly one); falls back to "Uncategorized" defensively.
export function toCloverMenuItem(item: CloverCatalogItem): CloverMenuItem {
  return {
    cloverItemId: item.id,
    name: item.name,
    category: item.categoryNames[0] ?? "Uncategorized",
    priceCents: item.priceCents
  };
}

// Filter the catalog down to the menu and map to recipe DTOs. Pure — the script
// runner does the fetch + the DB write around this.
export function selectRecipes(items: CloverCatalogItem[]): CloverMenuItem[] {
  return items.filter(shouldMirrorAsRecipe).map(toCloverMenuItem);
}
