# Inventory Unit Model — Implementation Plan

> **Status:** current — execution plan for [ADR-0737](decisions/0737-inventory-unit-model-stable-base-unit-per-vendor-packs-and-barcode-mapping.md). Tracked on branch `claude/zen-euler-tzw9rv` (PR #737). Step ② (data base) in progress; Steps ③–④ queued.

Turns the [ADR-0737](decisions/0737-inventory-unit-model-stable-base-unit-per-vendor-packs-and-barcode-mapping.md) decision into code. The ADR is the *why*; this is the *how* — exact models, contract shapes, API seams, UI surfaces, and the order they land.

## Goal (one paragraph)

Today an item has exactly one purchase→stock conversion (`purchase_unit` + `pack_qty`, a single global factor) and no concept of weight vs count, no per-vendor pack variance, and no barcodes. This plan adds: a **stable base unit** per item (the existing `unit`, now formally the stocking unit) with a `unit_kind`; **packs** as named, optionally vendor-scoped conversion factors (`case → bag → each` and `12 oz` vs `8 oz`); and **barcodes** mapping `UPC → (item, pack)`. Stock, par, recipes, cost, and the movement ledger stay denominated in the base unit — **unchanged**. Everything is additive; the legacy single-factor path is retained for back-compat and rollback.

## Locked design decisions

- **Conversion moves server-side and is persisted** when a receive/count/waste line carries a `pack_id` — retiring the client-only guess ADR-0592 left (its D5). The operator-confirmed UI stays; only the *source of the factor* changes (stored pack, not a per-invoice `looksLikePackUnit` guess).
- **`packs[]` and `barcodes[]` are inlined on the item DTO** (a handful per item; consistent with how the dataset already inlines per-item data). New DTO fields are **optional/defaulted** so the `GET /api/inventory` contract re-validation and existing fixtures keep parsing.
- **`purchase_unit` / `pack_qty` are kept**, not removed — they become the implicit "default purchase pack", still drive `cost_cents` derivation, and are the rollback cover. A migration backfills one `InventoryItemPack` per item that has `pack_qty > 1`.
- **`on_hand` stays authoritative in base units.** The stock-movement ledger (ADR-0028) and actual-COGS (ADR-0573) are untouched.
- **Out of scope** (per ADR-0737 D6): true catch-weight (weigh-at-receipt), product-UPC scanning of opened packs for floor waste, recipe-unit ≠ stock-unit auto-conversion.

## Branch / PR note

Per session constraints all work lands on `claude/zen-euler-tzw9rv` (PR #737), as well-scoped sequential commits rather than separate branches: ADR + this plan (docs), then Step ② (db + contracts), then Step ③ (api), then Step ④ (ui). The PR title/body will be updated from "docs(ADR)" to the implementation once code lands.

## Step ② — Data base (`packages/db-inventory` + `packages/contracts`)

### Prisma (additive: 2 tables + 1 column)

```prisma
model InventoryItem {
  // ...existing fields unchanged...
  unitKind String @default("count")   // count | weight | volume
  packs    InventoryItemPack[]
  barcodes InventoryBarcode[]
}

model InventoryItemPack {                              // one purchasable/countable package shape
  id                String  @id @default(cuid())
  itemId            String  @map("item_id")
  label             String                              // "Case", "Bag (Vendor B)"
  baseQtyPerPack    Float   @map("base_qty_per_pack")   // this pack = N base units (8oz bag=8, case=500)
  vendor            String  @default("")                // normalizeAlias key; "" = applies to all vendors
  containsLabel     String  @default("")                // display hint, e.g. "10 bags"
  containsQty       Float?  @map("contains_qty")
  isPurchaseDefault Boolean @default(false) @map("is_purchase_default")
  sort              Int     @default(0)
  createdAt         DateTime @default(now())
  updatedAt         DateTime @updatedAt
  item              InventoryItem @relation(fields: [itemId], references: [id], onDelete: Cascade)
  @@unique([itemId, vendor, label])
  @@index([itemId])
  @@map("inventory_item_packs")
}

model InventoryBarcode {                               // UPC/GTIN or internal code -> (item, pack)
  code      String  @id                                 // the scanned/printed code
  itemId    String  @map("item_id")
  packId    String? @map("pack_id")                     // the exact pack (8oz vs 12oz); null = item-level
  source    String  @default("manufacturer")            // manufacturer | internal
  label     String  @default("")
  createdAt DateTime @default(now())
  item      InventoryItem @relation(fields: [itemId], references: [id], onDelete: Cascade)
  @@index([itemId])
  @@map("inventory_barcodes")
}
```

- **Migration**: create tables + add column. **Backfill**: for every item with `pack_qty > 1`, insert one `InventoryItemPack { label: purchase_unit (or "Case"), baseQtyPerPack: pack_qty, isPurchaseDefault: true }`. `unit_kind` defaults `count` = today's implicit behavior.
- **`ARCHITECTURE.md`**: add the two new models to the inventory section (the `docs:check` model-drift guard fails the build otherwise).

### Contracts (`packages/contracts/src/inventory.ts`)

- `InventoryItemSchema`: add optional `unit_kind` (`z.enum(["count","weight","volume"]).optional()`), optional `packs: z.array(InventoryItemPackSchema).optional()`, optional `barcodes: z.array(InventoryBarcodeSchema).optional()`.
- New `InventoryItemPackSchema` / `InventoryBarcodeSchema` + create/save DTOs (`InventoryItemPackSaveSchema`, `InventoryBarcodeSaveSchema`).
- `InventoryReceiveLineSchema`, `InventoryAdHocReceiveLineSchema`, `InventoryCountSubmissionSchema`, `InventoryWasteSubmissionSchema`: add optional `pack_id`. Semantics: **present ⇒ qty is in packs** (server multiplies by `baseQtyPerPack`); **absent ⇒ qty is base units** (today's behavior). `unit_kind` for count submission may need a richer shape (per-item `{ packs, loose }`) — see Step ③.

## Step ③ — Backend (`apps/inventory-api`)

- **Persist + server-side conversion**: in `inventory-store.ts` `receivePurchaseOrder` (currently `onHand + line.qty`, ~L648) and the ad-hoc receive path, when a line carries `pack_id`, look up the pack, apply `qty * baseQtyPerPack` and per-base cost `unit_cost / baseQtyPerPack` (reuse `roundCost`), and record the chosen pack on the stock movement / activity. This is the persisted successor to `convertForReceive` (which stays for the optimistic UI preview).
- **New endpoints**:
  - `GET /api/inventory/barcode/:code` → `{ item, pack }` (scan-to-resolve for receive + count).
  - Pack CRUD under the item: `POST/PUT/DELETE /api/inventory/items/:id/packs` (manager, bearer).
  - Barcode CRUD: `POST/DELETE /api/inventory/items/:id/barcodes` (manager, bearer).
- **Count** `applyCount` (~L438): accept per-item `{ packs (in a chosen pack), loose (base) }`, fold to base units server-side; `on_hand` stays base. Movement/variance math unchanged downstream.
- **Dataset read**: emit `packs[]` / `barcodes[]` / `unit_kind` on each item in `GET /api/inventory` (re-validated against the contract — that's why the fields are optional).

## Step ④ — UI (two PRs, parallelizable after Step ③)

- **backoffice-web** (`components/inventory/item-detail-sheet.tsx`, `add-item-dialog.tsx`): a **Packs** section (add: label, base qty, optional vendor, mark default purchase pack) and a **Barcodes** section (scan/enter UPC → bind to a pack); count form gains "packs + loose"; receive intake uses the stored factor. Add `unit_kind` picker.
- **crew-web** (`components/scan-flow.tsx`, `receive-flow.tsx`, `recount-flow.tsx`): barcode **scan-to-resolve** for receiving + counting; receive/count by pack (+ loose base). Waste stays tap-the-item in base units (ADR scope). Phone camera scanning to start (per the research — adequate for single-shop volume).

## Testing matrix

| Step | Required local gate |
| --- | --- |
| ② db + contracts | `pnpm lint && pnpm build && pnpm test && pnpm docs:check` + `pnpm --filter @rop/db-inventory generate` |
| ③ api | + `pnpm --filter @rop/inventory-api test:integration` (real ephemeral Postgres; conversion + backfill + idempotency) |
| ④ ui | + `pnpm test:e2e` (crew receive/count + backoffice catalog) |

iOS is unaffected: the Native contract-sync CI job was removed and iOS dev is paused, so additive contract fields won't red CI and `sync-contracts` is not run.

## Open questions for the owner (non-blocking)

- Default base unit per category — should "packaging" default `unit_kind=count` and "sweetener/topping" sometimes `weight`? (Can be set per item; no migration needed.)
- Whether to print internal shelf/bin labels now or after the receive/count scan path proves out.
