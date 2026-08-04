import {
  defaultInventoryCategories,
  type InventoryCategory,
  type InventoryItem,
  type InventoryRecipe,
  type InventoryVendor,
  type InventoryWasteEntry,
} from "@rop/contracts";

import { STATUS_LABEL, statusOf } from "@/lib/inventory/helpers";

/**
 * CSV export for the inventory tables (items / recipes / vendors / waste).
 * Mirrors lib/menu/export-csv.ts: a pure `build*Csv` per table (testable) plus a
 * client-only `download*Csv` that triggers a browser download. Exports take the
 * rows the caller passes (so a filtered table exports what's on screen).
 */

function escapeCell(value: string | number | boolean): string {
  const str = String(value);
  return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

function toCsv(header: string[], rows: Array<Array<string | number | boolean>>): string {
  return [header, ...rows].map((row) => row.map(escapeCell).join(",")).join("\n");
}

function dollars(cents: number): string {
  return (cents / 100).toFixed(2);
}

function categoryNamer(categories: InventoryCategory[]): (id: string) => string {
  const map = new Map<string, string>();
  for (const c of categories) map.set(c.id, c.name);
  for (const c of defaultInventoryCategories) if (!map.has(c.id)) map.set(c.id, c.name);
  return (id) => map.get(id) ?? id;
}

const ITEMS_HEADER = [
  "Name",
  "SKU",
  "Category",
  "Status",
  "On hand",
  "Unit",
  "Par min",
  "Par max",
  "Unit cost",
  "Vendor",
  "86",
];

export function buildItemsCsv(items: InventoryItem[], categories: InventoryCategory[]): string {
  const nameOf = categoryNamer(categories);
  const rows = items.map((item) => [
    item.name,
    item.sku,
    nameOf(item.category),
    STATUS_LABEL[statusOf(item)],
    item.on_hand,
    item.unit,
    item.par_min,
    item.par_max,
    dollars(item.cost_cents),
    item.vendor,
    item.flagged_86 ? "yes" : "no",
  ]);
  return toCsv(ITEMS_HEADER, rows);
}

const RECIPES_HEADER = ["Name", "Category", "Sell price", "Sold today", "Ingredients"];

export function buildRecipesCsv(recipes: InventoryRecipe[]): string {
  const rows = recipes.map((recipe) => [
    recipe.name,
    recipe.category,
    dollars(recipe.sell_cents),
    recipe.sold_today,
    recipe.lines.length,
  ]);
  return toCsv(RECIPES_HEADER, rows);
}

const VENDORS_HEADER = [
  "Name",
  "Type",
  "Contact",
  "Phone",
  "Email",
  "Terms",
  "Min order",
  "Preferred",
  "Categories",
];

export function buildVendorsCsv(vendors: InventoryVendor[], categories: InventoryCategory[]): string {
  const nameOf = categoryNamer(categories);
  const rows = vendors.map((vendor) => [
    vendor.name,
    vendor.type,
    vendor.contact,
    vendor.phone,
    vendor.email,
    vendor.terms,
    dollars(vendor.min_order_cents),
    vendor.preferred ? "yes" : "no",
    vendor.categories.map(nameOf).join("; "),
  ]);
  return toCsv(VENDORS_HEADER, rows);
}

const WASTE_HEADER = ["Date", "Logged by", "Item", "Qty", "Reason", "Approved", "Notes"];

export function buildWasteCsv(entries: InventoryWasteEntry[], items: InventoryItem[]): string {
  const itemName = new Map(items.map((item) => [item.id, item.name]));
  const rows = entries.map((entry) => [
    entry.at,
    entry.who,
    itemName.get(entry.sku) ?? entry.sku,
    entry.qty,
    entry.reason,
    entry.approved ? "yes" : "no",
    entry.notes,
  ]);
  return toCsv(WASTE_HEADER, rows);
}

function triggerDownload(filename: string, csv: string): void {
  if (typeof document === "undefined") return;
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function downloadItemsCsv(items: InventoryItem[], categories: InventoryCategory[]): void {
  triggerDownload("rop-inventory-items.csv", buildItemsCsv(items, categories));
}

export function downloadRecipesCsv(recipes: InventoryRecipe[]): void {
  triggerDownload("rop-recipes.csv", buildRecipesCsv(recipes));
}

export function downloadVendorsCsv(vendors: InventoryVendor[], categories: InventoryCategory[]): void {
  triggerDownload("rop-vendors.csv", buildVendorsCsv(vendors, categories));
}

export function downloadWasteCsv(entries: InventoryWasteEntry[], items: InventoryItem[]): void {
  triggerDownload("rop-waste-log.csv", buildWasteCsv(entries, items));
}
