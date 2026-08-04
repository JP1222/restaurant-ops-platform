import type { InventoryCategoryId, InventoryUnitKind } from "@rop/contracts";

// Open Food Facts barcode lookup for scan-to-register auto-fill (barcode-onboarding ADR, D3).
// Calls the free OFF public API (no key, no cost) — the owner approved this egress (2026-06-20) in
// favor of self-hosting a multi-GB SQLite copy, a scanned UPC being a public product barcode, not
// sensitive data. No host dataset to build or maintain.
//
// Everything FAILS OPEN: a network error, a timeout, a non-200, or an unknown code all resolve to
// null, so a lookup miss is data — never an error that blocks the scan-to-register flow. Store
// brands (Member's Mark / Great Value) and non-food (cups/straws) legitimately miss OFF; the
// manager fills the form once and the barcode binds to the item from then on.

export interface OffHit {
  product_name: string;
  brands: string | null;
  quantity: string | null;
  categories_en: string | null;
}

// OFF asks API clients to identify themselves; an app-specific UA keeps us off their default-agent
// rate limits. The timeout is short on purpose — a slow OFF must never stall the scan flow (it just
// fails open to a blank review form).
const OFF_USER_AGENT = "Example KitchenRollo-Inventory/1.0 (+https://example.com)";
const OFF_TIMEOUT_MS = 4_000;

interface OffApiProduct {
  product_name?: unknown;
  brands?: unknown;
  quantity?: unknown;
  categories?: unknown;
  categories_tags?: unknown;
}
interface OffApiResponse {
  status?: unknown;
  product?: OffApiProduct;
}

function asStringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

// Look up a scanned UPC/GTIN via the OFF public API (v2 product endpoint). null on any miss/failure
// (fail open). `baseUrl` comes from config (defaulted to world.openfoodfacts.org).
export async function lookupOff(code: string, baseUrl: string): Promise<OffHit | null> {
  const trimmed = code.trim();
  if (!trimmed) {
    return null;
  }
  try {
    const url = new URL(`/api/v2/product/${encodeURIComponent(trimmed)}.json`, baseUrl);
    url.searchParams.set("fields", "product_name,brands,quantity,categories,categories_tags");
    const res = await fetch(url, {
      headers: { "User-Agent": OFF_USER_AGENT, Accept: "application/json" },
      signal: AbortSignal.timeout(OFF_TIMEOUT_MS)
    });
    if (!res.ok) {
      return null;
    }
    const body = (await res.json()) as OffApiResponse;
    // status 1 = found, 0 = unknown code.
    if (body.status !== 1 || !body.product) {
      return null;
    }
    const product = body.product;
    const name = asStringOrNull(product.product_name);
    if (!name) {
      return null; // a hit with no usable name is no better than a miss
    }
    // Prefer the language-prefixed tag list ("en:dairies,en:milks") — stable + English — and fall
    // back to the human `categories` string. categoryFromOff() substring-matches either shape.
    const categoriesEn = Array.isArray(product.categories_tags)
      ? product.categories_tags.filter((tag): tag is string => typeof tag === "string").join(",") ||
        null
      : asStringOrNull(product.categories);
    return {
      product_name: name,
      brands: asStringOrNull(product.brands),
      quantity: asStringOrNull(product.quantity),
      categories_en: categoriesEn
    };
  } catch {
    return null;
  }
}

// Map an OFF `categories_en` tag list onto one of our fixed InventoryCategoryId values (or null to
// leave the manager's default). First substring match wins; OFF is food-skewed, so non-food
// (cups/straws/supplies) simply returns null. ORDER MATTERS: confection/candy rules sit BEFORE
// the dairy "cream" rule so a sweet whose taxonomy also contains "cream" (e.g. a cream-filled
// candy) lands on `topping`, not `dairy` — the bug a gummy product hit. "chocolate" sits AFTER
// milk/cream so "chocolate milk" stays dairy while a plain chocolate bar is a topping. Sibling of
// contracts' categoryFromText (which maps a product NAME, a different input shape).
const CATEGORY_RULES: { match: string; id: InventoryCategoryId }[] = [
  { match: "gummi", id: "topping" },
  { match: "gummy", id: "topping" },
  { match: "candie", id: "topping" },
  { match: "candy", id: "topping" },
  { match: "confection", id: "topping" },
  { match: "marshmallow", id: "topping" },
  { match: "sprinkle", id: "topping" },
  { match: "milk", id: "dairy" },
  { match: "dairie", id: "dairy" },
  { match: "cream", id: "dairy" },
  { match: "chocolate", id: "topping" },
  { match: "syrup", id: "sweetener" },
  { match: "sugar", id: "sweetener" },
  { match: "sweetener", id: "sweetener" },
  { match: "honey", id: "sweetener" },
  { match: "fruit", id: "fruit" },
  { match: "sauce", id: "topping" },
  { match: "topping", id: "topping" },
  { match: "powder", id: "powder" },
  { match: "tea", id: "powder" },
  { match: "packaging", id: "packaging" },
  { match: "beverage", id: "food" },
  { match: "drink", id: "food" },
  { match: "snack", id: "food" }
];

export function categoryFromOff(categoriesEn: string | null): InventoryCategoryId | null {
  if (!categoriesEn) {
    return null;
  }
  const lower = categoriesEn.toLowerCase();
  for (const rule of CATEGORY_RULES) {
    if (lower.includes(rule.match)) {
      return rule.id;
    }
  }
  return null;
}

// Parse an OFF `quantity` ("12 oz", "500 ml", "24 ct") into our base unit + unit kind. null when no
// recognizable unit token is present. Order matters: "fl oz" before "oz", "ml" before "l".
const UNIT_RULES: { match: RegExp; unit: string; kind: InventoryUnitKind }[] = [
  { match: /fl\.?\s?oz|fluid ounce/, unit: "fl oz", kind: "volume" },
  { match: /\boz\b|ounce/, unit: "oz", kind: "weight" },
  { match: /\blbs?\b|pound/, unit: "lb", kind: "weight" },
  { match: /\bkg\b|kilogram/, unit: "kg", kind: "weight" },
  { match: /\bg\b|gram/, unit: "g", kind: "weight" },
  { match: /\bml\b|milliliter/, unit: "ml", kind: "volume" },
  { match: /\bl\b|liter|litre/, unit: "L", kind: "volume" },
  { match: /\bct\b|\bcount\b|\bpcs?\b|\bpieces?\b|\beach\b/, unit: "each", kind: "count" }
];

export function unitFromQuantity(quantity: string | null): { unit: string; unit_kind: InventoryUnitKind } | null {
  if (!quantity) {
    return null;
  }
  const lower = quantity.toLowerCase();
  for (const rule of UNIT_RULES) {
    if (rule.match.test(lower)) {
      return { unit: rule.unit, unit_kind: rule.kind };
    }
  }
  return null;
}
