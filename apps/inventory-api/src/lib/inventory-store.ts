import { randomUUID } from "node:crypto";

import type {
  InventoryItem as ItemRow,
  InventoryItemState as ItemStateRow,
  InventoryReceiptScan as ReceiptScanRow,
  InventoryWasteEntry as WasteEntryRow,
  PrismaClient
} from "@rop/db-inventory";
import type {
  InventoryAdHocReceive,
  InventoryAdHocReceiveLine,
  InventoryCountRecord,
  InventoryCountSubmission,
  InventoryDataset,
  InventoryItem,
  InventoryItemCreate,
  InventoryItemSave,
  InventoryItemPack,
  InventoryItemPackSave,
  InventoryBarcodeSave,
  InventoryBarcodeResolve,
  InventoryParUpdate,
  InventoryPurchaseOrder,
  InventoryPurchaseOrderCreate,
  InventoryPurchaseOrderUpdate,
  InventoryPurchaseOrderDetail,
  InventoryReceiptScan,
  InventoryReceiptScanLine,
  InventoryReceiveSubmission,
  InventoryRecipeCreate,
  InventoryRecipeDetail,
  InventoryRecipeSave,
  InventorySecuritySettings,
  InventorySecuritySettingsSave,
  InventoryVendor,
  InventoryVendorSave,
  InventoryWasteEntry,
  InventoryWasteSubmission
} from "@rop/contracts";
import { defaultInventoryCategories, normalizeAlias, roundCost } from "@rop/contracts";

import { clampOnHand, computeCountVariance, isWasteApproved } from "../domain/inventory.js";
import * as serialize from "./serialize.js";

// Store-level operational rows are scoped by `location_id` (ADR-0018, Phase 4).
// Single-store installs use this default (matching the schema column default);
// multi-store passes the crew actor's location or a requested one. Brand-level
// catalog tables (items, recipes, vendors, categories, waste reasons, settings,
// metrics) are intentionally NOT location-scoped — they're shared across stores.
export const DEFAULT_LOCATION_ID = "default-location";

function dateLabel(): string {
  return new Date().toISOString().slice(0, 10);
}

function timeLabel(): string {
  return new Date().toISOString().slice(11, 16);
}

function dateTimeLabel(): string {
  return `${dateLabel()} ${timeLabel()}`;
}

// Prisma unique-constraint violation (P2002). A concurrent double-submit can slip
// an identical idempotency key past the pre-check; the unique index rejects the
// loser, which we turn into a no-op replay rather than a 500.
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "P2002"
  );
}

// Serialize concurrent stock mutations within one location so the read-modify-write
// of `on_hand` can't lose an update (2026-06-16 audit #1). The store recomputes
// on_hand as an ABSOLUTE value (effective-state fallback + clamp at 0), which an
// atomic `{ decrement }` can't express, so under the default READ COMMITTED two
// writers to the same item both read the old on_hand and the last commit wins —
// on_hand then silently drifts from `Σ` ledger. A transaction-scoped Postgres
// advisory lock makes same-location stock writes queue instead of race; it
// auto-releases at commit/rollback and never touches reads or other locations.
// Coarse (per location, not per item) on purpose: a single-merchant kitchen does a
// handful of stock writes a minute, and a per-item lock would need ordered
// acquisition to stay deadlock-free across multi-line receives/depletions. Must be
// the FIRST statement inside the transaction, before any state read, so the whole
// read-compute-write is covered. `hashtext` maps the key to the int the advisory
// lock takes; the key is parameterized ($1), never interpolated.
async function lockLocationStock(
  tx: Pick<PrismaClient, "$executeRaw">,
  locationId: string
): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`inv-stock:${locationId}`}))`;
}

type ItemStateFields = Pick<ItemStateRow, "onHand" | "parMin" | "parMax" | "lastCounted" | "flagged86">;

// The effective per-location state for an item: the location's state row when it
// exists, else the item's brand catalog columns (non-destructive fallback so a
// location with no state row yet reads the catalog defaults until its first
// write). Used both to seed an upsert's `create` and to read the current
// on_hand/86 for the stock math.
function effectiveState(item: ItemRow, state: ItemStateRow | null): ItemStateFields {
  const source = state ?? item;
  return {
    onHand: source.onHand,
    parMin: source.parMin,
    parMax: source.parMax,
    lastCounted: source.lastCounted,
    flagged86: source.flagged86
  };
}

// Ensure the canonical category rows exist before an item references one by FK.
// inventory_items.category_id is a real FK to inventory_categories, but a fresh prod
// DB has an EMPTY category table — the dataset read serves `defaultInventoryCategories`
// as a fallback, so the picker shows them, yet a create would fail with a P2003 (→400)
// because the row isn't really there. Idempotent: upsert the full canonical set, so any
// item/receive create has its FK target AND the table reads back the complete 8 (not a
// partial set that would bypass the read fallback). Cheap no-op once seeded.
async function ensureCanonicalCategories(
  db: Pick<PrismaClient, "inventoryCategory">
): Promise<void> {
  for (const category of defaultInventoryCategories) {
    await db.inventoryCategory.upsert({
      where: { id: category.id },
      create: { id: category.id, name: category.name, color: category.color },
      update: {}
    });
  }
}

// Learn (or reinforce) a vendor->item alias from a confirmed receive line (ADR
// alias-learning D2). The operator confirming the receive IS the mapping signal, so we
// upsert keyed by the shared (vendor, normalized) key: a brand-new printed text becomes a
// memory, a re-seen one bumps `hits`, and a re-mapped one overwrites `item_id` (correcting
// a prior bad guess). Brand/pack/cost only overwrite when this line actually carries them,
// so a later bare invoice never wipes earlier-learned metadata. No-op when the line has no
// printed `description` (e.g. a hand-typed receive). Runs inside the receive transaction.
async function learnAlias(
  tx: Pick<PrismaClient, "inventoryItemAlias">,
  itemId: string,
  vendor: string | undefined,
  // The specific pack this confirmed line booked into, or null for an item-level line (ADR-882).
  // The latest confirm wins (mirrors itemId), so re-confirming the wording at a different size
  // re-points the memory; a later item-level confirm clears it back to null.
  packId: string | null,
  line: Pick<InventoryAdHocReceiveLine, "description" | "brand" | "pack" | "unit_cost_cents">
): Promise<void> {
  const raw = (line.description ?? "").trim();
  const normalized = normalizeAlias(raw);
  if (!normalized) {
    return;
  }
  const vendorKey = normalizeAlias(vendor ?? "");
  const vendorLabel = (vendor ?? "").trim();
  await tx.inventoryItemAlias.upsert({
    where: { vendor_normalized: { vendor: vendorKey, normalized } },
    create: {
      itemId,
      vendor: vendorKey,
      vendorLabel,
      normalized,
      raw,
      brand: line.brand ?? "",
      pack: line.pack ?? "",
      packId,
      source: "receive",
      // Per-usage cost is a sub-cent Float; round to 4 decimals so a non-terminating pack
      // division (a 6000-ct napkin case -> 0.479c each) never persists as double noise.
      lastCostCents: line.unit_cost_cents != null ? roundCost(line.unit_cost_cents) : null
    },
    update: {
      itemId,
      raw,
      // The latest confirm's pack wins (mirrors itemId), so re-confirming the wording at a
      // different size re-points the memory and an item-level confirm clears it back to null.
      packId,
      hits: { increment: 1 },
      lastSeenAt: new Date(),
      // Refresh the display label only when this receive actually named the vendor, so a
      // later vendor-less receive never blanks an earlier-learned label.
      ...(vendorLabel ? { vendorLabel } : {}),
      ...(line.brand ? { brand: line.brand } : {}),
      ...(line.pack ? { pack: line.pack } : {}),
      ...(line.unit_cost_cents != null ? { lastCostCents: roundCost(line.unit_cost_cents) } : {})
    }
  });
}

// A receive/waste line named a pack_id that doesn't exist or doesn't belong to the line's
// item (ADR-0737). Routes map this to 400 — a client error, never a silent mis-count: we
// refuse rather than guess a conversion factor.
export class PackNotFoundError extends Error {
  constructor(
    public readonly packId: string,
    public readonly itemId: string
  ) {
    super(`pack ${packId} not found for item ${itemId}`);
    this.name = "PackNotFoundError";
  }
}

// Resolve a line's optional pack to a base-unit qty + per-base unit cost (ADR-0737). When
// packId is set, the qty is a count of THAT pack and the cost (if any) is per-pack, so both
// are scaled by the pack's base_qty_per_pack — the persisted successor to ADR-0592's
// client-side guess. The pack must belong to the item, else PackNotFoundError (never silently
// mis-count). When packId is absent, qty/cost pass through as base units — today's behavior,
// and the path the ADR-0592 client-converted scan still takes (it sends no pack_id).
// Exported for unit tests; the receive/waste paths reach it through their transactions.
export async function resolvePackConversion(
  tx: Pick<PrismaClient, "inventoryItemPack">,
  itemId: string,
  packId: string | undefined,
  qty: number,
  costCents?: number
): Promise<{ qty: number; unitCostCents: number | undefined }> {
  if (!packId) {
    return { qty, unitCostCents: costCents };
  }
  const pack = await tx.inventoryItemPack.findUnique({ where: { id: packId } });
  if (!pack || pack.itemId !== itemId) {
    throw new PackNotFoundError(packId, itemId);
  }
  return {
    qty: qty * pack.baseQtyPerPack,
    unitCostCents: costCents == null ? undefined : roundCost(costCents / pack.baseQtyPerPack)
  };
}

// Find-or-create a pack (size) for an item inside a receive transaction (ADR-882) — the tx-aware
// core the scan receive shares with the catalog editor's savePack. Idempotent on (itemId, vendor,
// label): re-confirming the same size reuses the row (so a multi-size haul scanned twice never
// duplicates packs). Scan-created packs are vendor-AGNOSTIC (vendor=""): a 28 oz retail bag is the
// same physical size whoever sells it, so it must not fork per seller — ADR-0737 D3's vendor
// scoping is for when the SAME label means different counts per vendor, not the manufacturer-pack
// case here. The first pack on an item becomes its purchase default.
async function ensureItemPack(
  tx: Pick<PrismaClient, "inventoryItemPack">,
  itemId: string,
  label: string,
  baseQtyPerPack: number
): Promise<{ id: string; baseQtyPerPack: number }> {
  const vendor = "";
  const existing = await tx.inventoryItemPack.findFirst({ where: { itemId, vendor, label } });
  if (existing) {
    return { id: existing.id, baseQtyPerPack: existing.baseQtyPerPack };
  }
  const anyPack = await tx.inventoryItemPack.findFirst({ where: { itemId } });
  const created = await tx.inventoryItemPack.create({
    data: {
      itemId,
      label,
      baseQtyPerPack,
      vendor,
      containsLabel: "",
      containsQty: null,
      isPurchaseDefault: anyPack === null,
      sort: 0
    }
  });
  return { id: created.id, baseQtyPerPack: created.baseQtyPerPack };
}

// A pack create would collide with an existing (item, vendor, label) — the catalog editor maps
// this to 409 so the manager renames it instead of silently editing the other row (ADR-0737).
export class PackLabelConflictError extends Error {
  constructor(
    public readonly label: string,
    public readonly vendor: string
  ) {
    super(`a pack labelled "${label}" already exists for this item/vendor`);
    this.name = "PackLabelConflictError";
  }
}

// Load an item as a full DTO with its packs + barcodes (ADR-0737), for the pack/barcode
// editors to return the fresh item after a change. No per-location state merge: the catalog
// editor shows packaging, not live on_hand (the client re-reads the dataset for that), so the
// item's own column fallback is fine — same as saveItem. Accepts the tx or the base client.
async function loadItemDto(
  db: Pick<PrismaClient, "inventoryItem">,
  itemId: string
): Promise<InventoryItem | null> {
  const item = await db.inventoryItem.findUnique({
    where: { id: itemId },
    include: { packs: { orderBy: [{ sort: "asc" }, { label: "asc" }] }, barcodes: true }
  });
  return item ? serialize.toItem(item) : null;
}

// Create or update a pack on an item (ADR-0737). packId set = update that pack; absent =
// create. is_purchase_default true clears the flag on the item's other packs (at most one
// default). Returns the fresh item DTO, null when the item is missing; throws
// PackLabelConflictError on a duplicate (item, vendor, label) create and PackNotFoundError
// when packId doesn't belong to the item.
export async function savePack(
  prisma: PrismaClient,
  itemId: string,
  input: InventoryItemPackSave,
  packId?: string
): Promise<InventoryItem | null> {
  return prisma.$transaction(async (tx) => {
    const item = await tx.inventoryItem.findUnique({ where: { id: itemId } });
    if (!item) {
      return null;
    }
    const vendorKey = normalizeAlias(input.vendor ?? "");
    if (input.is_purchase_default) {
      await tx.inventoryItemPack.updateMany({
        where: { itemId, isPurchaseDefault: true },
        data: { isPurchaseDefault: false }
      });
    }
    const data = {
      label: input.label,
      baseQtyPerPack: input.base_qty_per_pack,
      vendor: vendorKey,
      containsLabel: input.contains_label ?? "",
      containsQty: input.contains_qty ?? null,
      isPurchaseDefault: input.is_purchase_default ?? false,
      sort: input.sort ?? 0
    };
    if (packId) {
      // Scope to (id, itemId) so a packId from another item is a 404, not a cross-item edit.
      const existing = await tx.inventoryItemPack.findFirst({ where: { id: packId, itemId } });
      if (!existing) {
        throw new PackNotFoundError(packId, itemId);
      }
      await tx.inventoryItemPack.update({ where: { id: packId }, data });
    } else {
      const dup = await tx.inventoryItemPack.findFirst({
        where: { itemId, vendor: vendorKey, label: input.label }
      });
      if (dup) {
        throw new PackLabelConflictError(input.label, vendorKey);
      }
      await tx.inventoryItemPack.create({ data: { ...data, itemId } });
    }
    return loadItemDto(tx, itemId);
  });
}

// Delete a pack (ADR-0737). Idempotent (deleteMany scoped to (id, itemId)). Barcodes that
// pointed at the deleted pack are re-parented to item-level (pack_id null) rather than left
// dangling — there's no FK from barcode.pack_id to a pack. Returns the fresh item DTO.
export async function deletePack(
  prisma: PrismaClient,
  itemId: string,
  packId: string
): Promise<InventoryItem | null> {
  return prisma.$transaction(async (tx) => {
    const item = await tx.inventoryItem.findUnique({ where: { id: itemId } });
    if (!item) {
      return null;
    }
    await tx.inventoryItemPack.deleteMany({ where: { id: packId, itemId } });
    await tx.inventoryBarcode.updateMany({ where: { itemId, packId }, data: { packId: null } });
    return loadItemDto(tx, itemId);
  });
}

// Create or re-map a barcode (ADR-0737). Upsert by `code` (the PK) so the same physical code
// can be re-pointed to this item/pack. A pack_id must belong to the item (else
// PackNotFoundError). Returns the fresh item DTO, null when the item is missing.
export async function saveBarcode(
  prisma: PrismaClient,
  itemId: string,
  input: InventoryBarcodeSave
): Promise<InventoryItem | null> {
  return prisma.$transaction(async (tx) => {
    const item = await tx.inventoryItem.findUnique({ where: { id: itemId } });
    if (!item) {
      return null;
    }
    if (input.pack_id) {
      const pack = await tx.inventoryItemPack.findFirst({ where: { id: input.pack_id, itemId } });
      if (!pack) {
        throw new PackNotFoundError(input.pack_id, itemId);
      }
    }
    const fields = {
      itemId,
      packId: input.pack_id ?? null,
      source: input.source ?? "manufacturer",
      label: input.label ?? ""
    };
    await tx.inventoryBarcode.upsert({
      where: { code: input.code },
      create: { code: input.code, ...fields },
      update: fields
    });
    return loadItemDto(tx, itemId);
  });
}

// Mint an internal house code for a no-UPC item (barcode-onboarding ADR, D4) and register it as
// an `internal` barcode. Idempotent per (item, pack): a second call returns the existing code, so
// re-printing a label never creates a duplicate. The `YR-#####` code is generated server-side
// from a Postgres sequence (crash-safe, gap-OK) and can never collide with a real GTIN.
export async function mintBarcode(
  prisma: PrismaClient,
  itemId: string,
  packId?: string
): Promise<{ item: InventoryItem; code: string } | null> {
  return prisma.$transaction(async (tx) => {
    const item = await tx.inventoryItem.findUnique({ where: { id: itemId } });
    if (!item) {
      return null;
    }
    if (packId) {
      const pack = await tx.inventoryItemPack.findFirst({ where: { id: packId, itemId } });
      if (!pack) {
        throw new PackNotFoundError(packId, itemId);
      }
    }
    const existing = await tx.inventoryBarcode.findFirst({
      where: { itemId, packId: packId ?? null, source: "internal" }
    });
    let code: string;
    if (existing) {
      code = existing.code;
    } else {
      const rows = await tx.$queryRaw<{ n: number }[]>`SELECT nextval('inventory_internal_code_seq')::int AS n`;
      code = `YR-${String(rows[0]?.n ?? 0).padStart(5, "0")}`;
      await tx.inventoryBarcode.create({
        data: { code, itemId, packId: packId ?? null, source: "internal", label: "" }
      });
    }
    const dto = await loadItemDto(tx, itemId);
    return dto ? { item: dto, code } : null;
  });
}

// Delete a barcode by code, scoped to the item (idempotent). Returns the fresh item DTO.
export async function deleteBarcode(
  prisma: PrismaClient,
  itemId: string,
  code: string
): Promise<InventoryItem | null> {
  return prisma.$transaction(async (tx) => {
    const item = await tx.inventoryItem.findUnique({ where: { id: itemId } });
    if (!item) {
      return null;
    }
    await tx.inventoryBarcode.deleteMany({ where: { code, itemId } });
    return loadItemDto(tx, itemId);
  });
}

// Resolve a scanned code to its item + the specific pack it maps to (ADR-0737). null when the
// code is unknown (route 404s). The pack is null for an item-level code (operator picks one).
export async function resolveBarcode(
  prisma: PrismaClient,
  code: string
): Promise<InventoryBarcodeResolve | null> {
  const barcode = await prisma.inventoryBarcode.findUnique({ where: { code } });
  if (!barcode) {
    return null;
  }
  const item = await loadItemDto(prisma, barcode.itemId);
  if (!item) {
    return null;
  }
  let pack: InventoryItemPack | null = null;
  if (barcode.packId) {
    const packRow = await prisma.inventoryItemPack.findUnique({ where: { id: barcode.packId } });
    pack = packRow ? serialize.toItemPack(packRow) : null;
  }
  return { item, pack };
}

// GH #184: the `activity` feed is an append-only ledger that grows forever, yet
// GET /api/inventory re-fetched, serialized, and re-validated the WHOLE table on
// every read while the only consumer renders activity.slice(0, 5)
// (overview-tab.tsx). Bound it to the most-recent N so the hot dataset query
// stays flat as it grows. The contract field is z.array(...), so a shorter array
// still validates — server-only change, no client change. Mirrors listReceiptScans.
//
// IMPORTANT — only `activity` is row-capped. `waste_log` and `counts` are NOT:
// the backoffice waste-tab/counts-tab compute WHOLE-HISTORY aggregates over the
// full arrays (top-offender SKUs, the "Waste today" KPI sum) and offer an "All
// recorded events" CSV export, so a blind row cap would silently corrupt totals
// and truncate the audit export once a ledger exceeds the cap. Bounding those
// correctly needs a date window + a paginated `?since=` history endpoint — the
// issue's deferred needs-ADR work, intentionally not done here.
const DATASET_ACTIVITY_LIMIT = 200;

export async function getDataset(
  prisma: PrismaClient,
  locationId: string = DEFAULT_LOCATION_ID,
  includeArchived = false
): Promise<InventoryDataset> {
  const [
    categories,
    items,
    itemStates,
    imageRows,
    recipes,
    vendors,
    vendorQuotes,
    itemAliases,
    pos,
    counts,
    wasteReasons,
    wasteLog,
    activity,
    wasteSettings,
    metrics
  ] = await Promise.all([
    prisma.inventoryCategory.findMany({ orderBy: { id: "asc" } }),
    prisma.inventoryItem.findMany({
      // Soft-delete (ADR catalog-management D1): the active dataset excludes
      // archived items so every existing consumer (KPIs, counts, waste, statuses)
      // stays correct with no change. `include=archived` surfaces them for the
      // archive-management view. Internal lookups (sales-sync depletion, receive)
      // query items by id directly, so archived items remain resolvable there.
      where: includeArchived ? {} : { archivedAt: null },
      // Packs + barcodes ride with the item (ADR-0737) so the dataset carries the full
      // packaging model; packs ordered for a stable UI list (sort, then label).
      include: { packs: { orderBy: [{ sort: "asc" }, { label: "asc" }] }, barcodes: true },
      orderBy: { id: "asc" }
    }),
    prisma.inventoryItemState.findMany({ where: { locationId } }),
    // Only the ids of items that have a photo — never the bytes — so the hot
    // dataset query stays small. The browser fetches each photo lazily.
    prisma.inventoryItemImage.findMany({ select: { itemId: true } }),
    prisma.inventoryRecipe.findMany({ include: { lines: true }, orderBy: { id: "asc" } }),
    prisma.inventoryVendor.findMany({
      // Soft-delete (ADR catalog-management D2): exclude archived vendors from the
      // active dataset, surfaced only via include=archived — same as items.
      where: includeArchived ? {} : { archivedAt: null },
      orderBy: { id: "asc" }
    }),
    prisma.inventoryVendorQuote.findMany(),
    // Learned vendor aliases (ADR-0586): brand-level catalog data, shared
    // across stores like items/vendors, so not location-scoped. The web matchers read
    // these to auto-match a scanned line to its canonical item.
    prisma.inventoryItemAlias.findMany({ orderBy: { hits: "desc" } }),
    // Cancelled POs are terminal and deliberately absent from the dataset — the
    // floor receive flow / home badges never see one, and a client built before
    // the "cancelled" enum value can't choke on it. The activity feed carries
    // the cancellation record.
    prisma.inventoryPurchaseOrder.findMany({
      where: { locationId, status: { not: "cancelled" } },
      orderBy: { placed: "desc" }
    }),
    // counts + waste are read in FULL: backoffice aggregates whole history (KPIs,
    // top-offender SKUs) and CSV-exports "all recorded events". See the comment
    // on DATASET_ACTIVITY_LIMIT — capping these would corrupt those totals.
    prisma.inventoryCountRecord.findMany({ where: { locationId }, orderBy: { date: "desc" } }),
    prisma.inventoryWasteReason.findMany(),
    prisma.inventoryWasteEntry.findMany({ where: { locationId }, orderBy: { at: "desc" } }),
    // activity is the one feed the UI only ever shows the most-recent slice of,
    // so it is safe (and worthwhile) to bound — see GH #184 comment above.
    prisma.inventoryActivityEntry.findMany({
      where: { locationId },
      orderBy: { createdAt: "desc" },
      take: DATASET_ACTIVITY_LIMIT
    }),
    prisma.inventoryWasteSettings.findUnique({ where: { id: "singleton" } }),
    prisma.inventoryMetrics.findUnique({ where: { id: "singleton" } })
  ]);

  return serialize.assembleDataset({
    categories,
    items,
    itemStates,
    imageItemIds: imageRows.map((r) => r.itemId),
    recipes,
    vendors,
    vendorQuotes,
    itemAliases,
    pos,
    counts,
    wasteReasons,
    wasteLog,
    activity,
    wasteSettings,
    metrics
  });
}

export async function toggle86(
  prisma: PrismaClient,
  id: string,
  who: string,
  locationId: string = DEFAULT_LOCATION_ID
): Promise<InventoryItem | null> {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.inventoryItem.findUnique({ where: { id } });
    if (!existing) {
      return null;
    }
    const state = await tx.inventoryItemState.findUnique({
      where: { locationId_itemId: { locationId, itemId: id } }
    });
    const current = effectiveState(existing, state);
    const nextFlag = !current.flagged86;
    const updated = await tx.inventoryItemState.upsert({
      where: { locationId_itemId: { locationId, itemId: id } },
      create: { locationId, itemId: id, ...current, flagged86: nextFlag },
      update: { flagged86: nextFlag }
    });
    await tx.inventoryActivityEntry.create({
      data: {
        locationId,
        at: timeLabel(),
        who,
        action: nextFlag ? "flagged 86" : "cleared 86",
        what: existing.name,
        note: ""
      }
    });
    return serialize.toItem(existing, updated);
  });
}

// Edit an item's par levels (ADR catalog-management D1). par is per-LOCATION state,
// so this upserts inventory_item_state (seeded from the effective state, same as
// toggle86), NOT the brand-catalog item columns. Returns null when the item is
// missing (404 at the route).
export async function updatePar(
  prisma: PrismaClient,
  id: string,
  update: InventoryParUpdate,
  who: string,
  locationId: string = DEFAULT_LOCATION_ID
): Promise<InventoryItem | null> {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.inventoryItem.findUnique({ where: { id } });
    if (!existing) {
      return null;
    }
    const state = await tx.inventoryItemState.findUnique({
      where: { locationId_itemId: { locationId, itemId: id } }
    });
    const current = effectiveState(existing, state);
    const updated = await tx.inventoryItemState.upsert({
      where: { locationId_itemId: { locationId, itemId: id } },
      create: { locationId, itemId: id, ...current, parMin: update.par_min, parMax: update.par_max },
      update: { parMin: update.par_min, parMax: update.par_max }
    });
    await tx.inventoryActivityEntry.create({
      data: {
        locationId,
        at: timeLabel(),
        who,
        action: "updated par",
        what: existing.name,
        note: `${update.par_min} / ${update.par_max}`
      }
    });
    return serialize.toItem(existing, updated);
  });
}

// Archive (soft-delete) or restore an item (ADR catalog-management D1). archivedAt
// is brand-catalog state (not location-scoped); the row is retained so references
// stay intact. Returns null when the item is missing (404 at the route). The serialized
// item carries the location's state for display, same as every other item response.
export async function setArchived(
  prisma: PrismaClient,
  id: string,
  archived: boolean,
  who: string,
  locationId: string = DEFAULT_LOCATION_ID
): Promise<InventoryItem | null> {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.inventoryItem.findUnique({ where: { id } });
    if (!existing) {
      return null;
    }
    const updated = await tx.inventoryItem.update({
      where: { id },
      data: { archivedAt: archived ? new Date() : null }
    });
    await tx.inventoryActivityEntry.create({
      data: {
        locationId,
        at: timeLabel(),
        who,
        action: archived ? "archived item" : "restored item",
        what: existing.name,
        note: ""
      }
    });
    const state = await tx.inventoryItemState.findUnique({
      where: { locationId_itemId: { locationId, itemId: id } }
    });
    return serialize.toItem(updated, state);
  });
}

export interface ApplyCountsResult {
  count: InventoryCountRecord;
  items_updated: number;
  // Internal producer signal (Phase 5c): the items a recount took below their
  // minimum par. The route emits one low-stock notification per entry; it is NOT
  // included in the API response. A count can cover many items, hence an array.
  lowStock?: Array<{ itemId: string; itemName: string; onHand: number; parMin: number }>;
}

export async function applyCounts(
  prisma: PrismaClient,
  submission: InventoryCountSubmission,
  locationId: string = DEFAULT_LOCATION_ID
): Promise<ApplyCountsResult> {
  const idempotencyKey = submission.idempotency_key;
  if (idempotencyKey) {
    const prior = await prisma.inventoryCountRecord.findUnique({
      where: { locationId_idempotencyKey: { locationId, idempotencyKey } }
    });
    if (prior) {
      return { count: serialize.toCountRecord(prior), items_updated: prior.items };
    }
  }
  try {
    return await prisma.$transaction(async (tx) => {
      await lockLocationStock(tx, locationId);
      const ids = Object.keys(submission.updates);
      const items = await tx.inventoryItem.findMany({ where: { id: { in: ids } } });
      const states = await tx.inventoryItemState.findMany({
        where: { locationId, itemId: { in: ids } }
      });
      const stateByItem = new Map(states.map((s) => [s.itemId, s]));
      const today = dateLabel();

      const varianceInputs = [];
      const movements: { itemId: string; delta: number }[] = [];
      const lowStockCrossings: NonNullable<ApplyCountsResult["lowStock"]> = [];
      for (const item of items) {
        const next = submission.updates[item.id];
        if (next === undefined) {
          continue;
        }
        const current = effectiveState(item, stateByItem.get(item.id) ?? null);
        varianceInputs.push({ costCents: item.costCents, before: current.onHand, after: next });
        const nextOnHand = clampOnHand(next);
        if (nextOnHand !== current.onHand) {
          movements.push({ itemId: item.id, delta: nextOnHand - current.onHand });
        }
        if (crossedBelowPar(current.onHand, nextOnHand, current.parMin)) {
          lowStockCrossings.push({
            itemId: item.id,
            itemName: item.name,
            onHand: nextOnHand,
            parMin: current.parMin
          });
        }
        await tx.inventoryItemState.upsert({
          where: { locationId_itemId: { locationId, itemId: item.id } },
          create: {
            locationId,
            itemId: item.id,
            ...current,
            onHand: nextOnHand,
            lastCounted: today
          },
          update: { onHand: nextOnHand, lastCounted: today }
        });
      }

      const variance = computeCountVariance(varianceInputs);
      const record = await tx.inventoryCountRecord.create({
        data: {
          locationId,
          id: `CT-${randomUUID()}`,
          date: today,
          who: submission.who,
          scope: submission.scope ?? "Quick recount",
          items: variance.items,
          variancePct: variance.variancePct,
          varianceCents: variance.varianceCents,
          status: "closed",
          idempotencyKey: idempotencyKey ?? null
        }
      });
      if (movements.length > 0) {
        await tx.inventoryStockMovement.createMany({
          data: movements.map((m) => ({
            locationId,
            itemId: m.itemId,
            delta: m.delta,
            reason: "count_adjust",
            sourceRef: record.id,
            actor: submission.who
          }))
        });
      }
      await tx.inventoryActivityEntry.create({
        data: {
          locationId,
          at: timeLabel(),
          who: submission.who,
          action: "counted",
          what: `${variance.items} items`,
          note: variance.variancePct === null ? "Recount" : `Variance: ${variance.variancePct}%`
        }
      });

      return { count: serialize.toCountRecord(record), items_updated: variance.items, lowStock: lowStockCrossings };
    });
  } catch (error) {
    if (idempotencyKey && isUniqueViolation(error)) {
      const prior = await prisma.inventoryCountRecord.findUnique({
        where: { locationId_idempotencyKey: { locationId, idempotencyKey } }
      });
      if (prior) {
        return { count: serialize.toCountRecord(prior), items_updated: prior.items };
      }
    }
    throw error;
  }
}

export interface RecordWasteResult {
  entry: InventoryWasteEntry;
  item: InventoryItem | null;
  // Internal producer signal (Phase 5c): set when this waste took the item from
  // at-or-above its minimum par to below it. The route emits a low-stock
  // notification from it; it is NOT included in the API response.
  lowStock?: { parMin: number } | null;
}

// True when a stock change takes an item from at-or-above its minimum par to below
// it — the downward crossing that warrants a one-shot low-stock alert (a further
// drop while already low does not re-cross, so this never spams). parMin <= 0 means
// no par is set, so it is never a breach.
export function crossedBelowPar(before: number, after: number, parMin: number): boolean {
  return parMin > 0 && before >= parMin && after < parMin;
}

export async function recordWaste(
  prisma: PrismaClient,
  submission: InventoryWasteSubmission,
  locationId: string = DEFAULT_LOCATION_ID
): Promise<RecordWasteResult> {
  const idempotencyKey = submission.idempotency_key;
  if (idempotencyKey) {
    const prior = await prisma.inventoryWasteEntry.findUnique({
      where: { locationId_idempotencyKey: { locationId, idempotencyKey } }
    });
    if (prior) {
      return buildWasteReplay(prisma, prior, locationId);
    }
  }
  try {
    return await prisma.$transaction(async (tx) => {
      await lockLocationStock(tx, locationId);
      const settings = await tx.inventoryWasteSettings.findUnique({ where: { id: "singleton" } });
      if (!settings) {
        throw new Error("Inventory database is not initialized: missing waste_settings (run the seed).");
      }
      const item = await tx.inventoryItem.findUnique({ where: { id: submission.sku } });
      // Convert a pack-denominated waste (e.g. a whole sealed bag) to base units (ADR-0737);
      // passes through when no pack_id. Stored on the entry and applied to on_hand in base units.
      const wasteQty = item
        ? (await resolvePackConversion(tx, item.id, submission.pack_id, submission.qty)).qty
        : submission.qty;
      const approved = isWasteApproved(submission.cost_cents, serialize.toWasteSettings(settings));

      const entry = await tx.inventoryWasteEntry.create({
        data: {
          locationId,
          at: dateTimeLabel(),
          who: submission.who,
          sku: submission.sku,
          qty: wasteQty,
          reason: submission.reason,
          notes: submission.notes,
          photo: submission.photo,
          approved,
          idempotencyKey: idempotencyKey ?? null
        }
      });

      let updatedItem: InventoryItem | null = null;
      let lowStock: { parMin: number } | null = null;
      if (item) {
        const state = await tx.inventoryItemState.findUnique({
          where: { locationId_itemId: { locationId, itemId: item.id } }
        });
        const current = effectiveState(item, state);
        const nextOnHand = clampOnHand(current.onHand - wasteQty);
        const updatedState = await tx.inventoryItemState.upsert({
          where: { locationId_itemId: { locationId, itemId: item.id } },
          create: { locationId, itemId: item.id, ...current, onHand: nextOnHand },
          update: { onHand: nextOnHand }
        });
        if (nextOnHand !== current.onHand) {
          await tx.inventoryStockMovement.create({
            data: {
              locationId,
              itemId: item.id,
              delta: nextOnHand - current.onHand,
              reason: "waste",
              sourceRef: entry.id,
              actor: submission.who
            }
          });
        }
        updatedItem = serialize.toItem(item, updatedState);
        if (crossedBelowPar(current.onHand, nextOnHand, current.parMin)) {
          lowStock = { parMin: current.parMin };
        }
      }

      await tx.inventoryActivityEntry.create({
        data: {
          locationId,
          at: timeLabel(),
          who: submission.who,
          action: "recorded waste",
          what: `${wasteQty} ${item?.unit ?? ""} ${item?.name ?? submission.sku}`.replace(/\s+/g, " ").trim(),
          note: `Reason: ${submission.reason}`
        }
      });

      return { entry: serialize.toWasteEntry(entry), item: updatedItem, lowStock };
    });
  } catch (error) {
    if (idempotencyKey && isUniqueViolation(error)) {
      const prior = await prisma.inventoryWasteEntry.findUnique({
        where: { locationId_idempotencyKey: { locationId, idempotencyKey } }
      });
      if (prior) {
        return buildWasteReplay(prisma, prior, locationId);
      }
    }
    throw error;
  }
}

// Re-serialize a prior waste entry for an idempotent replay: returns the original
// entry plus the item's CURRENT state, without appending a second movement /
// activity row or touching on_hand.
async function buildWasteReplay(
  prisma: PrismaClient,
  entry: WasteEntryRow,
  locationId: string
): Promise<RecordWasteResult> {
  const item = await prisma.inventoryItem.findUnique({ where: { id: entry.sku } });
  let serializedItem: InventoryItem | null = null;
  if (item) {
    const state = await prisma.inventoryItemState.findUnique({
      where: { locationId_itemId: { locationId, itemId: item.id } }
    });
    serializedItem = serialize.toItem(item, state);
  }
  return { entry: serialize.toWasteEntry(entry), item: serializedItem };
}

export async function getPurchaseOrder(
  prisma: PrismaClient,
  id: string,
  locationId: string = DEFAULT_LOCATION_ID
): Promise<InventoryPurchaseOrderDetail | null> {
  // Location-scoped read (ADR-0018 Phase 4): a PO is only visible to its own
  // store. `findFirst` (not `findUnique`) because (id, location_id) is not a
  // declared compound unique — id alone is the PK, so this returns the PO only
  // when it also belongs to `locationId`, closing the cross-store PO read.
  const po = await prisma.inventoryPurchaseOrder.findFirst({
    where: { id, locationId },
    include: { lineItems: true }
  });
  if (!po) {
    return null;
  }
  const items = await prisma.inventoryItem.findMany({
    where: { id: { in: po.lineItems.map((l) => l.sku) } }
  });
  const itemsById = new Map(items.map((it) => [it.id, it]));
  return serialize.toPurchaseOrderDetail(po, po.lineItems, itemsById);
}

export async function receivePurchaseOrder(
  prisma: PrismaClient,
  poId: string,
  submission: InventoryReceiveSubmission,
  locationId: string = DEFAULT_LOCATION_ID
): Promise<InventoryPurchaseOrder | null> {
  return prisma.$transaction(async (tx) => {
    await lockLocationStock(tx, locationId);
    const po = await tx.inventoryPurchaseOrder.findUnique({ where: { id: poId } });
    if (!po) {
      return null;
    }
    // A cancelled PO must not be receivable — without this, receiving would
    // silently resurrect it to "received" and move stock for a dead order.
    if (po.status === "cancelled") {
      throw new PoStateConflictError(po.status);
    }
    // Already received: a retry / double-submit is an idempotent no-op (2026-06-16
    // audit #5). The per-line movement guard already blocks double stock, but
    // without this short-circuit a replay would append a second "received" activity
    // row and could overwrite qty_received with a new quantity that has no matching
    // movement. Returning the PO keeps a network-retry clean (200, not a 409).
    if (po.status === "received") {
      return serialize.toPurchaseOrder(po);
    }

    for (const line of submission.lines) {
      const item = await tx.inventoryItem.findUnique({ where: { id: line.sku } });
      const sourceRef = `${poId}:${line.sku}`;
      // Convert a pack-denominated line to base units (ADR-0737); passes through to the raw
      // qty when there's no pack_id. Used for both on_hand and the recorded qty_received, so
      // the PO is stored in stock units like the rest of the model.
      let baseQty = line.qty;
      if (item) {
        // Idempotent receive (ADR-0028): if this PO line already produced a
        // `receive` movement *at this location*, a retried / double-submitted
        // receive is a no-op — skip the line so on_hand isn't bumped twice. The
        // unique index on (location_id, reason, source_ref, item_id) is the
        // DB-level backstop for races; per ADR-0018 Phase 4 it is location-scoped,
        // so a PO line received in location A does not block location B's receive.
        const alreadyReceived = await tx.inventoryStockMovement.findUnique({
          where: {
            locationId_reason_sourceRef_itemId: {
              locationId,
              reason: "receive",
              sourceRef,
              itemId: item.id
            }
          }
        });
        if (alreadyReceived) {
          continue;
        }
        const state = await tx.inventoryItemState.findUnique({
          where: { locationId_itemId: { locationId, itemId: item.id } }
        });
        const current = effectiveState(item, state);
        baseQty = (await resolvePackConversion(tx, item.id, line.pack_id, line.qty)).qty;
        const nextOnHand = clampOnHand(current.onHand + baseQty);
        await tx.inventoryItemState.upsert({
          where: { locationId_itemId: { locationId, itemId: item.id } },
          create: { locationId, itemId: item.id, ...current, onHand: nextOnHand },
          update: { onHand: nextOnHand }
        });
        if (nextOnHand !== current.onHand) {
          await tx.inventoryStockMovement.create({
            data: {
              locationId,
              itemId: item.id,
              delta: nextOnHand - current.onHand,
              reason: "receive",
              sourceRef,
              actor: submission.who
            }
          });
        }
      }
      await tx.inventoryPoLine.updateMany({
        where: { poId, sku: line.sku },
        data: { qtyReceived: baseQty }
      });
    }

    const updated = await tx.inventoryPurchaseOrder.update({
      where: { id: poId },
      data: { status: "received" }
    });
    await tx.inventoryActivityEntry.create({
      data: {
        locationId,
        at: timeLabel(),
        who: submission.who,
        action: "received",
        what: `PO ${poId} from ${po.vendor}`,
        note: `${submission.lines.length} lines received`
      }
    });

    return serialize.toPurchaseOrder(updated);
  });
}

export interface AdHocReceiveResult {
  received: number;
  created: number;
}

// Ad-hoc receive (ADR invoice-scan D2): receive a delivery with NO purchase order.
// Each line targets an existing item by id, or — when `sku` is absent — inline-creates
// a catalog item from name/category/unit so an empty store bootstraps from its
// invoices. Idempotent like PO receive, but gated on the WHOLE submission: if the
// idempotency key already produced ad-hoc movements, the submission ran before and is
// a no-op. The whole-submission gate (not per-line) is what prevents a retry from
// re-creating the inline items as fresh uuids.
// Best-effort receipt-image archive metadata for an ad-hoc receive (receipt-archive).
// `ref` is the SAME idempotency anchor used for the stock movements (so the archive
// row and the movements it explains share one key, and the R2 object key derives from
// it). imageKey is null when archiving the bytes failed or R2 is unconfigured — the
// receive still records the log row. Provided ONLY when the receive carried a scanned
// image; a PO/manual receive omits it and no archive row is written.
export interface ReceiveArchive {
  ref: string;
  imageKey: string | null;
  contentType: string | null;
}

export async function receiveAdHoc(
  prisma: PrismaClient,
  submission: InventoryAdHocReceive,
  locationId: string = DEFAULT_LOCATION_ID,
  archive?: ReceiveArchive
): Promise<AdHocReceiveResult> {
  const key = submission.idempotency_key;
  return prisma.$transaction(async (tx) => {
    await lockLocationStock(tx, locationId);
    if (key) {
      const prior = await tx.inventoryStockMovement.findFirst({
        where: { locationId, reason: "receive", sourceRef: { startsWith: `adhoc:${key}:` } }
      });
      if (prior) {
        // Already applied — no-op replay (no double on_hand, no duplicate items, and
        // no duplicate archive row: the receipt scan was written on the original call).
        return { received: 0, created: 0 };
      }
    }

    // Shared anchor: the caller's ref (also the R2 object key) wins so the archive row,
    // the stock movements, and the stored image all line up; else fall back as before.
    const ref = archive?.ref ?? key ?? randomUUID();
    let received = 0;
    let created = 0;
    // ADR-882: several NEW lines that are the same product at different sizes share a client
    // `item_group` ref so they create ONE item (the first such line) and attach each line's pack
    // to it, instead of duplicate items. Scoped to this txn — maps the ref to the created item id.
    const groupItems = new Map<string, string>();

    for (const [index, line] of submission.lines.entries()) {
      // Per-base cost for a NEW item: a `new_pack` line prices per pack, so divide by the pack's
      // base_qty_per_pack to get the stable per-base cost the catalog stores (ADR-0737 / ADR-882).
      const lineCostCents = line.unit_cost_cents ?? 0;
      const baseCostCents = line.new_pack
        ? roundCost(lineCostCents / line.new_pack.base_qty_per_pack)
        : lineCostCents;

      let item: ItemRow | null = line.sku
        ? await tx.inventoryItem.findUnique({ where: { id: line.sku } })
        : line.item_group && groupItems.has(line.item_group)
          ? await tx.inventoryItem.findUnique({ where: { id: groupItems.get(line.item_group) as string } })
          : null;
      if (!item && line.name && line.category && line.unit) {
        await ensureCanonicalCategories(tx);
        const id = `item-${randomUUID()}`;
        // purchase_cost_cents is whole-cent (the price paid per base unit); cost_cents keeps the
        // sub-cent per-base precision (ADR-0586's napkin case). For a packed item both are per-base
        // (the pack price was divided out into baseCostCents above), so on_hand/COGS stay in base
        // units while the InventoryItemPack carries the size (ADR-0737 D1).
        const purchaseCostCents = Math.round(baseCostCents);
        // Optional par from the scan review's new-item fields. par_max is the overstock
        // ceiling + reorder target; 0 = "no ceiling" (see InventoryItemSchema.par_max). Honor a
        // max only when it's a real ceiling (>= min) — a sub-min max is treated as unset rather
        // than 400-ing the whole batch over one floor typo (mirrors the no-refine schema note).
        const parMin = line.par_min ?? 0;
        const rawMax = line.par_max ?? 0;
        const parMax = rawMax >= parMin ? rawMax : 0;
        item = await tx.inventoryItem.create({
          data: {
            id,
            sku: id,
            name: line.name,
            categoryId: line.category,
            unit: line.unit,
            onHand: 0,
            parMin,
            parMax,
            costCents: baseCostCents,
            vendor: submission.vendor ?? "",
            shelfDays: 999,
            purchaseUnit: "",
            packQty: 1,
            purchaseCostCents,
            lastCounted: dateLabel(),
            flagged86: false,
            // AI-suggested emoji from the scan review (optional); "" = no icon, falls back
            // to the category glyph in the UI. Only set on inline create — a matched item's
            // icon is never touched by a receive.
            icon: line.icon ?? ""
          }
        });
        created += 1;
        // Remember this freshly-created item for sibling lines of the same group (ADR-882).
        if (line.item_group) {
          groupItems.set(line.item_group, item.id);
        }
      }
      if (!item) {
        // sku didn't match and not enough to create — skip (mirrors PO receive).
        continue;
      }

      // Resolve the pack this line books into: a NEW pack to create (ADR-882), an EXISTING pack_id,
      // or none. A new_pack line's qty is a number of packs priced per pack -> convert to base
      // units + per-base cost; an existing pack_id goes through the shared resolver (a pack_id for
      // an item without that pack -> 400); a bare line passes through (the ADR-0592 client-converted
      // scan path). Then teach the scanner this vendor's wording -> (item, pack) (ADR-0586 D2 /
      // ADR-882), for matched AND created lines, keyed on the confirmed mapping independent of qty
      // (so even a 0-qty confirm is remembered).
      let resolvedPackId: string | null;
      let conv: { qty: number; unitCostCents: number | undefined };
      if (line.new_pack) {
        const pack = await ensureItemPack(tx, item.id, line.new_pack.label, line.new_pack.base_qty_per_pack);
        resolvedPackId = pack.id;
        conv = {
          qty: line.qty * pack.baseQtyPerPack,
          unitCostCents:
            line.unit_cost_cents == null ? undefined : roundCost(line.unit_cost_cents / pack.baseQtyPerPack)
        };
      } else {
        conv = await resolvePackConversion(tx, item.id, line.pack_id, line.qty, line.unit_cost_cents);
        resolvedPackId = line.pack_id ?? null;
      }
      await learnAlias(tx, item.id, submission.vendor, resolvedPackId, { ...line, unit_cost_cents: conv.unitCostCents });

      const state = await tx.inventoryItemState.findUnique({
        where: { locationId_itemId: { locationId, itemId: item.id } }
      });
      const current = effectiveState(item, state);
      const nextOnHand = clampOnHand(current.onHand + conv.qty);
      const delta = nextOnHand - current.onHand;
      if (delta === 0) {
        continue;
      }
      await tx.inventoryItemState.upsert({
        where: { locationId_itemId: { locationId, itemId: item.id } },
        create: { locationId, itemId: item.id, ...current, onHand: nextOnHand },
        update: { onHand: nextOnHand }
      });
      // `index` keeps the source_ref unique per line, so an invoice that lists the
      // same item twice receives both quantities instead of colliding on the index.
      await tx.inventoryStockMovement.create({
        data: {
          locationId,
          itemId: item.id,
          delta,
          reason: "receive",
          sourceRef: `adhoc:${ref}:${index}`,
          actor: submission.who
        }
      });
      received += 1;
    }

    await tx.inventoryActivityEntry.create({
      data: {
        locationId,
        at: timeLabel(),
        who: submission.who,
        action: "received",
        what: submission.vendor ? `Ad-hoc receipt from ${submission.vendor}` : "Ad-hoc receipt",
        note: `${received} line(s) received${created ? `, ${created} item(s) created` : ""}`
      }
    });

    // Archive the scanned receipt (receipt-archive). Only when the receive carried an
    // image (archive provided). A frozen jsonb snapshot of the confirmed lines + the R2
    // object key, keyed (location, ref) so it dedups like everything else. imageKey may
    // be null — archiving the bytes is best-effort, the log row is not. The cost total
    // mirrors what the operator confirmed (qty x per-unit cost), rounded to whole cents.
    if (archive) {
      const snapshotLines: InventoryReceiptScanLine[] = submission.lines.map((line) => {
        const snap: InventoryReceiptScanLine = {
          description: line.description ?? line.name ?? "",
          qty: line.qty
        };
        if (line.unit !== undefined) {
          snap.unit = line.unit;
        }
        if (line.unit_cost_cents !== undefined) {
          snap.unit_cost_cents = line.unit_cost_cents;
        }
        return snap;
      });
      const totalCents = Math.round(
        submission.lines.reduce((sum, line) => sum + (line.unit_cost_cents ?? 0) * line.qty, 0)
      );
      await tx.inventoryReceiptScan.upsert({
        where: { locationId_ref: { locationId, ref } },
        create: {
          locationId,
          ref,
          vendor: submission.vendor ?? null,
          invoiceDate: submission.invoice_date ?? null,
          who: submission.who,
          imageKey: archive.imageKey,
          contentType: archive.contentType,
          lineCount: submission.lines.length,
          totalCents,
          lines: snapshotLines
        },
        update: { imageKey: archive.imageKey, contentType: archive.contentType }
      });
    }

    return { received, created };
  });
}

// Serialize an archived receipt scan row to its read DTO. has_image is derived (the
// list never carries bytes — the browser fetches them from .../receipts/:id/image,
// mirroring item photos); lines comes back as the frozen jsonb snapshot.
function serializeReceiptScan(row: ReceiptScanRow): InventoryReceiptScan {
  return {
    id: row.id,
    vendor: row.vendor ?? undefined,
    invoice_date: row.invoiceDate ?? undefined,
    who: row.who,
    captured_at: row.capturedAt.toISOString(),
    line_count: row.lineCount,
    total_cents: row.totalCents,
    has_image: row.imageKey !== null,
    lines: Array.isArray(row.lines) ? (row.lines as unknown as InventoryReceiptScanLine[]) : []
  };
}

// List archived receipt scans for the "history" view, newest first (receipt-archive).
// from/to are optional opaque "YYYY-MM-DD" bounds on the capture day (inclusive),
// interpreted in UTC — coarse enough for a "which day" filter; the UI groups by day.
// Bounded take so a long history can't soak the route; the UI paginates by date range.
export async function listReceiptScans(
  prisma: PrismaClient,
  locationId: string = DEFAULT_LOCATION_ID,
  opts: { from?: string; to?: string; limit?: number } = {}
): Promise<InventoryReceiptScan[]> {
  const capturedAt: { gte?: Date; lte?: Date } = {};
  if (opts.from) {
    capturedAt.gte = new Date(`${opts.from}T00:00:00.000Z`);
  }
  if (opts.to) {
    capturedAt.lte = new Date(`${opts.to}T23:59:59.999Z`);
  }
  const rows = await prisma.inventoryReceiptScan.findMany({
    where: {
      locationId,
      ...(opts.from || opts.to ? { capturedAt } : {})
    },
    orderBy: { capturedAt: "desc" },
    take: Math.min(opts.limit ?? 200, 500)
  });
  return rows.map(serializeReceiptScan);
}

// Resolve the stored image for one receipt scan (for the byte-serving route). Returns
// null when the scan is unknown, belongs to another location, or has no archived image
// (best-effort archive miss) — all a 404 at the route. Location-scoped so a guessed id
// can't read another store's invoice.
export async function getReceiptScanImage(
  prisma: PrismaClient,
  id: string,
  locationId: string = DEFAULT_LOCATION_ID
): Promise<{ imageKey: string; contentType: string } | null> {
  const row = await prisma.inventoryReceiptScan.findFirst({
    where: { id, locationId },
    select: { imageKey: true, contentType: true }
  });
  if (!row || !row.imageKey) {
    return null;
  }
  return { imageKey: row.imageKey, contentType: row.contentType ?? "application/octet-stream" };
}

// One sold menu item from a Clover order. `lineItemId` is the Clover order
// line-item id — the idempotency key for this sale event. `recipeId` is the
// inventory recipe (menu item) it maps to; the future depletion worker resolves
// that mapping (by clover_item_id, ADR-0028) before calling this.
export interface SaleDepletionLine {
  lineItemId: string;
  recipeId: string;
  quantity: number;
  // Names of the Clover modifiers chosen on this sold line (ADR-0028 modifier
  // depletion). Matched to the recipe's InventoryRecipeModifier.optionName; absent
  // / empty means a plain sale that depletes only the base BOM.
  modifierNames?: string[];
}

export interface DepleteFromSalesResult {
  applied: number;
  skipped: number;
  // Items this depletion took from at-or-above their minimum par to below it — the
  // one-shot downward crossing (Phase 5c low-stock producer), aggregated across all
  // lines and deduped by item. Optional + present only when there were crossings
  // (matching ApplyCountsResult.lowStock), so a no-crossing run is still exactly
  // `{ applied, skipped }`. The sync-sales route emits one low-stock notification per
  // entry and strips it from the API response (it is an internal signal).
  lowStock?: Array<{ itemId: string; itemName: string; onHand: number; parMin: number }>;
}

// Sales-driven depletion (ADR-0028): expand each sold menu item into its recipe
// BOM — plus any chosen modifiers — and append `sale` movements. Consumption is
// AGGREGATED per component item across the base BOM and the matched modifiers, so a
// modifier that draws from the same sku as the base collapses into ONE movement:
// the unique (location, reason, source_ref, item_id) index permits only one `sale`
// row per item per line, so a second create on the same sku would otherwise 500.
// A modifier matches when its recipe option name equals a selected name (the editor
// keys modifiers by the Clover option name); `qty_delta` is signed, so "No Boba"
// (-2) credits stock back. Idempotent per Clover line item — a replayed line is
// skipped (a prior `sale` movement with the same source_ref exists; the unique index
// is the DB backstop). Each line commits in its own transaction so one bad line
// can't roll back a whole poll batch. Unknown recipe / missing component items are
// skipped (the caller surfaces those). on_hand is clamped at 0, matching
// waste/receive; oversell (negative theoretical stock) is reconciled separately.
export async function depleteFromSales(
  prisma: PrismaClient,
  lines: SaleDepletionLine[],
  locationId: string = DEFAULT_LOCATION_ID
): Promise<DepleteFromSalesResult> {
  let applied = 0;
  let skipped = 0;
  // Low-stock crossings, aggregated across all lines and deduped by item (set-once):
  // depletion only decreases stock, but a stock-crediting modifier ("No Boba", -qty)
  // could lift an item back above par on a later line, so the dedup keeps a single
  // alert per item per batch. Merged only from COMMITTED transactions.
  const lowStockByItem = new Map<string, { itemId: string; itemName: string; onHand: number; parMin: number }>();

  for (const line of lines) {
    const outcome = await prisma.$transaction(async (tx) => {
      const crossings: Array<{ itemId: string; itemName: string; onHand: number; parMin: number }> = [];
      await lockLocationStock(tx, locationId);
      const already = await tx.inventoryStockMovement.findFirst({
        where: { locationId, reason: "sale", sourceRef: line.lineItemId },
        select: { id: true }
      });
      if (already) {
        return { didApply: false, crossings };
      }
      const recipe = await tx.inventoryRecipe.findUnique({
        where: { id: line.recipeId },
        include: { lines: true, modifiers: true }
      });
      if (!recipe) {
        return { didApply: false, crossings };
      }
      // Aggregate per-component consumption: base BOM + every modifier whose option
      // name matches a selected one (case-insensitive). Combining into one delta per
      // sku is what keeps the single-movement-per-(line,item) idempotency key intact.
      const selected = new Set((line.modifierNames ?? []).map((n) => n.trim().toLowerCase()));
      const consumption = new Map<string, number>();
      for (const bom of recipe.lines) {
        consumption.set(bom.sku, (consumption.get(bom.sku) ?? 0) + bom.qty * line.quantity);
      }
      for (const mod of recipe.modifiers) {
        if (selected.has(mod.optionName.trim().toLowerCase())) {
          consumption.set(mod.sku, (consumption.get(mod.sku) ?? 0) + mod.qtyDelta * line.quantity);
        }
      }
      for (const [sku, qty] of consumption) {
        const item = await tx.inventoryItem.findUnique({ where: { id: sku } });
        if (!item) {
          continue;
        }
        const state = await tx.inventoryItemState.findUnique({
          where: { locationId_itemId: { locationId, itemId: item.id } }
        });
        const current = effectiveState(item, state);
        const nextOnHand = clampOnHand(current.onHand - qty);
        await tx.inventoryItemState.upsert({
          where: { locationId_itemId: { locationId, itemId: item.id } },
          create: { locationId, itemId: item.id, ...current, onHand: nextOnHand },
          update: { onHand: nextOnHand }
        });
        await tx.inventoryStockMovement.create({
          data: {
            locationId,
            itemId: item.id,
            delta: nextOnHand - current.onHand,
            reason: "sale",
            sourceRef: line.lineItemId,
            actor: "clover-sale"
          }
        });
        // Low-stock crossing — same one-shot downward-cross signal the waste/count
        // producers emit (a sale is just another stock-decrease path). Only the
        // crossing fires, not every subsequent drop while already low.
        if (crossedBelowPar(current.onHand, nextOnHand, current.parMin)) {
          crossings.push({ itemId: item.id, itemName: item.name, onHand: nextOnHand, parMin: current.parMin });
        }
      }
      return { didApply: true, crossings };
    });
    if (outcome.didApply) {
      applied += 1;
      for (const c of outcome.crossings) {
        if (!lowStockByItem.has(c.itemId)) {
          lowStockByItem.set(c.itemId, c);
        }
      }
    } else {
      skipped += 1;
    }
  }

  const lowStock = [...lowStockByItem.values()];
  return { applied, skipped, ...(lowStock.length > 0 ? { lowStock } : {}) };
}

// One sold menu item as it arrives from analytics' sold-items feed. Resolved to a
// recipe by provider catalog id first — `cloverItemId` for a Clover store,
// `squareCatalogObjectId` for a Square store (exactly one is set, per the store's
// provider) — then by `itemName` (fallback). Provider id is preferred because it
// is rename-proof.
export interface SoldMenuItem {
  lineItemId: string;
  cloverItemId?: string;
  squareCatalogObjectId?: string;
  itemName: string;
  quantity: number;
  // Names of the Clover modifiers selected on this sold line (ADR-0028). Carried
  // through to the depletion line so matched modifiers adjust their mapped stock.
  modifierNames?: string[];
}

export interface DepleteSoldItemsResult {
  result: DepleteFromSalesResult;
  // Sold items with no matching recipe — the caller/worker surfaces these
  // (a missing recipe/BOM means that sale silently depletes nothing).
  unmatched: string[];
}

// Resolve sold menu items to inventory recipes — by provider catalog id first
// (rename-proof, ADR-0028 sub-decision i): `clover_item_id` for a Clover store or
// `square_catalog_object_id` for a Square store, then by name (fallback, sub-decision
// ii) — and deplete their BOMs. A Square sold line carries only the Square object id
// and a Clover one only clover_item_id, so trying both id maps is safe (no ambiguity).
// Delegates to depleteFromSales, so it inherits per-line idempotency. Unmatched items
// are returned, not thrown — one unknown item must not block depleting the rest of a
// sales batch.
export async function depleteSoldItems(
  prisma: PrismaClient,
  soldItems: SoldMenuItem[],
  locationId: string = DEFAULT_LOCATION_ID
): Promise<DepleteSoldItemsResult> {
  const recipes = await prisma.inventoryRecipe.findMany({
    select: { id: true, name: true, cloverItemId: true, squareCatalogObjectId: true }
  });
  const idByCloverId = new Map(
    recipes.filter((r) => r.cloverItemId).map((r) => [r.cloverItemId as string, r.id])
  );
  const idBySquareObjectId = new Map(
    recipes.filter((r) => r.squareCatalogObjectId).map((r) => [r.squareCatalogObjectId as string, r.id])
  );
  const idByName = new Map(recipes.map((r) => [r.name.trim().toLowerCase(), r.id]));

  const lines: SaleDepletionLine[] = [];
  const unmatched: string[] = [];
  for (const sold of soldItems) {
    const recipeId =
      (sold.cloverItemId ? idByCloverId.get(sold.cloverItemId) : undefined) ??
      (sold.squareCatalogObjectId ? idBySquareObjectId.get(sold.squareCatalogObjectId) : undefined) ??
      idByName.get(sold.itemName.trim().toLowerCase());
    if (!recipeId) {
      unmatched.push(sold.itemName);
      continue;
    }
    lines.push({
      lineItemId: sold.lineItemId,
      recipeId,
      quantity: sold.quantity,
      ...(sold.modifierNames ? { modifierNames: sold.modifierNames } : {})
    });
  }

  const result = await depleteFromSales(prisma, lines, locationId);
  return { result, unmatched };
}

// A Clover catalog item to mirror as an inventory recipe.
export interface CloverMenuItem {
  cloverItemId: string;
  name: string;
  category: string;
  priceCents: number;
}

export interface SyncRecipesResult {
  created: number;
  updated: number;
}

// Mirror Clover catalog items as inventory recipes (ADR-0028), keyed by
// clover_item_id (the recipe id is the Clover item id for synced rows). Upsert
// refreshes name/category/sell price on re-sync and leaves BOM `lines` untouched
// (those are entered separately via the BOM editor). Idempotent. The caller is
// responsible for filtering out junk / non-recipe Clover items first.
export async function syncRecipesFromClover(
  prisma: PrismaClient,
  items: CloverMenuItem[]
): Promise<SyncRecipesResult> {
  let created = 0;
  let updated = 0;
  for (const item of items) {
    const existing = await prisma.inventoryRecipe.findUnique({
      where: { cloverItemId: item.cloverItemId },
      select: { id: true }
    });
    await prisma.inventoryRecipe.upsert({
      where: { cloverItemId: item.cloverItemId },
      create: {
        id: item.cloverItemId,
        name: item.name,
        category: item.category,
        sellCents: item.priceCents,
        cloverItemId: item.cloverItemId
      },
      update: { name: item.name, category: item.category, sellCents: item.priceCents }
    });
    if (existing) {
      updated += 1;
    } else {
      created += 1;
    }
  }
  return { created, updated };
}

// A Square catalog item to mirror as an inventory recipe (store #2). The Square
// sibling of CloverMenuItem; `squareCatalogObjectId` is the BARE Square CatalogObject
// id (the sold-items feed's square_catalog_item_id), used as the depletion join key.
export interface SquareMenuItem {
  squareCatalogObjectId: string;
  name: string;
  category: string;
  priceCents: number;
}

// Mirror Square catalog items as inventory recipes (store #2; docs/square-onboarding.md),
// keyed by square_catalog_object_id. The Square sibling of syncRecipesFromClover; same
// upsert semantics (refresh name/category/sell price on re-sync, leave BOM `lines`
// untouched — entered separately via the editor; idempotent). The ONE difference is
// the recipe `id`: a Clover synced row uses the bare clover id as its PK, so to never
// collide with one, a Square row namespaces its PK as `square:{id}` while storing the
// bare id in squareCatalogObjectId (the join key). The caller filters non-recipe items
// (fees, gift cards, $0 placeholders) first, same as the Clover path.
export async function syncRecipesFromSquare(
  prisma: PrismaClient,
  items: SquareMenuItem[]
): Promise<SyncRecipesResult> {
  let created = 0;
  let updated = 0;
  for (const item of items) {
    const existing = await prisma.inventoryRecipe.findUnique({
      where: { squareCatalogObjectId: item.squareCatalogObjectId },
      select: { id: true }
    });
    await prisma.inventoryRecipe.upsert({
      where: { squareCatalogObjectId: item.squareCatalogObjectId },
      create: {
        id: `square:${item.squareCatalogObjectId}`,
        name: item.name,
        category: item.category,
        sellCents: item.priceCents,
        squareCatalogObjectId: item.squareCatalogObjectId
      },
      update: { name: item.name, category: item.category, sellCents: item.priceCents }
    });
    if (existing) {
      updated += 1;
    } else {
      created += 1;
    }
  }
  return { created, updated };
}

// A page of sold menu items from the sales source (the analytics line-item feed),
// plus the cursor to resume after. `nextCursor === null` means "leave the
// watermark unchanged" (nothing new).
export interface SoldItemsPage {
  soldItems: SoldMenuItem[];
  nextCursor: string | null;
}

// Fetches sold items recorded after an opaque cursor. Injected so the poll loop
// is decoupled from the analytics HTTP client (the real impl is
// buildAnalyticsSoldItemsFetcher in lib/analytics-client.ts). The
// cursor is opaque here — its meaning belongs to the source.
export type SoldItemsFetcher = (cursor: string | null) => Promise<SoldItemsPage>;

export interface DepletionPollResult {
  applied: number;
  skipped: number;
  unmatched: string[];
  cursor: string | null;
  // Low-stock crossings from this poll (Phase 5c), carried up from
  // DepleteFromSalesResult — present only when sales took an item below par. The
  // sync-sales route emits one notification per entry and strips it from the response.
  lowStock?: Array<{ itemId: string; itemName: string; onHand: number; parMin: number }>;
}

// One sales-depletion poll cycle (ADR-0028): read the stored watermark, fetch
// sold items after it, deplete their BOMs (resolved by name), then persist the
// advanced cursor. End-to-end safe under partial failure: depleteFromSales
// dedupes per Clover line item, so if the cursor write fails the next poll
// re-fetches and the already-applied lines are skipped. No wrapping transaction
// is needed for that reason. The fetcher is injected; the real analytics HTTP
// client (lib/analytics-client.ts) is wired into the POST /api/inventory/sync-sales route.
export async function runDepletionPoll(
  prisma: PrismaClient,
  fetchSoldItems: SoldItemsFetcher,
  locationId: string = DEFAULT_LOCATION_ID
): Promise<DepletionPollResult> {
  const state = await prisma.inventoryDepletionCursor.findUnique({ where: { id: "singleton" } });
  const cursor = state?.cursor ?? null;

  const { soldItems, nextCursor } = await fetchSoldItems(cursor);
  const { result, unmatched } = await depleteSoldItems(prisma, soldItems, locationId);

  if (nextCursor !== null && nextCursor !== cursor) {
    await prisma.inventoryDepletionCursor.upsert({
      where: { id: "singleton" },
      create: { id: "singleton", cursor: nextCursor },
      update: { cursor: nextCursor }
    });
  }

  return { ...result, unmatched, cursor: nextCursor ?? cursor };
}

export interface RecipeBomLine {
  sku: string; // the component InventoryItem id consumed by this recipe
  qty: number; // amount consumed per one unit of the recipe
}

// Replace a recipe's BOM (ADR-0028). Full-set semantics: clears the recipe's
// existing lines and writes the new set in one transaction. Used by the BOM
// importer and (later) the in-app editor. Returns the new line count, or null if
// the recipe doesn't exist.
export async function setRecipeBom(
  prisma: PrismaClient,
  recipeId: string,
  lines: RecipeBomLine[]
): Promise<number | null> {
  return prisma.$transaction(async (tx) => {
    const recipe = await tx.inventoryRecipe.findUnique({
      where: { id: recipeId },
      select: { id: true }
    });
    if (!recipe) {
      return null;
    }
    await tx.inventoryRecipeLine.deleteMany({ where: { recipeId } });
    if (lines.length > 0) {
      await tx.inventoryRecipeLine.createMany({
        data: lines.map((l) => ({ recipeId, sku: l.sku, qty: l.qty }))
      });
    }
    return lines.length;
  });
}

// Full recipe detail for the editor: base lines + modifier consumption + the
// Clover link. Returns null if the recipe doesn't exist.
export async function getRecipeDetail(
  prisma: PrismaClient,
  recipeId: string
): Promise<InventoryRecipeDetail | null> {
  const recipe = await prisma.inventoryRecipe.findUnique({
    where: { id: recipeId },
    include: { lines: true, modifiers: true }
  });
  return recipe ? serialize.toRecipeDetail(recipe) : null;
}

// Save a recipe from the editor: full-set replace of base lines AND per-modifier
// consumption, plus optional name/category/sell edits — all in ONE transaction so
// a partial save can't leave the BOM half-written. Returns the saved detail, or
// null if the recipe doesn't exist.
export async function saveRecipe(
  prisma: PrismaClient,
  recipeId: string,
  data: InventoryRecipeSave
): Promise<InventoryRecipeDetail | null> {
  const saved = await prisma.$transaction(async (tx) => {
    const recipe = await tx.inventoryRecipe.findUnique({
      where: { id: recipeId },
      select: { id: true }
    });
    if (!recipe) {
      return null;
    }
    const fields: { name?: string; category?: string; sellCents?: number } = {};
    if (data.name !== undefined) {
      fields.name = data.name;
    }
    if (data.category !== undefined) {
      fields.category = data.category;
    }
    if (data.sell_cents !== undefined) {
      fields.sellCents = data.sell_cents;
    }
    if (Object.keys(fields).length > 0) {
      await tx.inventoryRecipe.update({ where: { id: recipeId }, data: fields });
    }
    await tx.inventoryRecipeLine.deleteMany({ where: { recipeId } });
    if (data.lines.length > 0) {
      await tx.inventoryRecipeLine.createMany({
        data: data.lines.map((l) => ({ recipeId, sku: l.sku, qty: l.qty }))
      });
    }
    await tx.inventoryRecipeModifier.deleteMany({ where: { recipeId } });
    if (data.modifiers.length > 0) {
      await tx.inventoryRecipeModifier.createMany({
        data: data.modifiers.map((m) => ({
          recipeId,
          groupName: m.group,
          optionName: m.option,
          sku: m.sku,
          qtyDelta: m.qty
        }))
      });
    }
    return tx.inventoryRecipe.findUnique({
      where: { id: recipeId },
      include: { lines: true, modifiers: true }
    });
  });
  return saved ? serialize.toRecipeDetail(saved) : null;
}

// Create a new recipe (menu item) header — name/category/sell with an empty BOM. The
// editor (saveRecipe) fills in lines + modifiers afterward. id is server-generated;
// mirrors createItem. Returns the new (empty-BOM) detail.
export async function createRecipe(
  prisma: PrismaClient,
  input: InventoryRecipeCreate
): Promise<InventoryRecipeDetail> {
  const recipe = await prisma.inventoryRecipe.create({
    data: {
      id: `recipe-${randomUUID()}`,
      name: input.name,
      category: input.category,
      sellCents: input.sell_cents
    },
    include: { lines: true, modifiers: true }
  });
  return serialize.toRecipeDetail(recipe);
}

// Save an ingredient/packaging item from the catalog editor (S3). Updates the
// brand-catalog fields (name, unit, vendor, shelf life, and the purchase->usage
// conversion). The per-usage cost_cents is re-derived (= purchaseCostCents /
// packQty) ONLY when a real purchase price is present, so editing just a name can
// never wipe an existing cost. Returns the updated item DTO, or null if missing.
// par levels + on_hand are per-location state and are not touched here.
export async function saveItem(
  prisma: PrismaClient,
  id: string,
  data: InventoryItemSave
): Promise<InventoryItem | null> {
  const existing = await prisma.inventoryItem.findUnique({ where: { id } });
  if (!existing) {
    return null;
  }
  const purchaseCostCents = data.purchase_cost_cents ?? existing.purchaseCostCents;
  const packQty = data.pack_qty ?? existing.packQty;
  const costCents =
    purchaseCostCents > 0 && packQty > 0 ? roundCost(purchaseCostCents / packQty) : existing.costCents;
  const updated = await prisma.inventoryItem.update({
    where: { id },
    data: {
      ...(data.name !== undefined ? { name: data.name } : {}),
      ...(data.category !== undefined ? { categoryId: data.category } : {}),
      ...(data.unit !== undefined ? { unit: data.unit } : {}),
      ...(data.unit_kind !== undefined ? { unitKind: data.unit_kind } : {}),
      ...(data.vendor !== undefined ? { vendor: data.vendor } : {}),
      ...(data.shelf_days !== undefined ? { shelfDays: data.shelf_days } : {}),
      ...(data.purchase_unit !== undefined ? { purchaseUnit: data.purchase_unit } : {}),
      ...(data.icon !== undefined ? { icon: data.icon } : {}),
      packQty,
      purchaseCostCents,
      costCents
    }
  });
  return serialize.toItem(updated);
}

export interface CreateItemResult {
  ok: boolean;
  item?: InventoryItem;
  reason?: "sku_taken";
}

// Create a new catalog item (ADR catalog-management D1, "Add item"). id is always
// server-generated; sku defaults to the id when omitted and is unique (a clash →
// sku_taken → 409 at the route). cost_cents derives from purchase_cost_cents/pack_qty
// like the editor. par seeds the brand-catalog defaults; on_hand starts at 0.
export async function createItem(
  prisma: PrismaClient,
  input: InventoryItemCreate
): Promise<CreateItemResult> {
  const id = `item-${randomUUID()}`;
  const sku = (input.sku ?? "").trim() || id;
  const purchaseCostCents = input.purchase_cost_cents ?? 0;
  const packQty = input.pack_qty ?? 1;
  const costCents = purchaseCostCents > 0 && packQty > 0 ? roundCost(purchaseCostCents / packQty) : 0;
  try {
    await ensureCanonicalCategories(prisma);
    const item = await prisma.inventoryItem.create({
      data: {
        id,
        sku,
        name: input.name,
        categoryId: input.category,
        unit: input.unit,
        unitKind: input.unit_kind ?? "count",
        onHand: 0,
        parMin: input.par_min,
        parMax: input.par_max,
        costCents,
        vendor: input.vendor ?? "",
        shelfDays: input.shelf_days ?? 999,
        purchaseUnit: input.purchase_unit ?? "",
        icon: input.icon ?? "",
        packQty,
        purchaseCostCents,
        lastCounted: dateLabel(),
        flagged86: false
      }
    });
    return { ok: true, item: serialize.toItem(item, null) };
  } catch (error) {
    if (isUniqueViolation(error)) {
      return { ok: false, reason: "sku_taken" };
    }
    throw error;
  }
}

// Item photo read. Returns the stored bytes + content type, or null when the item
// has no photo. The route streams these back to the browser (GET .../image).
export async function getItemImage(
  prisma: PrismaClient,
  itemId: string
): Promise<{ contentType: string; data: Buffer } | null> {
  const row = await prisma.inventoryItemImage.findUnique({ where: { itemId } });
  if (!row) {
    return null;
  }
  return { contentType: row.contentType, data: Buffer.from(row.data) };
}

// Upsert an item photo (floor "edit item" / backoffice). Returns false when the
// item itself doesn't exist (404 at the route) so we never create an orphan blob
// for a missing item. Stores one row per item — re-upload replaces.
export async function setItemImage(
  prisma: PrismaClient,
  itemId: string,
  contentType: string,
  data: Uint8Array
): Promise<boolean> {
  const item = await prisma.inventoryItem.findUnique({ where: { id: itemId }, select: { id: true } });
  if (!item) {
    return false;
  }
  // Copy into a fresh ArrayBuffer-backed Uint8Array — Prisma's Bytes column is
  // typed Uint8Array<ArrayBuffer>, which a Node Buffer (ArrayBufferLike) doesn't
  // satisfy directly.
  const bytes = new Uint8Array(data);
  await prisma.inventoryItemImage.upsert({
    where: { itemId },
    create: { itemId, contentType, data: bytes },
    update: { contentType, data: bytes }
  });
  return true;
}

// Remove an item photo. Idempotent: a no-op when none exists (the item falls back
// to its emoji glyph). Returns false when the item doesn't exist.
export async function deleteItemImage(prisma: PrismaClient, itemId: string): Promise<boolean> {
  const item = await prisma.inventoryItem.findUnique({ where: { id: itemId }, select: { id: true } });
  if (!item) {
    return false;
  }
  await prisma.inventoryItemImage.deleteMany({ where: { itemId } });
  return true;
}

// Floor-auth security settings (singleton). Defaults to allow-all (empty allowlist)
// when the row is absent, so a never-written DB never blocks the floor.
export async function getSecuritySettings(
  prisma: PrismaClient
): Promise<InventorySecuritySettings> {
  const row = await prisma.inventorySecuritySetting.findUnique({ where: { id: "singleton" } });
  return { crew_ip_allowlist: row?.crewIpAllowlist ?? "" };
}

export async function saveSecuritySettings(
  prisma: PrismaClient,
  data: InventorySecuritySettingsSave
): Promise<InventorySecuritySettings> {
  const row = await prisma.inventorySecuritySetting.upsert({
    where: { id: "singleton" },
    create: { id: "singleton", crewIpAllowlist: data.crew_ip_allowlist },
    update: { crewIpAllowlist: data.crew_ip_allowlist }
  });
  return { crew_ip_allowlist: row.crewIpAllowlist };
}

// Create a vendor (ADR catalog-management D2). id is server-generated. Operator-set
// fields only; the performance metrics start at 0/[] and are filled by PO
// reconciliation later, not hand-entered.
export async function createVendor(
  prisma: PrismaClient,
  input: InventoryVendorSave
): Promise<InventoryVendor> {
  const vendor = await prisma.inventoryVendor.create({
    data: {
      id: `vendor-${randomUUID()}`,
      name: input.name,
      type: input.type ?? "",
      contact: input.contact ?? "",
      phone: input.phone ?? "",
      email: input.email ?? "",
      account: input.account ?? "",
      terms: input.terms ?? "",
      minOrderCents: input.min_order_cents ?? 0,
      cutoff: input.cutoff ?? "",
      deliveryDays: input.delivery_days ?? [],
      categories: input.categories ?? [],
      fillRate: 0,
      onTime: 0,
      priceStability: 0,
      credits90d: 0,
      spend30d: 0,
      trend4w: [],
      preferred: input.preferred ?? false,
      tags: input.tags ?? []
    }
  });
  return serialize.toVendor(vendor);
}

// Edit a vendor's operator-set fields (ADR catalog-management D2). name is always
// applied; the rest only when present. Performance metrics + id + timestamps untouched.
// Returns null when the vendor is missing (404 at the route).
export async function updateVendor(
  prisma: PrismaClient,
  id: string,
  input: InventoryVendorSave
): Promise<InventoryVendor | null> {
  const existing = await prisma.inventoryVendor.findUnique({ where: { id } });
  if (!existing) {
    return null;
  }
  const vendor = await prisma.inventoryVendor.update({
    where: { id },
    data: {
      name: input.name,
      ...(input.type !== undefined ? { type: input.type } : {}),
      ...(input.contact !== undefined ? { contact: input.contact } : {}),
      ...(input.phone !== undefined ? { phone: input.phone } : {}),
      ...(input.email !== undefined ? { email: input.email } : {}),
      ...(input.account !== undefined ? { account: input.account } : {}),
      ...(input.terms !== undefined ? { terms: input.terms } : {}),
      ...(input.min_order_cents !== undefined ? { minOrderCents: input.min_order_cents } : {}),
      ...(input.cutoff !== undefined ? { cutoff: input.cutoff } : {}),
      ...(input.delivery_days !== undefined ? { deliveryDays: input.delivery_days } : {}),
      ...(input.categories !== undefined ? { categories: input.categories } : {}),
      ...(input.preferred !== undefined ? { preferred: input.preferred } : {}),
      ...(input.tags !== undefined ? { tags: input.tags } : {})
    }
  });
  return serialize.toVendor(vendor);
}

// Archive / restore a vendor (ADR catalog-management D2, soft-delete). Returns null
// when the vendor is missing (404 at the route).
export async function setVendorArchived(
  prisma: PrismaClient,
  id: string,
  archived: boolean
): Promise<InventoryVendor | null> {
  const existing = await prisma.inventoryVendor.findUnique({ where: { id } });
  if (!existing) {
    return null;
  }
  const vendor = await prisma.inventoryVendor.update({
    where: { id },
    data: { archivedAt: archived ? new Date() : null }
  });
  return serialize.toVendor(vendor);
}

// A PO line referenced an item id that isn't in the catalog (2026-06-16 audit #6).
// Routes map this to 400. Without it a PO with a phantom sku is created but can
// never fully receive (the receive flow silently skips an unknown sku) and its
// total bakes in a line that resolves to no item.
export class UnknownItemsError extends Error {
  constructor(public readonly skus: string[]) {
    super(`unknown item sku(s): ${skus.join(", ")}`);
    this.name = "UnknownItemsError";
  }
}

// Guard PO create/edit: every line sku must resolve to a catalog item. Archived
// items are allowed — the row is retained and stays receivable; only a truly
// nonexistent id is rejected. Items are never hard-deleted, so a pre-check (rather
// than a DB FK) is sufficient and lets us return the offending skus.
async function assertItemsExist(
  db: Pick<PrismaClient, "inventoryItem">,
  skus: string[]
): Promise<void> {
  const unique = [...new Set(skus)];
  const found = await db.inventoryItem.findMany({
    where: { id: { in: unique } },
    select: { id: true }
  });
  const foundIds = new Set(found.map((i) => i.id));
  const missing = unique.filter((sku) => !foundIds.has(sku));
  if (missing.length > 0) {
    throw new UnknownItemsError(missing);
  }
}

// Create a purchase order (ADR catalog-management D3, "New PO"). The new PO is
// `submitted` (the status enum has no draft phase); placed date, line count, and
// total are derived. PO lines persist sku + qty only (the existing model has no
// per-line cost), so unit_cost_cents feeds the order total only. The receive flow is
// unchanged and already idempotent. Returns the detail shape so the UI can show it.
export async function createPurchaseOrder(
  prisma: PrismaClient,
  input: InventoryPurchaseOrderCreate,
  locationId: string = DEFAULT_LOCATION_ID
): Promise<InventoryPurchaseOrderDetail> {
  await assertItemsExist(prisma, input.lines.map((line) => line.sku));
  const totalCents = Math.round(
    input.lines.reduce((sum, line) => sum + line.qty_ordered * line.unit_cost_cents, 0)
  );
  const po = await prisma.inventoryPurchaseOrder.create({
    data: {
      id: `PO-${randomUUID().slice(0, 8).toUpperCase()}`,
      locationId,
      vendor: input.vendor,
      placed: dateLabel(),
      expected: input.expected ?? "",
      lines: input.lines.length,
      status: "submitted",
      totalCents,
      lineItems: {
        create: input.lines.map((line) => ({
          locationId,
          sku: line.sku,
          qtyOrdered: line.qty_ordered,
          qtyReceived: 0,
          unitCostCents: line.unit_cost_cents
        }))
      }
    },
    include: { lineItems: true }
  });
  const items = await prisma.inventoryItem.findMany({
    where: { id: { in: input.lines.map((line) => line.sku) } }
  });
  const itemsById = new Map(items.map((item) => [item.id, item]));
  return serialize.toPurchaseOrderDetail(po, po.lineItems, itemsById);
}

// An edit/cancel/receive hit a PO whose status forbids it (received is immutable,
// cancelled is terminal). Routes map this to 409 — distinct from 404 so the UI can
// say "someone already received this" instead of "not found".
export class PoStateConflictError extends Error {
  constructor(public readonly status: string) {
    super(`purchase order is ${status}`);
    this.name = "PoStateConflictError";
  }
}

const EDITABLE_PO_STATUSES = new Set(["submitted", "in-transit"]);

// Edit an open PO (2026-06-12 audit P1): full replace of vendor/expected/lines,
// mirroring create. Only submitted / in-transit orders are editable — received
// already moved stock, cancelled is terminal. Lines are replaced wholesale
// (qty_received is always 0 while a PO is editable, since receive flips the
// status in the same transaction that sets it).
export async function updatePurchaseOrder(
  prisma: PrismaClient,
  poId: string,
  input: InventoryPurchaseOrderUpdate,
  who: string,
  locationId: string = DEFAULT_LOCATION_ID
): Promise<InventoryPurchaseOrderDetail | null> {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.inventoryPurchaseOrder.findFirst({
      where: { id: poId, locationId }
    });
    if (!existing) {
      return null;
    }
    if (!EDITABLE_PO_STATUSES.has(existing.status)) {
      throw new PoStateConflictError(existing.status);
    }
    await assertItemsExist(tx, input.lines.map((line) => line.sku));
    const totalCents = Math.round(
      input.lines.reduce((sum, line) => sum + line.qty_ordered * line.unit_cost_cents, 0)
    );
    await tx.inventoryPoLine.deleteMany({ where: { poId } });
    const po = await tx.inventoryPurchaseOrder.update({
      where: { id: poId },
      data: {
        vendor: input.vendor,
        expected: input.expected ?? "",
        lines: input.lines.length,
        totalCents,
        lineItems: {
          create: input.lines.map((line) => ({
            locationId,
            sku: line.sku,
            qtyOrdered: line.qty_ordered,
            qtyReceived: 0,
            unitCostCents: line.unit_cost_cents
          }))
        }
      },
      include: { lineItems: true }
    });
    await tx.inventoryActivityEntry.create({
      data: {
        locationId,
        at: timeLabel(),
        who,
        action: "edited",
        what: `PO ${poId} from ${po.vendor}`,
        note: `${input.lines.length} lines · ${formatTotal(totalCents)}`
      }
    });
    const items = await tx.inventoryItem.findMany({
      where: { id: { in: input.lines.map((line) => line.sku) } }
    });
    const itemsById = new Map(items.map((item) => [item.id, item]));
    return serialize.toPurchaseOrderDetail(po, po.lineItems, itemsById);
  });
}

// Cancel an open PO. Idempotent: cancelling an already-cancelled order replays as
// a no-op (no second activity row). A received order can't be cancelled — the
// stock already moved; that path is a count correction, not a PO cancellation.
export async function cancelPurchaseOrder(
  prisma: PrismaClient,
  poId: string,
  who: string,
  locationId: string = DEFAULT_LOCATION_ID
): Promise<InventoryPurchaseOrder | null> {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.inventoryPurchaseOrder.findFirst({
      where: { id: poId, locationId }
    });
    if (!existing) {
      return null;
    }
    if (existing.status === "cancelled") {
      return serialize.toPurchaseOrder(existing);
    }
    if (existing.status === "received") {
      throw new PoStateConflictError(existing.status);
    }
    const po = await tx.inventoryPurchaseOrder.update({
      where: { id: poId },
      data: { status: "cancelled" }
    });
    await tx.inventoryActivityEntry.create({
      data: {
        locationId,
        at: timeLabel(),
        who,
        action: "cancelled",
        what: `PO ${poId} from ${po.vendor}`,
        note: `${po.lines} lines · ${formatTotal(po.totalCents)}`
      }
    });
    return serialize.toPurchaseOrder(po);
  });
}

function formatTotal(totalCents: number): string {
  return `$${(totalCents / 100).toFixed(2)}`;
}
