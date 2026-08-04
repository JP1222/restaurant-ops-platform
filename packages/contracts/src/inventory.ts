import { z } from "zod";

import { isValidIpAllowlist } from "./ip-allowlist.js";

// Catalog categories for an ice-cream + bubble-tea shop (single-merchant). These are
// fixed domain ids; the operator never creates/deletes them. Flavors/variants (taro vs
// matcha powder, different pearls) are ITEMS within a category, not categories.
export const inventoryCategoryIds = [
  "dairy",
  "powder",
  "topping",
  "fruit",
  "sweetener",
  "packaging",
  "food",
  "supplies"
] as const;

export const inventoryItemStatuses = [
  "ok",
  "low",
  "critical",
  "over",
  "86"
] as const;

export const inventoryWasteReasonIds = [
  "spoilage",
  "prep",
  "cook",
  "return",
  "quality",
  "drop",
  "theft",
  "over"
] as const;

// "cancelled" POs are terminal and are EXCLUDED from the dataset `pos` list the
// API serves (the cancellation lives on in the activity feed) — so floor surfaces
// never see one and a pre-"cancelled" client build can't choke on the enum.
export const inventoryPoStatuses = [
  "submitted",
  "in-transit",
  "received",
  "cancelled"
] as const;

export const inventoryCountStatuses = ["in-progress", "closed"] as const;

// The KIND of an item's base (stocking) unit (ADR-0737 D1). The UI renders by kind and a
// pack's base-qty is interpreted against it. "count" = today's implicit behavior for every
// existing item, so it's the default everywhere a kind is optional.
export const inventoryUnitKinds = ["count", "weight", "volume"] as const;

// Where a barcode came from (ADR-0737 D4): a manufacturer-printed UPC/GTIN, or a code we
// printed ourselves (no-UPC / house-prepped items, shelf/bin tags).
export const inventoryBarcodeSources = ["manufacturer", "internal"] as const;

// Path-id guards for inventory routes. Bound the length before an id reaches a
// Prisma `where: { id }` so an oversized id can't soak a worker on a lookup.
export const ItemIdSchema = z.string().min(1).max(64);
export const PoIdSchema = z.string().min(1).max(64);
export const RecipeIdSchema = z.string().min(1).max(64);

export const InventoryCategoryIdSchema = z.enum(inventoryCategoryIds);
export const InventoryItemStatusSchema = z.enum(inventoryItemStatuses);
export const InventoryWasteReasonIdSchema = z.enum(inventoryWasteReasonIds);
export const InventoryPoStatusSchema = z.enum(inventoryPoStatuses);
export const InventoryCountStatusSchema = z.enum(inventoryCountStatuses);
export const InventoryUnitKindSchema = z.enum(inventoryUnitKinds);
export const InventoryBarcodeSourceSchema = z.enum(inventoryBarcodeSources);

export const InventoryCategorySchema = z.object({
  id: InventoryCategoryIdSchema,
  name: z.string(),
  color: z.string()
});

// Canonical default category set: the 7 fixed enum ids with display name + color.
// Categories are a domain constant, not user data — the operator never creates or
// deletes them. The inventory_category table CAN hold rows (display overrides), but
// it must never read as empty: an un-seeded DB would leave the "Add item" category
// picker blank and block creating the very first item (cold-start deadlock — you
// need a category to add an item, but a fresh prod DB has none). The dataset falls
// back to this when the table has no rows. Mirrors packages/db-inventory/prisma/seed-data.ts.
export const defaultInventoryCategories: z.infer<typeof InventoryCategorySchema>[] = [
  { id: "dairy", name: "Dairy & Cream", color: "amber" },
  { id: "powder", name: "Powders & Bases", color: "wheat" },
  { id: "topping", name: "Toppings", color: "violet" },
  { id: "fruit", name: "Fruit", color: "tomato" },
  { id: "sweetener", name: "Sweeteners", color: "pink" },
  { id: "packaging", name: "Cups & Packaging", color: "slate" },
  { id: "food", name: "Other Food", color: "mint" },
  { id: "supplies", name: "Supplies", color: "blue" }
];

// A purchasable / countable PACKAGE shape for an item (ADR-0737 D2/D3). `base_qty_per_pack`
// is how many BASE units (the item's `unit`) one of this pack equals — an 8 oz bag = 8, a
// 500-cup case = 500 — so the floor can act in packs while stock stays in the base unit.
// `vendor` ("" = all vendors) lets one item carry Vendor A's "case = 500" and Vendor B's
// "case = 480" without duplicate items. `contains_*` is a display-only hint ("1 case = 10
// bags"); it does not enter the conversion (base_qty_per_pack already collapses to the base).
export const InventoryItemPackSchema = z.object({
  id: z.string(),
  label: z.string(),
  base_qty_per_pack: z.number().positive(),
  vendor: z.string(),
  contains_label: z.string(),
  contains_qty: z.number().nullable().optional(),
  is_purchase_default: z.boolean(),
  sort: z.number().int()
});

// A barcode mapping a scanned/printed code to an item, optionally to a specific pack
// (ADR-0737 D4). 12 oz and 8 oz bags are different UPCs → different packs → a scan resolves
// the exact base quantity. `pack_id` null = item-level code (operator picks the pack).
export const InventoryBarcodeSchema = z.object({
  code: z.string(),
  pack_id: z.string().nullable().optional(),
  source: InventoryBarcodeSourceSchema,
  label: z.string()
});

export const InventoryItemSchema = z.object({
  id: z.string(),
  sku: z.string(),
  name: z.string(),
  category: InventoryCategoryIdSchema,
  unit: z.string(),
  // Kind of the base unit (ADR-0737 D1). Optional + defaulted so items/fixtures that predate
  // the field still parse; the API sets it explicitly on every item it emits.
  unit_kind: InventoryUnitKindSchema.default("count"),
  // Packaging conversions + barcodes for this item (ADR-0737). Optional so pre-field fixtures
  // parse; the API emits them (possibly empty arrays) on every item.
  packs: z.array(InventoryItemPackSchema).optional(),
  barcodes: z.array(InventoryBarcodeSchema).optional(),
  on_hand: z.number(),
  par_min: z.number(),
  // Upper "par" level: doubles as the overstock ceiling (Backoffice "over" status)
  // AND the reorder target ("order up to par_max"). 0 is the sentinel for "no upper
  // bound set" — Backoffice skips the "over" status and the reorder hint for it, and
  // the floor leaves it optional. So par_max is either 0 (unset) or >= par_min.
  par_max: z.number(),
  // Per-usage cost in cents — NOT an integer: cheap items are sub-cent (a cup is
  // 5.2c). Derived server-side from purchase_cost_cents / pack_qty.
  cost_cents: z.number(),
  // Unit conversion: bought by `purchase_unit` (Case/Jug/...) at
  // `purchase_cost_cents` for `pack_qty` usage-units.
  purchase_unit: z.string(),
  pack_qty: z.number(),
  purchase_cost_cents: z.number().int(),
  vendor: z.string(),
  shelf_days: z.number().int(),
  last_counted: z.string(),
  flagged_86: z.boolean(),
  // Soft-delete flag (ADR catalog-management D1). Defaults false so existing
  // fixtures/object literals that predate the field still parse; the API always
  // sets it explicitly. Archived items are excluded from the default dataset and
  // only surface via `GET /api/inventory?include=archived`.
  archived: z.boolean().default(false),
  // Whether the item has a photo stored (served by GET /api/inventory/items/:id/image).
  // Optional so existing fixtures/object literals that predate the field still
  // typecheck; the API sets it explicitly on every item it emits. The image bytes
  // themselves are NEVER inlined here — only this flag — so the dataset stays small.
  has_image: z.boolean().optional(),
  // Operator-chosen emoji "icon" for the item (Floor "edit item" + Backoffice).
  // Sibling to the photo: both are the item's catalog-level visual identity, not
  // client-only presentation state. Unlike the photo bytes this is a tiny string
  // (one emoji glyph), so it IS inlined in the dataset. Display precedence is
  // photo (has_image) > icon > category fallback glyph. Optional + omitted by the
  // API when unset, so existing fixtures/object literals that predate it parse.
  icon: z.string().trim().max(32).optional()
});

// Editor write payload for an ingredient/packaging item (backoffice BFF ->
// inventory-api). All fields are optional edits. When purchase_cost_cents and
// pack_qty are supplied the API derives the per-usage cost_cents
// (= purchase_cost_cents / pack_qty). par levels + on_hand are per-location state
// and are not edited through this path.
export const InventoryItemSaveSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  // Category is part of the floor "edit item" flow (a line cook fixes a
  // mis-filed item) — the backoffice editor leaves it untouched by omitting it.
  category: InventoryCategoryIdSchema.optional(),
  unit: z.string().trim().min(1).max(24).optional(),
  // Base-unit kind (count/weight/volume); omitted leaves it untouched (ADR-0737).
  unit_kind: InventoryUnitKindSchema.optional(),
  vendor: z.string().trim().max(120).optional(),
  shelf_days: z.number().int().nonnegative().optional(),
  purchase_unit: z.string().trim().max(60).optional(),
  pack_qty: z.number().positive().optional(),
  purchase_cost_cents: z.number().int().nonnegative().optional(),
  // Emoji glyph for the item (see InventoryItemSchema.icon). An empty string
  // clears it (falls back to the category glyph); omitting it leaves it untouched.
  icon: z.string().trim().max(32).optional()
});

// Par-level edit (ADR catalog-management D1). Distinct from InventoryItemSaveSchema,
// which deliberately OMITS par: par_min/par_max are per-LOCATION state
// (inventory_item_state), not brand catalog, so this writes the location's state row.
// par_max is either 0 ("no upper bound") or >= par_min — a positive ceiling below the
// floor is the only invalid combination.
export const InventoryParUpdateSchema = z
  .object({
    par_min: z.number().nonnegative(),
    par_max: z.number().nonnegative()
  })
  .refine((v) => v.par_max === 0 || v.par_max >= v.par_min, {
    message: "par_max must be 0 (no ceiling) or greater than or equal to par_min",
    path: ["par_max"]
  });

// Archive / un-archive an item (ADR catalog-management D1, soft-delete). The
// "delete" affordance archives (archived=true); un-archive restores (archived=false).
export const InventoryItemArchiveSchema = z.object({ archived: z.boolean() });

// Create a new catalog item (ADR catalog-management D1, "Add item"). id is always
// server-generated; sku is optional (server-generates one when omitted) and unique
// (409 on clash). cost_cents derives from purchase_cost_cents / pack_qty like the
// editor. par_min/par_max seed the brand-catalog defaults (per-location par is edited
// later via the par path). on_hand starts at 0 — receive/count moves it.
export const InventoryItemCreateSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    sku: z.string().trim().min(1).max(60).optional(),
    category: InventoryCategoryIdSchema,
    unit: z.string().trim().min(1).max(24),
    // Base-unit kind (count/weight/volume); defaults to "count" server-side (ADR-0737).
    unit_kind: InventoryUnitKindSchema.optional(),
    par_min: z.number().nonnegative(),
    par_max: z.number().nonnegative(),
    vendor: z.string().trim().max(120).optional(),
    shelf_days: z.number().int().nonnegative().optional(),
    purchase_unit: z.string().trim().max(60).optional(),
    pack_qty: z.number().positive().optional(),
    purchase_cost_cents: z.number().int().nonnegative().optional(),
    // Optional emoji glyph picked at create time (see InventoryItemSchema.icon).
    icon: z.string().trim().max(32).optional()
  })
  .refine((v) => v.par_max === 0 || v.par_max >= v.par_min, {
    message: "par_max must be 0 (no ceiling) or greater than or equal to par_min",
    path: ["par_max"]
  });

// Create / update a pack on an item (ADR-0737 D2/D3; manager catalog editor -> inventory-api).
// `id` present = edit that pack; absent = create. `base_qty_per_pack` must be > 0 (a pack of
// zero base units is meaningless). `vendor` is the raw vendor name; the API normalizes it to
// the alias key. Marking `is_purchase_default` true makes this the receive prefill; the API
// clears the flag on the item's other packs so at most one stays default.
export const InventoryItemPackSaveSchema = z.object({
  id: z.string().min(1).max(64).optional(),
  label: z.string().trim().min(1).max(60),
  base_qty_per_pack: z.number().positive(),
  vendor: z.string().trim().max(120).optional(),
  contains_label: z.string().trim().max(60).optional(),
  contains_qty: z.number().positive().nullable().optional(),
  is_purchase_default: z.boolean().optional(),
  sort: z.number().int().nonnegative().optional()
});

// Create / update a barcode mapping (ADR-0737 D4; manager catalog editor -> inventory-api).
// `code` is the scanned/printed string (bounded so an oversized scan can't soak a lookup).
// `pack_id` ties it to a specific pack (8 oz vs 12 oz); omit/null for an item-level code.
export const InventoryBarcodeSaveSchema = z.object({
  code: z.string().trim().min(1).max(64),
  pack_id: z.string().min(1).max(64).nullable().optional(),
  source: InventoryBarcodeSourceSchema.optional(),
  label: z.string().trim().max(60).optional()
});

// GET /api/inventory/barcode/:code response (ADR-0737): the resolved item plus the specific
// pack the code maps to (null = an item-level code — the operator picks the pack). The API
// 404s when the code is unknown, so this shape is always a resolved hit.
export const InventoryBarcodeResolveSchema = z.object({
  item: InventoryItemSchema,
  pack: InventoryItemPackSchema.nullable()
});

// Mint an internal house code for a no-UPC item (barcode-onboarding ADR, D4). Empty `{}` body
// for an item-level code, or `pack_id` to tie the printed label to a specific pack. The server
// generates the `YR-#####` code (never client-supplied, so it can't collide with a real UPC) and
// is idempotent per (item, pack) — a second mint returns the existing code.
export const InventoryBarcodeMintRequestSchema = z.object({
  pack_id: z.string().min(1).max(64).optional()
});

// POST /api/inventory/items/:id/barcodes/mint response: the fresh item + the minted code, so the
// UI can immediately render and print the Code128 label.
export const InventoryBarcodeMintResponseSchema = z.object({
  item: InventoryItemSchema,
  code: z.string()
});

// GET /api/inventory/barcode/lookup/:upc response (barcode-onboarding ADR, D3): the superset of
// resolve used by the backoffice scan-to-register flow. `registered` = the scanned code already
// maps to an item (the UI shows "already registered as X" instead of creating a duplicate).
// `off` = a raw Open Food Facts hit (food UPCs only; null on a miss). `suggestions` = that OFF
// hit mapped onto our item fields to pre-fill the review form. Every field but `registered` is
// nullable so the endpoint can FAIL OPEN: a miss (every cup/straw, and any unconfigured/dev
// environment with no OFF db) returns `registered:false` with null `off`/`suggestions`, never an
// error — the review form just opens blank.
export const InventoryBarcodeEnrichSchema = z.object({
  registered: z.boolean(),
  item: InventoryItemSchema.nullable(),
  pack: InventoryItemPackSchema.nullable(),
  off: z
    .object({
      product_name: z.string(),
      brands: z.string().nullable(),
      quantity: z.string().nullable()
    })
    .nullable(),
  suggestions: z
    .object({
      name: z.string(),
      category: InventoryCategoryIdSchema.nullable(),
      unit: z.string(),
      unit_kind: InventoryUnitKindSchema
    })
    .nullable()
});

// Item photo upload (floor "edit item" / backoffice). The browser resizes the
// photo client-side and posts it base64-encoded through the BFF; inventory-api
// decodes it and stores the bytes in its own Postgres (single-merchant, low
// volume — no object-storage infra in the suite). Bounded so an oversized
// payload can't soak a worker: ~2.8MB of base64 ≈ ~2MB of binary. Served back as
// raw bytes by GET /api/inventory/items/:id/image; the dataset only carries the
// boolean `has_image`, never the bytes.
export const inventoryItemImageContentTypes = ["image/jpeg", "image/png", "image/webp"] as const;
export const InventoryItemImageUploadSchema = z.object({
  content_type: z.enum(inventoryItemImageContentTypes),
  data_base64: z.string().trim().min(1).max(2_800_000)
});

// Sales feed: analytics-api -> inventory-api for sales-driven depletion (ADR-0028,
// Iron Law 5 — inventory reads the read-only OLAP mart over HTTP, never its DB).
// One sold finished-good line item. The provider's catalog id is the depletion
// join key — `clover_item_id` for a Clover store, `square_catalog_item_id` for a
// Square store (exactly one is non-null, per the store's provider). `line_item_id`
// is the idempotency key for the sale event.
export const InventorySoldItemSchema = z.object({
  line_item_id: z.string(),
  clover_item_id: z.string().nullable(),
  // Square's CatalogObject id for the sold item (null for Clover stores). Default
  // null so a producer/feed that predates this field still validates.
  square_catalog_item_id: z.string().nullable().default(null),
  item_name: z.string(),
  quantity: z.number(),
  // Names of the Clover modifiers selected on this sold line (ADR-0028 modifier
  // depletion). inventory-api matches each against InventoryRecipeModifier.optionName
  // so a chosen modifier ("Extra Boba") additionally depletes — or, with a negative
  // qty_delta ("No Boba"), credits back — its mapped stock on top of the base BOM.
  // Names (not Clover ids) because the recipe editor keys modifiers by the same
  // human option name; an unmatched name simply depletes nothing (never a wrong
  // guess). Default [] so a feed/producer that predates this field still validates.
  modifiers: z.array(z.string()).default([])
});

// A page of sold line items since a watermark, plus the next opaque cursor (an ISO
// timestamp). The consumer is idempotent per line_item_id, so the feed re-emits the
// boundary inclusively (created_at >= cursor) without risking double-depletion.
export const InventorySoldItemsFeedSchema = z.object({
  items: z.array(InventorySoldItemSchema),
  cursor: z.string().nullable()
});

// Result of a manual "Sync sales" run (S4b) — mirrors the depletion worker's
// poll result: sale lines that depleted stock, lines skipped as already-applied
// (idempotent re-emit of the cursor boundary), sold items that matched no recipe
// (their sales silently deplete nothing until set up), and the advanced cursor.
export const InventoryDepletionRunResultSchema = z.object({
  applied: z.number().int(),
  skipped: z.number().int(),
  unmatched: z.array(z.string()),
  cursor: z.string().nullable()
});

export const InventoryRecipeLineSchema = z.object({
  sku: z.string(),
  qty: z.number()
});

// One modifier option's incremental consumption (recipe editor, ADR-0028). `qty`
// is a SIGNED delta on top of the base recipe: "Extra Boba" = +2, "No Boba" = -2.
// A modifier group with no lines here has no inventory impact (Sweetness, Ice).
export const InventoryRecipeModifierLineSchema = z.object({
  group: z.string(),
  option: z.string(),
  sku: z.string(),
  qty: z.number()
});

export const InventoryRecipeSchema = z.object({
  id: z.string(),
  name: z.string(),
  category: z.string(),
  sell_cents: z.number().int(),
  sold_today: z.number().int(),
  lines: z.array(InventoryRecipeLineSchema)
});

// Full recipe for the editor: base lines + per-modifier consumption + the Clover
// link. Served by GET /api/inventory/recipes/:id (not part of the list dataset).
export const InventoryRecipeDetailSchema = InventoryRecipeSchema.extend({
  clover_item_id: z.string().nullable(),
  modifiers: z.array(InventoryRecipeModifierLineSchema)
});

// Plate cost per Clover menu item, derived from a recipe's base BOM x ingredient
// cost (ADR-0031). Produced by inventory-api GET /api/recipes/plate-costs and
// ingested by analytics-api into mart.dim_item_cost for margin analytics.
// `plate_cost_cents` may be sub-cent precise (item costs are per-usage Floats).
// Only recipes with a Clover link AND a complete, fully-costed BOM are emitted:
// a missing ingredient cost makes the whole plate "cost unknown" and the item is
// omitted (never treated as $0, which would understate cost and falsely mark a
// high-price item a Star).
export const PlateCostSnapshotSchema = z.object({
  clover_item_id: z.string(),
  plate_cost_cents: z.number().nonnegative(),
  currency: z.string(),
  effective_from: z.string()
});

export const PlateCostsResponseSchema = z.object({
  snapshots: z.array(PlateCostSnapshotSchema)
});

export type PlateCostSnapshot = z.infer<typeof PlateCostSnapshotSchema>;
export type PlateCostsResponse = z.infer<typeof PlateCostsResponseSchema>;

// Labor cost reference (ADR-0033, Phase 4b). inventory-api is the WRITE-SOURCE for
// analytics' prime-cost labor leg: analytics is read-only OLAP and Backoffice can't
// write its mart (Iron Law 5), so labor — exactly like plate cost (ADR-0031) —
// originates here and analytics ingests it over HTTP into mart.dim_labor_cost.
// Effective-dated: a wage change opens a new row (latest effective_from <=
// business_date wins) so past prime cost stays point-in-time correct. MERCHANT-scoped
// (staffing/pay differ per store, unlike brand-level plate cost). daily_labor_cost_cents
// = the all-in labor bill MODELED per operating day (e.g. weekly bill / days open);
// may be sub-cent, like plate cost, so a weekly figure spread over days never truncates.
export const LaborCostSnapshotSchema = z.object({
  merchant_id: z.string(),
  daily_labor_cost_cents: z.number().nonnegative(),
  currency: z.string(),
  effective_from: z.string(),
  note: z.string().nullable().optional()
});

export const LaborCostsResponseSchema = z.object({
  snapshots: z.array(LaborCostSnapshotSchema)
});

// Editor write payload (backoffice BFF -> inventory-api PUT /api/admin/labor-costs).
// merchant_id is NOT supplied by the browser: it is stamped server-side from
// inventory-api's configured store, because single-store dashboard reads default to
// that same merchant — so the write must land on it for the cards to light up.
// effective_from is a bare store-local calendar date (YYYY-MM-DD), directly comparable
// to mart.fact_*.business_date.
export const LaborCostSaveSchema = z.object({
  daily_labor_cost_cents: z.number().nonnegative(),
  currency: z.string().trim().min(1).max(8).default("USD"),
  effective_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "effective_from must be YYYY-MM-DD"),
  note: z.string().trim().max(200).optional()
});

export type LaborCostSnapshot = z.infer<typeof LaborCostSnapshotSchema>;
export type LaborCostsResponse = z.infer<typeof LaborCostsResponseSchema>;
export type LaborCostSave = z.infer<typeof LaborCostSaveSchema>;

// Count-based actual COGS, the inventory write-source for analytics' yield-variance
// lens (ADR-0031: yield variance = actual − theoretical COGS). Actual COGS for a
// between-count window = beginning inventory value + received − ending inventory value,
// valued at current item cost, bracketed by two physical counts so the closing count's
// reconciliation captures shrink / over-portioning. Analytics ingests these windows over
// HTTP into its own mart (Iron Law 5) and compares each against the sum of theoretical
// COGS over [period_start, period_end]. MERCHANT-scoped like labor cost; period_start /
// period_end are bare store-local count dates (YYYY-MM-DD).
export const ActualCogsWindowSchema = z.object({
  merchant_id: z.string(),
  period_start: z.string(),
  period_end: z.string(),
  beginning_value_cents: z.number(),
  received_value_cents: z.number(),
  ending_value_cents: z.number(),
  actual_cogs_cents: z.number()
});

export const ActualCogsInputsResponseSchema = z.object({
  snapshots: z.array(ActualCogsWindowSchema)
});

export type ActualCogsWindow = z.infer<typeof ActualCogsWindowSchema>;
export type ActualCogsInputsResponse = z.infer<typeof ActualCogsInputsResponseSchema>;

// Editor write payload (backoffice BFF -> inventory-api). Full-set replace of the
// recipe's base lines and modifier consumption; name/category/sell are optional
// edits. Bounded so an oversized payload can't soak a worker on a save.
export const InventoryRecipeSaveSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  category: z.string().trim().max(80).optional(),
  sell_cents: z.number().int().nonnegative().optional(),
  lines: z.array(InventoryRecipeLineSchema).max(100),
  modifiers: z.array(InventoryRecipeModifierLineSchema).max(500)
});

// Create a new recipe (menu item) — header only: name, category, sell price. The BOM
// (base lines + modifier consumption) is filled in afterward via the recipe editor's
// save (InventoryRecipeSave). `category` is a free label (e.g. "Milk Tea"), distinct
// from the item categories.
export const InventoryRecipeCreateSchema = z.object({
  name: z.string().trim().min(1).max(120),
  category: z.string().trim().min(1).max(80),
  sell_cents: z.number().int().nonnegative()
});

export const InventoryActivityEntrySchema = z.object({
  id: z.string().optional(),
  at: z.string(),
  who: z.string(),
  action: z.string(),
  what: z.string(),
  note: z.string()
});

export const InventoryPurchaseOrderSchema = z.object({
  id: z.string(),
  vendor: z.string(),
  placed: z.string(),
  expected: z.string(),
  lines: z.number().int(),
  status: InventoryPoStatusSchema,
  total_cents: z.number().int()
});

// Per-line PO detail for the floor receive flow. The dataset list PO keeps
// `lines` as a count for the backoffice summary; this richer shape is served
// per-PO via GET /api/inventory/pos/:id so crew can receive line by line.
export const InventoryPurchaseOrderLineSchema = z.object({
  sku: z.string(),
  name: z.string(),
  unit: z.string(),
  qty_ordered: z.number(),
  qty_received: z.number(),
  // Per usage-unit, may be sub-cent (like item cost). Persisted at create/edit so
  // the PO edit drawer can show the price that was agreed, not today's catalog
  // cost. null = line predates the column (legacy POs).
  unit_cost_cents: z.number().nullable().default(null)
});

export const InventoryPurchaseOrderDetailSchema = InventoryPurchaseOrderSchema.extend({
  line_items: z.array(InventoryPurchaseOrderLineSchema)
});

// Create a purchase order (ADR catalog-management D3, "New PO"). id, placed date, line
// count, and total_cents are derived server-side; the new PO starts `submitted` (the
// PO status enum has no draft phase). unit_cost_cents is per usage-unit and may be
// sub-cent, like item cost — it feeds the order total only (PO lines don't persist a
// per-line cost). The receive flow is unchanged. `sku` carries the item id (existing
// inventory convention).
export const InventoryPurchaseOrderCreateSchema = z.object({
  vendor: z.string().trim().min(1).max(120),
  expected: z.string().trim().max(40).optional(),
  lines: z
    .array(
      z.object({
        sku: z.string().min(1).max(64),
        qty_ordered: z.number().positive(),
        unit_cost_cents: z.number().nonnegative()
      })
    )
    .min(1)
    .max(200)
});

// Edit an open PO (PUT /api/inventory/pos/:id): full replace of the editable
// fields, same shape as create plus optional operator attribution. Only
// `submitted` / `in-transit` orders are editable — a received PO already moved
// stock and a cancelled one is terminal (the API answers 409 `po_not_editable`).
// `who` is server-derived from the crew session for floor writes, else supplied
// by the trusted backoffice BFF (mirrors the receive submission). Cancel is a
// separate POST /api/inventory/pos/:id/cancel (idempotent; received orders can't
// be cancelled).
export const InventoryPurchaseOrderUpdateSchema = InventoryPurchaseOrderCreateSchema.extend({
  who: z.string().trim().min(1).max(120).optional()
});

export const InventoryPoCancelSchema = z.object({
  who: z.string().trim().min(1).max(120).optional()
});

export const InventoryCountRecordSchema = z.object({
  id: z.string(),
  date: z.string(),
  who: z.string(),
  scope: z.string(),
  items: z.number().int(),
  variance_pct: z.number().nullable(),
  variance_cents: z.number().int().nullable(),
  status: InventoryCountStatusSchema
});

export const InventoryVendorSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.string(),
  contact: z.string(),
  phone: z.string(),
  email: z.string(),
  account: z.string(),
  terms: z.string(),
  min_order_cents: z.number().int(),
  cutoff: z.string(),
  delivery_days: z.array(z.string()),
  categories: z.array(InventoryCategoryIdSchema),
  fill_rate: z.number(),
  on_time: z.number(),
  price_stability: z.number(),
  credits_90d: z.number().int(),
  spend_30d: z.number().int(),
  trend_4w: z.array(z.number().int()),
  preferred: z.boolean(),
  tags: z.array(z.string()),
  // Soft-delete flag (ADR catalog-management D2), same shape as the item DTO.
  archived: z.boolean().default(false)
});

// Vendor create/edit payload (ADR catalog-management D2). Covers the operator-set
// fields only — the performance metrics (fill_rate/on_time/price_stability/
// credits_90d/spend_30d/trend_4w) are derived from PO reconciliation, not hand-entered,
// so they're absent here. id is server-generated on create; edit is a full replace of
// these editable fields (metrics untouched). name is required; the rest default on create.
export const InventoryVendorSaveSchema = z.object({
  name: z.string().trim().min(1).max(120),
  type: z.string().trim().max(60).optional(),
  contact: z.string().trim().max(120).optional(),
  phone: z.string().trim().max(40).optional(),
  email: z.string().trim().max(160).optional(),
  account: z.string().trim().max(60).optional(),
  terms: z.string().trim().max(60).optional(),
  min_order_cents: z.number().int().nonnegative().optional(),
  cutoff: z.string().trim().max(60).optional(),
  delivery_days: z.array(z.string().trim().max(12)).max(7).optional(),
  categories: z.array(InventoryCategoryIdSchema).max(20).optional(),
  preferred: z.boolean().optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).optional()
});

// Archive / un-archive a vendor (ADR catalog-management D2, soft-delete).
export const InventoryVendorArchiveSchema = z.object({ archived: z.boolean() });

export const InventoryVendorQuoteSchema = z.object({
  vid: z.string(),
  cents: z.number().int(),
  primary: z.boolean().optional()
});

export const InventoryVendorQuoteRowSchema = z.object({
  sku: z.string(),
  quotes: z.array(InventoryVendorQuoteSchema)
});

// Learned vendor alias (ADR-0586, extends ADR-0538). Maps a vendor's
// PRINTED line text to a canonical catalog item, so a confirmed receive teaches the
// scanner to auto-match the same product next time ("item matching memory"). One
// canonical item accumulates many aliases (one per vendor wording). `normalized` is
// normalizeAlias(raw) and `vendor` is normalizeAlias(vendorName) ("" = vendor-agnostic);
// together they are the unique match key. `raw` is the original printed text (kept for
// audit + a future price-comparison view), `brand`/`pack` the model's optional structured
// extraction (e.g. "Member's Mark" / "12 oz"), `last_cost_cents` the most recent per-vendor
// price, `hits` how many times this alias has resolved a line (alias-trust signal).
export const InventoryItemAliasSchema = z.object({
  id: z.string(),
  item_id: z.string(),
  vendor: z.string(),
  // Human-readable vendor name (e.g. "Sam's Club") for the price view; `vendor` stays the
  // normalized match key. Defaults "" so rows learned before this field still parse.
  vendor_label: z.string().default(""),
  normalized: z.string(),
  raw: z.string(),
  brand: z.string(),
  pack: z.string(),
  // The specific InventoryItemPack (size) this learned wording maps to (ADR-882), or null when
  // the alias is item-level (no pack). Lets the next scan of this exact vendor wording resolve
  // straight to the right size. Required-but-nullable, mirroring last_cost_cents; the server
  // always emits it (toItemAlias maps the column, null for legacy rows).
  pack_id: z.string().nullable(),
  source: z.string(),
  // Per-vendor "last paid" per-usage cost. A Float (not int): a per-usage cost is sub-cent
  // (a 6000-ct napkin case is 0.479c each), mirroring item cost_cents. See ADR-0586 Phase 2B.
  last_cost_cents: z.number().nullable(),
  hits: z.number().int(),
  // ISO timestamp of the most recent receive for this (vendor, wording). Drives the
  // per-vendor price view's "latest wins" selection so it reflects last-paid, not most-frequent.
  last_seen_at: z.string()
});

export const InventoryWasteReasonSchema = z.object({
  id: InventoryWasteReasonIdSchema,
  label: z.string(),
  color: z.string(),
  needs_photo_over_cents: z.number().int()
});

export const InventoryWasteEntrySchema = z.object({
  id: z.string(),
  at: z.string(),
  who: z.string(),
  sku: z.string(),
  qty: z.number(),
  reason: InventoryWasteReasonIdSchema,
  notes: z.string(),
  photo: z.boolean(),
  approved: z.boolean()
});

export const InventoryWasteSettingsSchema = z.object({
  photo_required_over_cents: z.number().int(),
  manager_approval_over_cents: z.number().int()
});

export const InventoryDatasetSchema = z.object({
  categories: z.array(InventoryCategorySchema),
  items: z.array(InventoryItemSchema),
  recipes: z.array(InventoryRecipeSchema),
  activity: z.array(InventoryActivityEntrySchema),
  pos: z.array(InventoryPurchaseOrderSchema),
  counts: z.array(InventoryCountRecordSchema),
  // Food-cost target benchmark (config, not a measurement). The COGS / net-sales
  // *measurements* are analytics-owned (Iron Law 5) and read from analytics-api,
  // never seeded here — see ADR-0573. Only this target line remains inventory config.
  cogs_target_pct: z.number(),
  vendors: z.array(InventoryVendorSchema),
  vendor_quotes: z.array(InventoryVendorQuoteRowSchema),
  // Learned vendor→item aliases (ADR-0586). Default [] so fixtures/seeds and
  // any dataset literal that predates the field still parse; the API always sets it.
  item_aliases: z.array(InventoryItemAliasSchema).default([]),
  waste_reasons: z.array(InventoryWasteReasonSchema),
  waste_log: z.array(InventoryWasteEntrySchema),
  waste_settings: InventoryWasteSettingsSchema
});

// Write-side request DTOs (backoffice / crew -> inventory-api). Kept here so
// both the API and its clients validate against one source (Iron Law 2).
export const InventoryWasteSubmissionSchema = z.object({
  sku: z.string(),
  qty: z.number().positive(),
  // Optional pack the qty is in (ADR-0737), e.g. tossing a whole sealed bag. Present ⇒ qty is
  // a number of this pack (API multiplies by base_qty_per_pack); absent ⇒ qty is base units.
  pack_id: z.string().min(1).max(64).optional(),
  reason: InventoryWasteReasonIdSchema,
  notes: z.string(),
  photo: z.boolean(),
  cost_cents: z.number().int().nonnegative(),
  who: z.string().min(1),
  // Optional per-action idempotency key (uuid). A retried / double-submitted write
  // carrying the same key is a no-op server-side (returns the prior result), so a
  // flaky-network retry can't double-apply on_hand. Omitted => no dedup.
  idempotency_key: z.string().min(1).optional()
});

export const InventoryCountSubmissionSchema = z.object({
  updates: z.record(z.string(), z.number().nonnegative()),
  who: z.string().min(1),
  scope: z.string().optional(),
  idempotency_key: z.string().min(1).optional()
});

export const InventoryReceiveLineSchema = z.object({
  sku: z.string(),
  qty: z.number().nonnegative(),
  // Optional pack the qty is expressed in (ADR-0737). Present ⇒ qty is a number of THIS pack
  // and the API multiplies by its base_qty_per_pack (server-side, persisted — the successor to
  // the ADR-0592 client-side guess). Absent ⇒ qty is base units, exactly as today.
  pack_id: z.string().min(1).max(64).optional()
});

export const InventoryReceiveSubmissionSchema = z.object({
  lines: z.array(InventoryReceiveLineSchema).min(1),
  who: z.string().min(1),
  // Accepted for parity with waste/count; receive is already idempotent per PO
  // line via its stock-movement source_ref, so this is currently advisory.
  idempotency_key: z.string().min(1).optional()
});

// Ad-hoc receive (ADR invoice-scan D2): receive a delivery with NO purchase order.
// A line either targets an existing catalog item by `sku` (= item id), or — when
// `sku` is absent — carries enough to inline-create one (`name` + `category` +
// `unit`), so an empty store bootstraps its catalog straight from its invoices.
// Idempotent like PO receive: a stock movement keyed by (location, reason,
// `adhoc:<idempotency_key>:<item>`) makes a double-submit a no-op.
export const InventoryAdHocReceiveLineSchema = z
  .object({
    sku: ItemIdSchema.optional(),
    name: z.string().trim().min(1).max(120).optional(),
    category: InventoryCategoryIdSchema.optional(),
    unit: z.string().trim().min(1).max(24).optional(),
    qty: z.number().nonnegative(),
    // Optional pack the qty + cost are expressed in (ADR-0737). Present ⇒ qty is a number of
    // this pack and unit_cost_cents is per-pack; the API converts to base-unit qty + per-base
    // cost via the pack's base_qty_per_pack. Absent ⇒ both are per base unit, as today. Only
    // valid with an existing `sku` (a new inline-created item has no packs yet).
    pack_id: z.string().min(1).max(64).optional(),
    // The per-stock-unit cost. Allowed to be sub-cent (not int): a pack receive divides the
    // pack price by pack_qty, so a 6000-ct napkin case lands 0.479c/napkin. The API rounds
    // when it seeds a new item's whole-cent purchase_cost_cents.
    unit_cost_cents: z.number().nonnegative().optional(),
    // Raw vendor-printed text for this line (ADR-0586 D2). When present and
    // the line resolves to an item (matched OR freshly created), the API learns a
    // (vendor, normalized)->item alias so the next invoice from this vendor auto-matches.
    // brand/pack are the model's optional structured extraction, stored on the alias as
    // metadata (never rewritten into the canonical item name — ADR-0586 D4).
    description: z.string().trim().max(200).optional(),
    brand: z.string().trim().max(80).optional(),
    pack: z.string().trim().max(60).optional(),
    // Optional AI-suggested emoji glyph (see InventoryItemSchema.icon). Applied ONLY when a
    // line inline-creates a NEW item; ignored for a matched existing `sku` (its icon is never
    // touched by a receive). Same <=32-char ceiling as the item icon.
    icon: z.string().trim().max(32).optional(),
    // Optional par levels (see InventoryItemSchema.par_max). Applied ONLY when a line
    // inline-creates a NEW item; ignored for a matched existing `sku` (its par is per-location
    // state, edited via the par path). No cross-field refine here on purpose: an invalid pair
    // (positive max below min) on one line must not 400 the whole receive — the store clamps a
    // sub-min max to 0 ("no ceiling") so one par typo never loses the batch.
    par_min: z.number().nonnegative().optional(),
    par_max: z.number().nonnegative().optional(),
    // ADR-882: a NEW pack (size) to create for this line's item, then book qty into it. qty is a
    // number of this pack and unit_cost_cents is per-pack (same denomination as `pack_id`); the
    // API ensures the pack (idempotent on item + vendor + label) and converts to base units via
    // base_qty_per_pack. Mutually exclusive with `pack_id`, which names an EXISTING pack.
    new_pack: z
      .object({
        label: z.string().trim().min(1).max(60),
        base_qty_per_pack: z.number().positive()
      })
      .optional(),
    // ADR-882: a client-assigned ref linking several NEW lines that are the SAME product at
    // different sizes, so the receive creates ONE item (from the first line bearing this ref) and
    // attaches each line's pack to it — instead of duplicate items. Ignored for a matched `sku`.
    item_group: z.string().trim().min(1).max(64).optional()
  })
  .refine((l) => Boolean(l.sku) || (Boolean(l.name) && Boolean(l.category) && Boolean(l.unit)), {
    message: "line needs an existing sku, or name + category + unit to create a new item",
    path: ["sku"]
  })
  .refine((l) => !(l.pack_id && l.new_pack), {
    message: "a line maps to an existing pack_id OR creates a new_pack, not both",
    path: ["new_pack"]
  });

export const InventoryAdHocReceiveSchema = z.object({
  vendor: z.string().trim().max(120).optional(),
  who: z.string().min(1),
  idempotency_key: z.string().min(1).optional(),
  lines: z.array(InventoryAdHocReceiveLineSchema).min(1),
  // Optional original receipt/invoice image to ARCHIVE alongside this receive (receipt-archive).
  // When present, the API best-effort uploads the bytes to object storage and records an
  // InventoryReceiptScan row keyed by the same idempotency ref as the stock movements — so the
  // archived photo and the logged quantities share one anchor. Omitted (e.g. a PO/manual receive
  // with no scan) => no archive row. base64 cap matches the scan route's image limit; content type
  // reuses the item-image set (the crew flow already resizes photos / renders the PDF's first page
  // to an image before sending). invoice_date is the opaque "YYYY-MM-DD" the vision step read, kept
  // verbatim for the archive (distinct from the server's capture timestamp).
  receipt_image_base64: z.string().trim().min(1).max(8_000_000).optional(),
  receipt_content_type: z.enum(inventoryItemImageContentTypes).optional(),
  invoice_date: z.string().trim().max(40).optional()
});

// toggle-86 carries no domain payload, but an unsafe verb must always require a
// body so it can't be triggered by a bare cross-site form post (CSRF). The
// explicit `confirm: true` makes the intent unambiguous.
export const InventoryToggle86RequestSchema = z.object({
  confirm: z.literal(true)
});

// Invoice-scan extraction (ADR-0538 D3): the structured result of running a vendor
// invoice image through the vision model. RAW descriptions only — mapping a
// description to a catalog item is a separate deterministic step on the client, never
// the model's job, so a hallucinated SKU can't reach the ledger. The parse result
// pre-fills the receive intake table; nothing is written to stock from it directly.
export const InventoryReceiptParseLineSchema = z.object({
  description: z.string().trim().min(1).max(200),
  qty: z.number().nonnegative(),
  unit: z.string().trim().max(24).optional(),
  unit_price_cents: z.number().int().nonnegative().optional(),
  // AI normalization (ADR-0586 D4): the vision step also proposes a CLEAN
  // canonical name (brand/pack stripped, e.g. "Milk 12 oz"), the brand ("Member's Mark"),
  // and the pack descriptor ("12 oz"). All optional — matching pre-fills the clean name
  // for a NEW item and matches on it when present, and the raw `description` is still kept
  // verbatim as the learned alias. Degrades to the raw-description path when absent, so a
  // weaker vision model never blocks receiving. The model still never emits a catalog SKU.
  canonical_name: z.string().trim().max(120).optional(),
  brand: z.string().trim().max(80).optional(),
  pack: z.string().trim().max(60).optional()
});

export const InventoryReceiptParseResultSchema = z.object({
  vendor: z.string().trim().max(120).optional(),
  invoice_date: z.string().trim().max(40).optional(),
  lines: z.array(InventoryReceiptParseLineSchema)
});

export type InventoryReceiptParseLine = z.infer<typeof InventoryReceiptParseLineSchema>;
export type InventoryReceiptParseResult = z.infer<typeof InventoryReceiptParseResultSchema>;

// Archived receipt scan, read side (receipt-archive). The frozen record of a confirmed
// ad-hoc receive that carried a scanned image, surfaced in the backoffice Receiving tab's
// "history" view. `lines` is the immutable snapshot of what was confirmed at receive time
// (ad-hoc receives have no per-line table, only the per-item movement ledger), so the archive
// renders the receipt's content without re-joining movements + aliases.
export const InventoryReceiptScanLineSchema = z.object({
  description: z.string(),
  qty: z.number().nonnegative(),
  unit: z.string().optional(),
  // Per-stock-unit cost as confirmed; sub-cent allowed (like the receive line), so Float not int.
  unit_cost_cents: z.number().nonnegative().optional()
});

export const InventoryReceiptScanSchema = z.object({
  id: z.string(),
  vendor: z.string().optional(),
  invoice_date: z.string().optional(),
  who: z.string(),
  // ISO timestamp (server capture time). The list groups by this for the "by date" view.
  captured_at: z.string(),
  line_count: z.number().int().nonnegative(),
  total_cents: z.number().int().nonnegative(),
  // Mirrors InventoryItem.has_image: the list carries only WHETHER an image exists, never the
  // bytes. The browser fetches it lazily from GET /api/inventory/receipts/:id/image. false = the
  // scan was logged but its image couldn't be stored (best-effort archive).
  has_image: z.boolean(),
  lines: z.array(InventoryReceiptScanLineSchema)
});

export const InventoryReceiptListResponseSchema = z.object({
  receipts: z.array(InventoryReceiptScanSchema)
});

export type InventoryReceiptScanLine = z.infer<typeof InventoryReceiptScanLineSchema>;
export type InventoryReceiptScan = z.infer<typeof InventoryReceiptScanSchema>;
export type InventoryReceiptListResponse = z.infer<typeof InventoryReceiptListResponseSchema>;

// AI semantic match (ADR-0586 Phase 2A). When the deterministic tiers (learned alias →
// fuzzy name) can't resolve a scanned line, the client asks the model to pick the SINGLE
// best EXISTING catalog item by meaning, with a confidence. The model chooses ONLY from
// the candidate ids the client sends (it never invents a SKU — ADR-0538 D3); the BFF drops
// any id not in that set and the operator still confirms (ADR-0538 D4). `text` is the
// line's clean canonical name (else its raw description). Bounded so a payload can't soak
// the route: a scan is tens of lines, a single-merchant catalog a few hundred items.
export const InventoryMatchSuggestRequestSchema = z.object({
  lines: z
    .array(z.object({ index: z.number().int().nonnegative(), text: z.string().trim().min(1).max(200) }))
    .min(1)
    .max(100),
  candidates: z
    .array(z.object({ id: ItemIdSchema, name: z.string().trim().min(1).max(200) }))
    .max(2000)
});

export const InventoryMatchSuggestionSchema = z.object({
  index: z.number().int().nonnegative(),
  // null = the model found no good existing match (the line stays a new-item candidate).
  item_id: z.string().nullable(),
  // 0..1; the client applies a suggestion only at/above ai.match_confidence_threshold.
  confidence: z.number().min(0).max(1)
});

export const InventoryMatchSuggestResultSchema = z.object({
  suggestions: z.array(InventoryMatchSuggestionSchema),
  // Echoed so the client can gate without a second settings read; server-resolved.
  threshold: z.number().min(0).max(1)
});

export type InventoryMatchSuggestRequest = z.infer<typeof InventoryMatchSuggestRequestSchema>;
export type InventoryMatchSuggestion = z.infer<typeof InventoryMatchSuggestionSchema>;
export type InventoryMatchSuggestResult = z.infer<typeof InventoryMatchSuggestResultSchema>;

// AI emoji-icon suggestion. Reuses the DeepSeek text path (same model as the semantic
// matcher, ai.match_model_id — see InventoryMatchSuggest above) to pick ONE emoji glyph
// per item name. Fired three ways, all sharing this one call: a scanned line that creates
// a new item, an item rename, and manual create. The model proposes a glyph; the BFF
// sanitizes it (must be emoji-like, else "") and the caller only fills the icon when the
// item has none yet — a manual pick is never clobbered. Names are bounded (a scan is tens
// of new lines at most) so a payload can't soak the route. index-keyed like the matcher
// so a batch response pairs by index, not list order.
export const InventoryEmojiSuggestRequestSchema = z.object({
  names: z
    .array(
      z.object({
        index: z.number().int().nonnegative(),
        name: z.string().trim().min(1).max(200)
      })
    )
    .min(1)
    .max(100)
});

export const InventoryEmojiSuggestionSchema = z.object({
  index: z.number().int().nonnegative(),
  // "" = the model proposed nothing emoji-like; the caller leaves the icon empty and the UI
  // falls back to the category glyph. Otherwise a single sanitized emoji glyph (<=32 chars,
  // matching InventoryItemSchema.icon).
  emoji: z.string().max(32)
});

export const InventoryEmojiSuggestResultSchema = z.object({
  suggestions: z.array(InventoryEmojiSuggestionSchema)
});

export type InventoryEmojiSuggestRequest = z.infer<typeof InventoryEmojiSuggestRequestSchema>;
export type InventoryEmojiSuggestion = z.infer<typeof InventoryEmojiSuggestionSchema>;
export type InventoryEmojiSuggestResult = z.infer<typeof InventoryEmojiSuggestResultSchema>;

export type InventoryCategoryId = z.infer<typeof InventoryCategoryIdSchema>;
export type InventoryItemStatus = z.infer<typeof InventoryItemStatusSchema>;
export type InventoryWasteReasonId = z.infer<typeof InventoryWasteReasonIdSchema>;
export type InventoryPoStatus = z.infer<typeof InventoryPoStatusSchema>;
export type InventoryCountStatus = z.infer<typeof InventoryCountStatusSchema>;
export type InventoryCategory = z.infer<typeof InventoryCategorySchema>;
export type InventoryItem = z.infer<typeof InventoryItemSchema>;
export type InventoryUnitKind = z.infer<typeof InventoryUnitKindSchema>;
export type InventoryBarcodeSource = z.infer<typeof InventoryBarcodeSourceSchema>;
export type InventoryItemPack = z.infer<typeof InventoryItemPackSchema>;
export type InventoryBarcode = z.infer<typeof InventoryBarcodeSchema>;
export type InventoryItemPackSave = z.infer<typeof InventoryItemPackSaveSchema>;
export type InventoryBarcodeSave = z.infer<typeof InventoryBarcodeSaveSchema>;
export type InventoryBarcodeResolve = z.infer<typeof InventoryBarcodeResolveSchema>;
export type InventoryBarcodeEnrich = z.infer<typeof InventoryBarcodeEnrichSchema>;
export type InventoryBarcodeMintRequest = z.infer<typeof InventoryBarcodeMintRequestSchema>;
export type InventoryBarcodeMintResponse = z.infer<typeof InventoryBarcodeMintResponseSchema>;
export type InventoryItemSave = z.infer<typeof InventoryItemSaveSchema>;
export type InventoryParUpdate = z.infer<typeof InventoryParUpdateSchema>;
export type InventoryItemArchive = z.infer<typeof InventoryItemArchiveSchema>;
export type InventoryItemCreate = z.infer<typeof InventoryItemCreateSchema>;
export type InventoryItemImageUpload = z.infer<typeof InventoryItemImageUploadSchema>;
export type InventorySoldItem = z.infer<typeof InventorySoldItemSchema>;
export type InventorySoldItemsFeed = z.infer<typeof InventorySoldItemsFeedSchema>;
export type InventoryDepletionRunResult = z.infer<typeof InventoryDepletionRunResultSchema>;
export type InventoryRecipeLine = z.infer<typeof InventoryRecipeLineSchema>;
export type InventoryRecipeModifierLine = z.infer<typeof InventoryRecipeModifierLineSchema>;
export type InventoryRecipe = z.infer<typeof InventoryRecipeSchema>;
export type InventoryRecipeDetail = z.infer<typeof InventoryRecipeDetailSchema>;
export type InventoryRecipeSave = z.infer<typeof InventoryRecipeSaveSchema>;
export type InventoryRecipeCreate = z.infer<typeof InventoryRecipeCreateSchema>;
export type InventoryActivityEntry = z.infer<typeof InventoryActivityEntrySchema>;
export type InventoryPurchaseOrder = z.infer<typeof InventoryPurchaseOrderSchema>;
export type InventoryPurchaseOrderLine = z.infer<typeof InventoryPurchaseOrderLineSchema>;
export type InventoryPurchaseOrderDetail = z.infer<typeof InventoryPurchaseOrderDetailSchema>;
export type InventoryPurchaseOrderCreate = z.infer<typeof InventoryPurchaseOrderCreateSchema>;
export type InventoryPurchaseOrderUpdate = z.infer<typeof InventoryPurchaseOrderUpdateSchema>;
export type InventoryPoCancel = z.infer<typeof InventoryPoCancelSchema>;
export type InventoryCountRecord = z.infer<typeof InventoryCountRecordSchema>;
export type InventoryVendor = z.infer<typeof InventoryVendorSchema>;
export type InventoryVendorSave = z.infer<typeof InventoryVendorSaveSchema>;
export type InventoryVendorArchive = z.infer<typeof InventoryVendorArchiveSchema>;
export type InventoryVendorQuote = z.infer<typeof InventoryVendorQuoteSchema>;
export type InventoryVendorQuoteRow = z.infer<typeof InventoryVendorQuoteRowSchema>;
export type InventoryItemAlias = z.infer<typeof InventoryItemAliasSchema>;
export type InventoryWasteReason = z.infer<typeof InventoryWasteReasonSchema>;
export type InventoryWasteEntry = z.infer<typeof InventoryWasteEntrySchema>;
export type InventoryWasteSettings = z.infer<typeof InventoryWasteSettingsSchema>;
export type InventoryDataset = z.infer<typeof InventoryDatasetSchema>;
export type InventoryWasteSubmission = z.infer<typeof InventoryWasteSubmissionSchema>;
export type InventoryCountSubmission = z.infer<typeof InventoryCountSubmissionSchema>;
export type InventoryReceiveLine = z.infer<typeof InventoryReceiveLineSchema>;
export type InventoryReceiveSubmission = z.infer<typeof InventoryReceiveSubmissionSchema>;
export type InventoryAdHocReceiveLine = z.infer<typeof InventoryAdHocReceiveLineSchema>;
export type InventoryAdHocReceive = z.infer<typeof InventoryAdHocReceiveSchema>;
export type InventoryToggle86Request = z.infer<typeof InventoryToggle86RequestSchema>;

// -- Crew employee admin (Phase 5b backoffice) ------------------------------
// Manager-facing view + write DTOs for floor crew. PINs are never returned
// (argon2-hashed server-side); the manager sets a 6-digit PIN on create/reset
// and uniqueness is enforced by the pin_lookup index (409 on clash).

export const InventoryEmployeeSchema = z.object({
  id: z.string(),
  name: z.string(),
  role: z.string(),
  shift: z.string(),
  initials: z.string(),
  color: z.string(),
  active: z.boolean(),
  created_at: z.string(),
  updated_at: z.string()
});

// 6-digit PIN. Widened from 4 digits (10k space, brute-forceable) to 6 (1M space,
// 100× harder) as a floor-auth hardening. NOTE: existing crew members keep their
// old 4-digit hash until a manager resets them, so they must be re-issued a 6-digit
// PIN after this ships — until then the 6-digit floor keypad won't submit their PIN.
const InventoryPinSchema = z.string().regex(/^\d{6}$/, "PIN must be 6 digits");

export const InventoryEmployeeCreateRequestSchema = z.object({
  name: z.string().trim().min(1).max(80),
  role: z.string().trim().min(1).max(40),
  shift: z.string().trim().min(1).max(40),
  initials: z.string().trim().min(1).max(4).optional(),
  color: z.string().trim().max(40).optional(),
  pin: InventoryPinSchema
});

export const InventoryEmployeeUpdateRequestSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  role: z.string().trim().min(1).max(40).optional(),
  shift: z.string().trim().min(1).max(40).optional(),
  initials: z.string().trim().min(1).max(4).optional(),
  color: z.string().trim().max(40).optional(),
  active: z.boolean().optional()
});

export const InventoryEmployeePinResetRequestSchema = z.object({
  pin: InventoryPinSchema
});

// Floor-login security settings (manager-tunable, no redeploy). Today just the
// crew IP allowlist: a free-text list of IPs / IPv4 CIDRs that may reach the crew
// PIN login. EMPTY = allow all (opt-in gate, so a blank value never locks the floor
// out). Enforced in crew-web's BFF (the only tier that sees the cook's real client
// IP via Traefik's X-Forwarded-For now that inventory-api is internal-only); stored
// here, edited from Backoffice. The save schema validates every entry up front so a
// typo can't silently disable the gate.
export const InventorySecuritySettingsSchema = z.object({
  crew_ip_allowlist: z.string()
});

export const InventorySecuritySettingsSaveSchema = z.object({
  crew_ip_allowlist: z
    .string()
    .max(4000)
    .refine(isValidIpAllowlist, { message: "Each entry must be an IP address or IPv4 CIDR" })
});

export const InventoryEmployeeListResponseSchema = z.object({
  employees: z.array(InventoryEmployeeSchema)
});

export const InventoryEmployeeResponseSchema = z.object({
  employee: InventoryEmployeeSchema
});

export type InventoryEmployee = z.infer<typeof InventoryEmployeeSchema>;
export type InventoryEmployeeCreateRequest = z.infer<typeof InventoryEmployeeCreateRequestSchema>;
export type InventoryEmployeeUpdateRequest = z.infer<typeof InventoryEmployeeUpdateRequestSchema>;
export type InventoryEmployeePinResetRequest = z.infer<typeof InventoryEmployeePinResetRequestSchema>;
export type InventoryEmployeeListResponse = z.infer<typeof InventoryEmployeeListResponseSchema>;
export type InventoryEmployeeResponse = z.infer<typeof InventoryEmployeeResponseSchema>;
export type InventorySecuritySettings = z.infer<typeof InventorySecuritySettingsSchema>;
export type InventorySecuritySettingsSave = z.infer<typeof InventorySecuritySettingsSaveSchema>;
