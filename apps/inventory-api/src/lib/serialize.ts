import type {
  InventoryActivityEntry as ActivityRow,
  InventoryCategory as CategoryRow,
  InventoryCountRecord as CountRow,
  InventoryEmployee as EmployeeRow,
  InventoryItem as ItemRow,
  InventoryItemAlias as AliasRow,
  InventoryItemPack as PackRow,
  InventoryBarcode as BarcodeRow,
  InventoryItemState as ItemStateRow,
  InventoryMetrics as MetricsRow,
  InventoryPoLine as PoLineRow,
  InventoryPurchaseOrder as PoRow,
  InventoryRecipe as RecipeRow,
  InventoryRecipeLine as RecipeLineRow,
  InventoryRecipeModifier as RecipeModifierRow,
  InventoryVendor as VendorRow,
  InventoryVendorQuote as VendorQuoteRow,
  InventoryWasteEntry as WasteEntryRow,
  InventoryWasteReason as WasteReasonRow,
  InventoryWasteSettings as WasteSettingsRow
} from "@rop/db-inventory";
import {
  InventoryDatasetSchema,
  defaultInventoryCategories,
  type InventoryActivityEntry,
  type InventoryCategory,
  type InventoryCategoryId,
  type InventoryCountRecord,
  type InventoryCountStatus,
  type InventoryDataset,
  type InventoryEmployee,
  type InventoryItem,
  type InventoryItemAlias,
  type InventoryItemPack,
  type InventoryBarcode,
  type InventoryBarcodeSource,
  type InventoryPoStatus,
  type InventoryPurchaseOrder,
  type InventoryPurchaseOrderDetail,
  type InventoryRecipe,
  type InventoryRecipeDetail,
  type InventoryVendor,
  type InventoryVendorQuoteRow as ContractVendorQuoteRow,
  type InventoryWasteEntry,
  type InventoryWasteReason,
  type InventoryWasteReasonId,
  type InventoryWasteSettings,
  type InventoryUnitKind
} from "@rop/contracts";

// Casts at this boundary trust the DB columns to hold contract-enum values; the
// full dataset is re-validated by InventoryDatasetSchema before it leaves the API.

export function toCategory(row: CategoryRow): InventoryCategory {
  return { id: row.id as InventoryCategoryId, name: row.name, color: row.color };
}

// Merge the brand catalog row with its per-location state (ADR-0018, Phase 4
// part 3). When no state row is supplied (single-store reads, or a location with
// no row yet) the item's own columns are the fallback, so the emitted DTO is
// unchanged from the pre-split shape.
export function toItemPack(row: PackRow): InventoryItemPack {
  return {
    id: row.id,
    label: row.label,
    base_qty_per_pack: row.baseQtyPerPack,
    vendor: row.vendor,
    contains_label: row.containsLabel,
    contains_qty: row.containsQty,
    is_purchase_default: row.isPurchaseDefault,
    sort: row.sort
  };
}

export function toBarcode(row: BarcodeRow): InventoryBarcode {
  return {
    code: row.code,
    pack_id: row.packId,
    source: row.source as InventoryBarcodeSource,
    label: row.label
  };
}

// packs/barcodes ride along only when the caller's query included them (the dataset read
// does; partial mutation refreshes like toggle-86 don't). They're optional in the contract,
// so omitting them on a partial refresh is valid — the dataset is the authoritative full read.
export function toItem(
  row: ItemRow & { packs?: PackRow[]; barcodes?: BarcodeRow[] },
  state?: ItemStateRow | null,
  hasImage = false
): InventoryItem {
  const s = state ?? row;
  return {
    id: row.id,
    sku: row.sku,
    name: row.name,
    category: row.categoryId as InventoryCategoryId,
    unit: row.unit,
    // Base-unit kind (ADR-0737). Cast at this boundary like the other enum columns; the
    // column defaults to "count", so pre-migration rows and every existing item read as count.
    // packs/barcodes are emitted by the dataset query wiring in the follow-up (Step ③); they're
    // optional in the contract, so omitting them here keeps this serializer valid meanwhile.
    unit_kind: row.unitKind as InventoryUnitKind,
    on_hand: s.onHand,
    par_min: s.parMin,
    par_max: s.parMax,
    cost_cents: row.costCents,
    purchase_unit: row.purchaseUnit,
    pack_qty: row.packQty,
    purchase_cost_cents: row.purchaseCostCents,
    vendor: row.vendor,
    shelf_days: row.shelfDays,
    last_counted: s.lastCounted,
    flagged_86: s.flagged86,
    archived: row.archivedAt !== null,
    has_image: hasImage,
    // Emit packs/barcodes only when the query loaded them (see the function comment).
    ...(row.packs ? { packs: row.packs.map(toItemPack) } : {}),
    ...(row.barcodes ? { barcodes: row.barcodes.map(toBarcode) } : {}),
    // Omit when unset: the column defaults to "" for the many items with no chosen
    // emoji, so the DTO stays lean and predates-the-field fixtures/snapshots are
    // unaffected. The UI falls back to the category glyph when `icon` is absent.
    ...(row.icon ? { icon: row.icon } : {})
  };
}

export function toRecipe(row: RecipeRow & { lines: RecipeLineRow[] }): InventoryRecipe {
  return {
    id: row.id,
    name: row.name,
    category: row.category,
    sell_cents: row.sellCents,
    sold_today: row.soldToday,
    lines: row.lines.map((l) => ({ sku: l.sku, qty: l.qty }))
  };
}

// Editor detail: the base recipe plus per-modifier consumption and the Clover
// link. `qtyDelta` is signed (negative = a modifier that credits stock back).
export function toRecipeDetail(
  row: RecipeRow & { lines: RecipeLineRow[]; modifiers: RecipeModifierRow[] }
): InventoryRecipeDetail {
  return {
    ...toRecipe(row),
    clover_item_id: row.cloverItemId,
    modifiers: row.modifiers.map((m) => ({
      group: m.groupName,
      option: m.optionName,
      sku: m.sku,
      qty: m.qtyDelta
    }))
  };
}

export function toVendor(row: VendorRow): InventoryVendor {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    contact: row.contact,
    phone: row.phone,
    email: row.email,
    account: row.account,
    terms: row.terms,
    min_order_cents: row.minOrderCents,
    cutoff: row.cutoff,
    delivery_days: row.deliveryDays,
    categories: row.categories as InventoryCategoryId[],
    fill_rate: row.fillRate,
    on_time: row.onTime,
    price_stability: row.priceStability,
    credits_90d: row.credits90d,
    spend_30d: row.spend30d,
    trend_4w: row.trend4w,
    preferred: row.preferred,
    tags: row.tags,
    archived: row.archivedAt !== null
  };
}

// Learned vendor alias (ADR-0586). Snake-cases the row into the dataset DTO
// the web matchers consume. `raw` / `pack` are stored under the raw_description /
// pack_descriptor columns (the Prisma fields are `raw` / `pack`).
export function toItemAlias(row: AliasRow): InventoryItemAlias {
  return {
    id: row.id,
    item_id: row.itemId,
    vendor: row.vendor,
    vendor_label: row.vendorLabel,
    normalized: row.normalized,
    raw: row.raw,
    brand: row.brand,
    pack: row.pack,
    pack_id: row.packId ?? null,
    source: row.source,
    last_cost_cents: row.lastCostCents,
    hits: row.hits,
    last_seen_at: row.lastSeenAt.toISOString()
  };
}

export function toVendorQuoteRows(rows: VendorQuoteRow[]): ContractVendorQuoteRow[] {
  const bySku = new Map<string, ContractVendorQuoteRow>();
  for (const row of rows) {
    let entry = bySku.get(row.sku);
    if (!entry) {
      entry = { sku: row.sku, quotes: [] };
      bySku.set(row.sku, entry);
    }
    entry.quotes.push({ vid: row.vendorId, cents: row.cents, primary: row.primary });
  }
  return [...bySku.values()];
}

export function toPurchaseOrder(row: PoRow): InventoryPurchaseOrder {
  return {
    id: row.id,
    vendor: row.vendor,
    placed: row.placed,
    expected: row.expected,
    lines: row.lines,
    status: row.status as InventoryPoStatus,
    total_cents: row.totalCents
  };
}

export function toPurchaseOrderDetail(
  po: PoRow,
  lines: PoLineRow[],
  itemsById: Map<string, ItemRow>
): InventoryPurchaseOrderDetail {
  return {
    ...toPurchaseOrder(po),
    line_items: lines.map((l) => {
      const item = itemsById.get(l.sku);
      return {
        sku: l.sku,
        name: item?.name ?? l.sku,
        unit: item?.unit ?? "",
        qty_ordered: l.qtyOrdered,
        qty_received: l.qtyReceived,
        unit_cost_cents: l.unitCostCents ?? null
      };
    })
  };
}

export function toEmployeeAdmin(row: EmployeeRow): InventoryEmployee {
  return {
    id: row.id,
    name: row.name,
    role: row.role,
    shift: row.shift,
    initials: row.initials,
    color: row.color,
    active: row.active,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString()
  };
}

export function toCountRecord(row: CountRow): InventoryCountRecord {
  return {
    id: row.id,
    date: row.date,
    who: row.who,
    scope: row.scope,
    items: row.items,
    variance_pct: row.variancePct,
    variance_cents: row.varianceCents,
    status: row.status as InventoryCountStatus
  };
}

export function toWasteReason(row: WasteReasonRow): InventoryWasteReason {
  return {
    id: row.id as InventoryWasteReasonId,
    label: row.label,
    color: row.color,
    needs_photo_over_cents: row.needsPhotoOverCents
  };
}

export function toWasteEntry(row: WasteEntryRow): InventoryWasteEntry {
  return {
    id: row.id,
    at: row.at,
    who: row.who,
    sku: row.sku,
    qty: row.qty,
    reason: row.reason as InventoryWasteReasonId,
    notes: row.notes,
    photo: row.photo,
    approved: row.approved
  };
}

export function toActivityEntry(row: ActivityRow): InventoryActivityEntry {
  return {
    id: row.id,
    at: row.at,
    who: row.who,
    action: row.action,
    what: row.what,
    note: row.note
  };
}

export function toWasteSettings(row: WasteSettingsRow): InventoryWasteSettings {
  return {
    photo_required_over_cents: row.photoRequiredOverCents,
    manager_approval_over_cents: row.managerApprovalOverCents
  };
}

export interface DatasetRows {
  categories: CategoryRow[];
  items: (ItemRow & { packs: PackRow[]; barcodes: BarcodeRow[] })[];
  itemStates: ItemStateRow[];
  // Ids of items that have a photo stored (inventory_item_images). Only the ids —
  // never the bytes — reach the dataset, which sets each item's `has_image` flag.
  imageItemIds: string[];
  recipes: (RecipeRow & { lines: RecipeLineRow[] })[];
  vendors: VendorRow[];
  vendorQuotes: VendorQuoteRow[];
  itemAliases: AliasRow[];
  pos: PoRow[];
  counts: CountRow[];
  wasteReasons: WasteReasonRow[];
  wasteLog: WasteEntryRow[];
  activity: ActivityRow[];
  wasteSettings: WasteSettingsRow | null;
  metrics: MetricsRow | null;
}

export function assembleDataset(rows: DatasetRows): InventoryDataset {
  if (!rows.wasteSettings || !rows.metrics) {
    throw new Error(
      "Inventory database is not initialized: missing waste_settings/metrics singleton (run the seed)."
    );
  }

  const stateByItem = new Map(rows.itemStates.map((s) => [s.itemId, s]));
  const itemsWithImage = new Set(rows.imageItemIds);
  const dataset: InventoryDataset = {
    // Categories are a domain constant (7 fixed enum ids). Fall back to the
    // canonical set when the table is un-seeded so a fresh DB never leaves the
    // "Add item" category picker empty (cold-start deadlock). DB rows win when present.
    categories:
      rows.categories.length > 0 ? rows.categories.map(toCategory) : defaultInventoryCategories,
    items: rows.items.map((it) =>
      toItem(it, stateByItem.get(it.id) ?? null, itemsWithImage.has(it.id))
    ),
    recipes: rows.recipes.map(toRecipe),
    activity: rows.activity.map(toActivityEntry),
    pos: rows.pos.map(toPurchaseOrder),
    counts: rows.counts.map(toCountRecord),
    cogs_target_pct: rows.metrics.cogsTargetPct,
    vendors: rows.vendors.map(toVendor),
    vendor_quotes: toVendorQuoteRows(rows.vendorQuotes),
    item_aliases: rows.itemAliases.map(toItemAlias),
    waste_reasons: rows.wasteReasons.map(toWasteReason),
    waste_log: rows.wasteLog.map(toWasteEntry),
    waste_settings: toWasteSettings(rows.wasteSettings)
  };

  // Boundary validation: guarantee the API only ever emits contract-shaped data.
  return InventoryDatasetSchema.parse(dataset);
}
