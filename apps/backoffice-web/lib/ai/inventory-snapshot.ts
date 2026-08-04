import {
  defaultInventoryCategories,
  type InventoryDataset,
  type InventoryItem,
  type InventoryItemStatus,
} from "@rop/contracts";
import { vendorPricesForItem } from "@rop/contracts/match";

import { statusOf } from "@/lib/inventory/helpers";

/**
 * Compact, token-frugal projections of the inventory dataset for the AI
 * assistant's read-only inventory tools. Status is derived with the SAME
 * `statusOf` the UI uses, so "what's low" in chat matches what the operator
 * sees on the Inventory page. Pure + `now`-injected so the suite is deterministic.
 */

// The snapshot only needs the catalog slice of the dataset, not recipes/POs/etc.
type InventorySource = Pick<InventoryDataset, "items" | "categories">;

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export interface AiInventoryItemView {
  name: string;
  sku: string;
  category: string;
  on_hand: number;
  unit: string;
  par_min: number;
  par_max: number;
  status: InventoryItemStatus;
  vendor: string | null;
  suggested_reorder?: number;
}

function categoryName(id: string, dataset: InventorySource): string {
  const fromDataset = dataset.categories.find((category) => category.id === id);
  if (fromDataset) return fromDataset.name;
  const fallback = defaultInventoryCategories.find((category) => category.id === id);
  return fallback?.name ?? id;
}

function projectItem(item: InventoryItem, dataset: InventorySource): AiInventoryItemView {
  const status = statusOf(item);
  const view: AiInventoryItemView = {
    name: item.name,
    sku: item.sku,
    category: categoryName(item.category, dataset),
    on_hand: round2(item.on_hand),
    unit: item.unit,
    par_min: round2(item.par_min),
    par_max: round2(item.par_max),
    status,
    vendor: item.vendor.trim().length > 0 ? item.vendor : null,
  };
  // Reorder hint only for genuinely-short stock — an 86'd item may be flagged off
  // for a reason other than quantity, so a "buy N to hit par" number would mislead.
  if (status === "low" || status === "critical") {
    const reorder = Math.ceil(item.par_max - item.on_hand);
    if (reorder > 0) view.suggested_reorder = reorder;
  }
  return view;
}

const AT_RISK_STATUSES: readonly InventoryItemStatus[] = ["critical", "low", "86"];
const AT_RISK_CAP = 40;
const SEARCH_CAP = 25;

function severityRank(status: InventoryItemStatus): number {
  switch (status) {
    case "critical":
      return 3;
    case "86":
      return 2;
    case "low":
      return 1;
    default:
      return 0;
  }
}

// How deep into par an item is, normalized so items with different par levels
// sort comparably (lower = more urgent). Guard par_min=0 so it can't divide-by-0.
function depletion(item: InventoryItem): number {
  return item.on_hand / Math.max(item.par_min, 1);
}

const EMPTY_STATUS_COUNTS = (): Record<InventoryItemStatus, number> => ({
  ok: 0,
  low: 0,
  critical: 0,
  over: 0,
  "86": 0,
});

export interface AiInventoryOverview {
  generated_at: string;
  total_active_items: number;
  status_counts: Record<InventoryItemStatus, number>;
  at_risk: AiInventoryItemView[];
  at_risk_truncated: boolean;
  by_category: Array<{ category: string; items: number; needs_attention: number }>;
}

export function buildInventoryOverview(
  dataset: InventorySource,
  now: string,
): AiInventoryOverview {
  const items = dataset.items.filter((item) => !item.archived);

  const status_counts = EMPTY_STATUS_COUNTS();
  const categoryRollup = new Map<string, { items: number; needs_attention: number }>();
  const atRisk: InventoryItem[] = [];

  for (const item of items) {
    const status = statusOf(item);
    status_counts[status] += 1;

    const catName = categoryName(item.category, dataset);
    const entry = categoryRollup.get(catName) ?? { items: 0, needs_attention: 0 };
    entry.items += 1;
    if (AT_RISK_STATUSES.includes(status)) {
      entry.needs_attention += 1;
      atRisk.push(item);
    }
    categoryRollup.set(catName, entry);
  }

  atRisk.sort((a, b) => {
    const bySeverity = severityRank(statusOf(b)) - severityRank(statusOf(a));
    return bySeverity !== 0 ? bySeverity : depletion(a) - depletion(b);
  });

  const by_category = [...categoryRollup.entries()]
    .map(([category, value]) => ({ category, items: value.items, needs_attention: value.needs_attention }))
    .sort((a, b) => b.needs_attention - a.needs_attention || b.items - a.items);

  return {
    generated_at: now,
    total_active_items: items.length,
    status_counts,
    at_risk: atRisk.slice(0, AT_RISK_CAP).map((item) => projectItem(item, dataset)),
    at_risk_truncated: atRisk.length > AT_RISK_CAP,
    by_category,
  };
}

export interface AiInventorySearchResult {
  generated_at: string;
  query: string;
  match_count: number;
  matches: AiInventoryItemView[];
  truncated: boolean;
}

function matchRank(item: InventoryItem, dataset: InventorySource, q: string): number {
  const name = item.name.toLowerCase();
  if (name === q) return 4;
  if (name.startsWith(q)) return 3;
  if (name.includes(q)) return 2;
  if (item.sku.toLowerCase().includes(q)) return 1;
  if (categoryName(item.category, dataset).toLowerCase().includes(q)) return 1;
  return 0;
}

export function searchInventory(
  dataset: InventorySource,
  query: string,
  now: string,
): AiInventorySearchResult {
  const q = query.trim().toLowerCase();
  const items = dataset.items.filter((item) => !item.archived);
  const matched =
    q.length === 0 ? [] : items.filter((item) => matchRank(item, dataset, q) > 0);

  matched.sort((a, b) => {
    const byRank = matchRank(b, dataset, q) - matchRank(a, dataset, q);
    return byRank !== 0 ? byRank : depletion(a) - depletion(b);
  });

  return {
    generated_at: now,
    query: query.trim(),
    match_count: matched.length,
    matches: matched.slice(0, SEARCH_CAP).map((item) => projectItem(item, dataset)),
    truncated: matched.length > SEARCH_CAP,
  };
}

// Price source also needs the learned aliases (where per-vendor cost is captured).
type PriceSource = InventorySource & Pick<InventoryDataset, "item_aliases">;

export interface AiVendorPriceView {
  name: string;
  sku: string;
  unit: string;
  // Cheapest first; last cost paid per the item's stock unit. Empty = no recorded price.
  vendors: Array<{ vendor: string; last_cost_cents_per_unit: number }>;
  cheapest_vendor: string | null;
}

export interface AiVendorPriceResult {
  generated_at: string;
  query: string;
  match_count: number;
  items: AiVendorPriceView[];
  truncated: boolean;
}

// Per-vendor price comparison for the AI "who's cheapest for X" tool (ADR-0586 Phase 2B).
// Reuses the same name/SKU/category match as find_inventory_item, then projects each item's
// per-vendor last cost from the learned aliases (vendorPricesForItem, cheapest first). Pure +
// now-injected. Read-only — prices are last-paid history, not live quotes.
export function vendorPriceLookup(
  dataset: PriceSource,
  query: string,
  now: string,
): AiVendorPriceResult {
  const q = query.trim().toLowerCase();
  const items = dataset.items.filter((item) => !item.archived);
  const matched =
    q.length === 0 ? [] : items.filter((item) => matchRank(item, dataset, q) > 0);

  matched.sort((a, b) => matchRank(b, dataset, q) - matchRank(a, dataset, q));

  const projected = matched.slice(0, SEARCH_CAP).map((item) => {
    const prices = vendorPricesForItem(item.id, dataset.item_aliases);
    return {
      name: item.name,
      sku: item.sku,
      unit: item.unit,
      vendors: prices.map((p) => ({ vendor: p.vendor, last_cost_cents_per_unit: p.lastCostCents })),
      cheapest_vendor: prices[0]?.vendor ?? null,
    };
  });

  return {
    generated_at: now,
    query: query.trim(),
    match_count: matched.length,
    items: projected,
    truncated: matched.length > SEARCH_CAP,
  };
}
