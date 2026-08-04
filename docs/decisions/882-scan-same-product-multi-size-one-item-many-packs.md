# ADR-882: Invoice scan captures same-product-different-size as one item with many packs

- **Status**: Proposed
- **Date**: 2026-06-21
- **Deciders**: @example-org
- **Extends**: [ADR-0538](./0538-ai-invoice-scan-for-receiving-via-deepseek-vision.md) (AI invoice scan → receive), [ADR-0586](./0586-learned-vendor-aliases-for-invoice-receiving.md) (one canonical item, many vendor names), [ADR-0587](./0587-ai-semantic-match-for-invoice-receiving.md) (confidence-gated AI match), [ADR-0737](./0737-inventory-unit-model-stable-base-unit-per-vendor-packs-and-barcode-mapping.md) (stable base unit + per-vendor packs + barcode mapping)

## Context

Scanning a Walmart receipt that lists the **same product at two sizes** — e.g. `Goldbears 28 oz` (UPC 042238302510, $6.63) and a larger `Gold Bears` ($10.86) — produces **two separate `InventoryItem` rows**, both defaulted to the wrong category ("Dairy & Cream"). This is the duplicate-item anti-pattern that ADR-0586 (naming side) and ADR-0737 (pack side) were both written to kill. ADR-0737 uses *gummy bears* as its literal worked example: "a 12 oz bag and an 8 oz bag are different UPCs → different pack rows" on the **same** item.

The duplicate happens in the **AI invoice-scan → receive** path ([crew `scan-flow.tsx`](../../apps/crew-web/components/scan-flow.tsx), [backoffice `receipt-batch-card.tsx`](../../apps/backoffice-web/components/ai/receipt-batch-card.tsx)). Root causes, verified in code:

1. **No size in the parse.** [`InventoryReceiptParseLine`](../../packages/contracts/src/inventory.ts) carries `pack` as free text ("28 oz") — never a structured measure — so the flow has no `baseQtyPerPack` to build a pack with.
2. **No family grouping.** The matchers ([crew `matchDescription`](../../apps/crew-web/lib/scan.ts), [backoffice `bestCatalogMatch`](../../apps/backoffice-web/lib/inventory/receipt-match.ts)) only match a line against the **existing** catalog + learned aliases. They never (a) cross-reference two *new* lines in the same receipt, nor (b) recognize a new line as a different *size* of an existing item. [`mergeReceiptLines`](../../packages/contracts/src/inventory-match.ts) deliberately only folds *exact* duplicates (same identity+unit+price) — different sizes correctly stay separate, but nothing then unifies them into one item.
3. **Receive can't create packs.** [`receiveAdHoc`](../../apps/inventory-api/src/lib/inventory-store.ts) inline-creates a *flat* item (`packQty=1`, zero `InventoryItemPack` rows) for a new line, and only converts via a pack when the caller passes an existing `pack_id`. There is **no path** to "create an item *with* packs" or "receive into a *new* pack."
4. **Alias forgets the size.** `inventory_item_aliases` maps `(vendor, normalized) → item_id` only — no `pack_id` — so even after a human fixes it, the next scan of that line can't auto-resolve to the right *pack*.
5. **Wrong default category.** crew `scan-flow.tsx` defaults a new line to `categories[0]` = "Dairy & Cream" (first in [`defaultInventoryCategories`](../../packages/contracts/src/inventory.ts)); backoffice defaults to "Other Food". Inconsistent, and crew's default is actively wrong. (Separately, the OFF barcode path's [`categoryFromOff`](../../apps/inventory-api/src/lib/off-lookup.ts) returns "dairy" for candy because "cream" is matched as a substring before "snack" — same class of bug.)

The data model from ADR-0737 (`InventoryItem` ⟶ N `InventoryItemPack` ⟶ N `InventoryBarcode`) is **already correct** — it is simply never produced by the scan path. There is no production data to preserve for this surface yet, so we choose the clean shape, not a backward-compatible bolt-on.

## Decision

Make the invoice-scan → receive pipeline produce the ADR-0737 shape end to end: **one item, many packs**, grouped from the receipt, confirmed by a human, and *remembered* per pack. Seven coordinated changes.

### D1 — Structured size on each parsed line (deterministic, not model-trusted)

Add a shared pure helper `parseSizeToken(text)` to `@rop/contracts/match` that turns "28 oz" / "1.5 L" / "case of 24" into `{ qty: number, unit: string, kind: "count"|"weight"|"volume" } | null` (reusing/extending the unit regex table that already lives in `off-lookup.ts`'s `unitFromQuantity`). The Gemini prompt keeps emitting `pack`/`canonical_name` as today; **we parse the size deterministically** from those strings rather than asking the model for a number — consistent with the codebase rule that the model never emits structured catalog data (ADR-0538 D3). The parsed size is added to the parse-line *view* (not necessarily a stored contract field) and drives `baseQtyPerPack`.

### D2 — A `baseProductKey` for family grouping (shared, deterministic)

Add `baseProductKey(line)` to `@rop/contracts/match`: the canonical name with its size token stripped, folded through the existing `normalizeAlias` + `singularizeToken`, optionally prefixed by the normalized `brand`. `Goldbears 28 oz` and `Gold Bears` both collapse to the same key (`normalizeAlias` already drops spaces: `goldbears`). Two lines with the **same base key but different sizes** are sizes of one product. One function, shared by both web matchers and inventory-api (Iron Law 2), so the grouping key never drifts.

### D3 — Group within the batch AND against the catalog

In the review builders (crew + backoffice), after the existing match tiers run, a new **family-grouping tier**:
- New lines sharing a `baseProductKey` → proposed as **one new item with one pack per distinct size**.
- A new line whose `baseProductKey` matches an **existing** item → proposed as **"add as a new pack of `<item>`"** (not a new item, not a plain base-unit receive).
This is a *suggestion* surfaced for human confirmation (ADR-0538 D4 — the human always commits); never an auto-merge.

### D4 — The receive line can create an item *with packs* and receive *into a new pack*

Extend `InventoryAdHocReceiveLine` so a line may carry a **new-pack spec** (`new_pack: { label, base_qty_per_pack }`) and, for a new item, a `packs[]`-shaped intent. `receiveAdHoc` becomes: resolve-or-create the item (with base unit/kind from the size), `savePack`-idempotently ensure the named pack, then receive `qty × base_qty_per_pack` base units against it. Optionally bind a scanned `barcode` to `(item, pack)` in the same transaction. New-pack spec is only valid alongside a target item (existing `sku` or a new-item spec); a stock-moving line stays operator-confirmed and idempotent exactly as today.

### D5 — Aliases learn the pack, not just the item

Add nullable `packId` to `inventory_item_aliases` (and the DTO), carrying the ADR-0818 `tenantId` seam pattern for new columns. `learnAlias` records `(vendor, normalized) → (item_id, pack_id)`; `resolveLearnedAlias` returns the pack too. The next scan of that exact vendor wording resolves straight to the right **size**, so the memory that ADR-0586 built now operates at pack granularity.

### D6 — Fix the default + add deterministic category suggestion

crew's new-line default changes from `categories[0]` to `"food"` (parity with backoffice). Add a shared `categoryFromText(canonicalName, brand)` helper (corrected keyword rules: candy/gummy/chocolate/snack → food; "cream" matched at a word boundary, most-specific-wins) used by the scan new-item path. Fix the sibling `categoryFromOff` ordering bug in the same change (specificity-ordered, word-boundary "cream").

### D7 — Base unit comes from the size, per ADR-0737

A scanned fixed-weight pack (gummy "28 oz") creates an item whose **base unit is the size's unit** (oz, `weight`), with the bag as a pack of `baseQtyPerPack = 28`. A count pack ("24 ct") → base `each`, pack of 24. This is ADR-0737 D1 verbatim: the base unit is the stable small unit; bags/cases are factors on top.

## Consequences

- **Easy**: one product spans many sizes/vendors without duplicates; on-hand/cost/COGS stay in one stable base unit (ADR-0028/0573 untouched); the scanner finally produces the ADR-0737 shape it was always meant to; per-pack alias memory means the *second* scan of a multi-size haul is one-tap.
- **Migration is additive**: one nullable column (`inventory_item_aliases.pack_id`) + contract DTO fields. No backfill required (no production scan-built packs yet); the column is nullable so legacy aliases keep resolving at item level.
- **Hard / risk**: the review UX grows a grouping concept — mitigated by keeping it a *human-confirmed suggestion* with an easy "split into separate items" escape; a wrong size parse mis-sizes a pack, but the pack factor is a visible, editable row before commit, not silent math, and `parseSizeToken` returning null just falls back to today's flat-item path (fail-soft). Determinism (parse + key in pure, tested helpers) keeps model variance out of the catalog.
- **Boundaries**: stays in `db-inventory` (Iron Law 1); all shared keys/DTOs flow through `@rop/contracts` (Iron Law 2); no new cross-app import.
- **Rollback**: the `pack_id` column is droppable; with `parseSizeToken`/grouping disabled the flow degrades to today's flat-item-per-line behavior.

## Alternatives considered

- **Add a "product family" table above `InventoryItem`.** Rejected: ADR-0737 deliberately rejected a deeper hierarchy — the *item* already is the family and *packs* are the sizes. Adding a tier fragments on-hand/par/recipe linkage for zero gain.
- **Ask the vision model to emit a structured size + group the lines.** Rejected: the model never emits structured catalog data (ADR-0538 D3); deterministic parse + key are testable and variance-free.
- **Auto-merge same-base-key lines without confirmation.** Rejected for the same reason ADR-0592/0586 reject silent application: grouping that mutates the catalog/cost basis must stay human-confirmed.
- **Only fix the default category + warn on duplicates (the cheap fix).** Rejected by the owner: it stops the bleeding but never produces the one-item-many-packs shape the business actually needs; do it right while there's no prod data to migrate.
- **Reuse `mergeReceiptLines` for sizes.** Rejected: that helper's contract is *exact-duplicate* folding (same price/unit); different sizes are genuinely different packs and must stay distinct lines that then attach to one item.
