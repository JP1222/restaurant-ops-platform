# ADR-0526: Manage inventory catalog — items, vendors, purchase orders

- **Status**: Proposed
- **Date**: 2026-06-04
- **Deciders**: @example-org

## Context

Inventory 1.0 shipped **operations-first**. The high-frequency floor/manager actions are
real and persist: count, waste, receive, 86/un-86, sync-sales, edit item cost & conversion
(`PUT /api/inventory/items/:id`), and edit recipe (`PUT /api/inventory/recipes/:id`), plus
full crew CRUD.

**Catalog management is absent.** In `apps/backoffice-web` these buttons are decorative —
no `onClick`, no API behind them:

- Items tab: **Add item**, **Export**; item detail: **Edit par**, footer **Count**.
- Vendors tab: the entire surface — **Add vendor**, **Edit vendor**, **New PO**, **Statement**.
- Item **delete**: no button, no endpoint anywhere.

Vendor, PO, and item-catalog rows are **seed-only** (`packages/db-inventory/prisma/seed.ts`).
There is no `POST /items`, no `DELETE /items/:id`, no vendor route at all, and no PO-create
route. The inventory-api write surface is counts / waste / receive / toggle-86 / sync-sales /
`PUT items/:id` / `PUT recipes/:id` / crew-admin — nothing that adds, removes, or manages the
catalog.

Three decisions gate building catalog management. They are **data/interaction** decisions a
visual mockup cannot answer, and the visual design already exists (the buttons + detail sheets
are built and styled). Fixing them here lets implementation **clone existing patterns** rather
than design anew: `components/crew/add-crew-dialog.tsx` (create), the Cost & conversion inline
editor + `recipe-editor.tsx` (edit), the crew-admin API (`POST/PATCH` + soft-disable), and the
PR #519 idempotency-key pattern.

### Schema facts that drive the decisions (verified 2026-06-04)

- **Item references are almost all loose strings, not FKs.** The only FK-enforced inbound
  reference to `InventoryItem` is `InventoryItemState` (`onDelete: Cascade`). `InventoryRecipeLine.sku`,
  `InventoryRecipeModifier.sku`, `InventoryVendorQuote.sku`, `InventoryPoLine.sku`,
  `InventoryWasteEntry.sku`, and `InventoryStockMovement.itemId` all reference an item by string
  with **no FK**. The DB will not block a hard delete; it will silently orphan those rows.
- **Par is per-location state, not catalog.** `InventoryItem.par_min/par_max` are brand-catalog
  *defaults*; the live numbers live in `InventoryItemState` keyed by `(location_id, item_id)`
  (ADR-0018). The API merges state over catalog on read. This is exactly why `PUT items/:id`
  deliberately excludes par/on_hand.
- **Vendor is already a rich entity, but linkage is by name.** `InventoryVendor` carries
  contact/terms/performance. But `InventoryItem.vendor` and `InventoryPurchaseOrder.vendor` are
  **name strings**, and `InventoryVendorQuote.vendorId` is an id string with no FK relation.
- **Read DTOs exist; write DTOs do not.** `packages/contracts/src/inventory.ts` has
  `InventoryVendorSchema`, `InventoryPurchaseOrderSchema`, etc. for reads, but no
  `…Save`/`…Create` write schemas for vendors or POs.

## Decision

### D1 — Item lifecycle: soft-delete (archive), never hard-delete; make par editable; add "Add item"

- **Delete = archive, never hard-delete.** Add `archivedAt DateTime?` to `InventoryItem`.
  "Delete" hides the item from the active list + status filters and excludes it from reorder /
  PO pick, but the row is retained so recipe lines, PO/waste/movement history, and sales-sync
  depletion (which matches `recipe.line.sku → item`) stay intact. This mirrors the crew
  **soft-disable** pattern (`active=false` preserves `who`-attribution). Reads gain an
  `?include=archived` (default excludes); the merged dataset stays resolvable for history.
- **Par becomes editable — and writes per-location state, not the catalog row.** Wire the
  existing **Edit par** button to a location-scoped write that upserts `InventoryItemState`
  (`default-location` for the single store), *not* the `InventoryItem` columns. Either a new
  `PUT /api/inventory/items/:id/par` or an extension of the item write that routes par to state.
- **Add item** — new `POST /api/inventory/items`. Required fields: `name`, `category`, `unit`,
  `vendor` (name), `par_min`/`par_max`, and `purchase_unit`/`pack_qty`/`purchase_cost_cents`
  (usage `cost_cents` derived server-side, as the editor already does); `id` + `sku` generated
  server-side. Clone `add-crew-dialog.tsx` for the form.

### D2 — Vendor model: manage `InventoryVendor` as its own entity; keep `item.vendor` / `po.vendor` as denormalized **name** strings (do NOT promote to a FK now)

- Build vendor **Add / Edit / Archive** against the existing `InventoryVendor` entity with new
  write DTOs + routes (`POST /api/inventory/vendors`, `PUT /api/inventory/vendors/:id`,
  soft-archive). Wire the Vendors-tab buttons.
- **Keep `item.vendor` and `po.vendor` as name strings; do not migrate to `vendorId` FK.**
  Rationale: single store, the name is the natural key the floor reads, and promoting to a FK is
  an invasive migration + name-match backfill for little gain at this scale (YAGNI — same spirit
  as the handoff's "don't pre-build multi-tenancy"). This keeps the change **additive**: new
  vendor write paths only, zero change to how items/POs store their vendor. Revisit only if
  duplicate/renamed vendors become a real operational problem.
- Vendor archive is soft (POs, quotes, and `item.vendor` strings reference it historically).

### D3 — Purchase-order authoring: a minimal draft → ordered builder; receive unchanged; idempotent create

- **New PO builder**: pick a vendor (from the vendor list, stored as its name), add lines from
  the item catalog (`sku` = item id, `qty_ordered`, unit cost); server computes `total_cents` +
  `lines` count; `status` starts `draft`, transitions to `ordered`. The **receive** flow already
  exists, is unchanged, and is already idempotent (stock-movement `source_ref`).
- New routes: `POST /api/inventory/pos` (create), `PUT /api/inventory/pos/:id` (edit while
  `draft`/`ordered`, not after receiving). Carry an optional `idempotency_key` consistent with
  PR #519 (waste/count).
- **Scope cut for now** (revisit on real need): no vendor min-order enforcement, no auto-suggest
  from below-par (the Overview reorder cart can feed the builder later), no email/print/EDI.
  Draft + manual send only.

## Consequences

- **Additive migrations only**: `InventoryItem.archivedAt`; vendor write DTOs + routes; PO write
  DTOs + `idempotency_key` on PO. No breaking contract change. The pre-existing `sku`-carries-`id`
  debt is left untouched — do **not** entangle this with the separate coordinated rename in
  inventory-handoff §5 P2.
- **Reads must filter archived** out of the active dataset while keeping archived items resolvable
  for history + recipe integrity (so depletion and reports don't break). One read carve-out:
  the GET dataset gains an `?include=archived` (or an `archived` flag per item).
- **Soft-delete never frees a SKU/name.** Acceptable for a single store that rarely reuses SKUs;
  reuse can archive + rename.
- **Effort tiers**: D1 par + archive = small; D1 add-item + D2 vendor CRUD = medium (clone
  dialogs); D3 PO builder = largest (the one genuinely new flow).

## Alternatives considered

- **Hard delete** — rejected. No FK protection; silently corrupts sales-sync depletion (orphaned
  `recipe.line.sku`) and waste/movement history.
- **Promote `item.vendor` → `vendorId` FK now** — rejected for scale: invasive migration +
  name-match backfill + touches the item editor, for little single-store gain. Documented as a
  future option if vendor dedup/rename becomes real.
- **Full PO lifecycle** (approvals, min-order enforcement, auto-reorder, EDI) — rejected as
  over-engineering for one store; mirrors the handoff's "DO NOT BUILD" list.
- **Do nothing (catalog stays seed-only)** — rejected: the owner needs to add/retire items and
  manage vendors without editing the seed + redeploying.

## Implementation sequence (clone existing patterns — no new visual design)

1. **Item par edit + archive** — smallest, highest daily value. Migration `archivedAt`;
   location-scoped par write; wire the existing **Edit par** button + an archive action.
2. **Add item** — `POST /items`; clone `add-crew-dialog.tsx`.
3. **Vendor CRUD** — clone `add-crew-dialog` + crew-admin API; wire the Vendors-tab buttons.
4. **New PO builder** — the one genuinely new UI flow.

Each step: `packages/contracts` (zod) → `apps/inventory-api` route + store + tests →
`apps/backoffice-web` BFF route + `use-inventory` hook + wire the existing button. Gate with
`pnpm lint && pnpm build && pnpm test` (+ `pnpm test:integration` for the DB paths).
