# ADR-0737: Inventory unit model: stable base unit, per-vendor packs, and barcode mapping

- **Status**: Accepted
- **Date**: 2026-06-17
- **Deciders**: @example-org
- **Extends**: [ADR-0028](./0028-sales-driven-inventory-depletion.md) (stock kept in one usage unit), [ADR-0586](./0586-learned-vendor-aliases-for-invoice-receiving.md) (per-vendor wording memory), [ADR-0589](./0589-per-vendor-price-intelligence.md) (per-vendor price)
- **Supersedes**: the client-only / not-persisted half of [ADR-0592](./0592-operator-confirmed-pack-unit-conversion.md) (D2/D5) — the pack factor becomes persisted catalog data instead of a per-receive client guess

## Context

The owner hit three real shapes the current model can't hold:

1. **Multi-level packaging.** A cup is bought by the **case**, a case holds **bags**, a bag holds **each** — and nobody knows (or wants to count) the each. Today `InventoryItem` has exactly one conversion: `purchase_unit` + `pack_qty` (a single global factor, schema lines 39–43). It can say "1 case = 1000 each" but not "1 case = 10 bags = 500 each", and it can't let the floor count in bags while stock stays in each.
2. **Same item, different vendors, different pack counts.** Vendor A ships a case of 500 cups; Vendor B ships a case of 480. `pack_qty` is **global per item**, so today the only way to represent both is to split into two items — the duplicate-item anti-pattern that ADR-0586 fought on the *naming* side but that still bites on the *pack* side.
3. **Fixed-weight retail packs.** Gummy bears come as a 12 oz bag from one brand and an 8 oz bag from another. The owner needs total weight (for cost and recipe portioning) but staff physically handle **bags**. There's no unit "kind" today — `unit` is free text — so the system can't tell "deduct one bag" (which bag?) from "deduct 8 oz", and the two readings disagree.

Adjacent facts about today's model:

- `on_hand`, par levels, recipe lines, and the stock-movement ledger are **already** all denominated in the item's single `unit` (ADR-0028). That part is right and stays.
- ADR-0592 already converts purchase→stock at receive, but **client-side, operator-confirmed, and not persisted** — it re-guesses `looksLikePackUnit()` every invoice and stores only the converted each-values. Its own D5 flags "persist the pack intent" as the follow-up. This is that follow-up.
- `inventory_item_aliases` already learns per-vendor wording and per-vendor `lastCostCents`, and carries a free-text `pack` descriptor — but that descriptor doesn't drive any math.
- There is **no** barcode / GTIN anywhere; items are keyed by `sku` (a string id).

Industry note (R365, Toast xtraCHEF, Odoo, Business Central, MarketMan all converge here): you do **not** pick one of box/bag/each. You denominate stock in one stable **base unit** and treat every pack as a named conversion factor, vendor-scoped where it varies. True *catch weight* (variable weight per piece — fresh fish by the pound) is a separate, heavier feature and is explicitly **out of scope**: the gummy packs are fixed-weight, so they need conversion factors, not a scale at receiving.

## Decision

### D1 — One stable base unit per item is the single source of truth

`InventoryItem.unit` is formally the **base (stock) unit**: the smallest unit the item is consumed in (`each`, `oz`, `g`, `ml`). `on_hand`, `par_min/max`, recipe/modifier lines, `cost_cents` (per base unit), and every `InventoryStockMovement.delta` stay in base units — **no change to existing semantics**. The base unit must be *stable*: never a "bag", because a bag's size varies by vendor (context #2/#3). Add `unit_kind` (`count` | `weight` | `volume`, default `count`) so the UI renders correctly and so "consume one pack" always resolves to a concrete base quantity.

### D2 — Packs are named, composable conversions to the base unit (flat-with-factors, not a rigid tree)

New table **`InventoryItemPack`**: one row per purchasable/countable package shape for an item, each carrying `baseQtyPerPack` (how many base units the pack equals). A three-level case→bag→each is authored as two pack rows (`bag` = 50 each; `case` = 500 each) with an optional `containsLabel`/`containsQty` hint for display ("1 case = 10 bags"). We deliberately keep packs a **flat set with factors**, not an arbitrary nested tree — this matches R365/xtraCHEF/Odoo and covers the 2–3 levels the business actually has without a recursive schema.

### D3 — Pack conversions can be vendor-scoped

`InventoryItemPack.vendor` (normalized key, same convention as `inventory_item_aliases.vendor`; `""` = applies to all vendors). Vendor A's "case = 500 each" and Vendor B's "case = 480 each" are two rows on the **same** item; `on_hand` is always in each, so the duplicate-item workaround dies. Receiving looks up the vendor's pack factor and persists it — precisely the persistence ADR-0592 D5 deferred. A confirmed receive may also upsert/teach the matched pack onto the `inventory_item_aliases` row (extends ADR-0586/0589: per-vendor wording + price + **now pack**).

### D4 — Barcodes map to (item, pack), many-to-one

New table **`InventoryBarcode`**: `code` (unique, the GTIN/UPC or an internal code) → `itemId` (+ optional `packId`), with `source` (`manufacturer` | `internal`). A 12 oz bag and an 8 oz bag are *different UPCs* → different pack rows → scanning resolves to the **exact** base quantity (solves context #3's "deduct a bag vs deduct 8 oz": the scanned pack *is* 8 oz). Internal/printed codes cover no-UPC and house-prepped items and shelf/bin location tags. Identity stays on `sku`; barcodes are an additive lookup, never the primary key.

### D5 — Operating principle (the part that keeps staff from breaking it)

**Staff always act in the physical unit they are holding; the system owns every conversion — no human ever does pack math in their head.** Floor flows let a cook receive/count/consume by the **pack** (scan it, or tap it) with an optional "loose (base unit)" field for an opened pack; par levels and all reporting render in the base unit (with a pack-equivalent shown alongside). Because the base unit is stable (D1), "10 bags on hand" is never ambiguous internally — it's stored as base units.

### D6 — Scope and sequencing

**In, v1:** `unit_kind`; `InventoryItemPack` (vendor-scoped); persisting the receive conversion (retiring ADR-0592's client-only guess in favor of the stored factor); `InventoryBarcode`; **scan-to-resolve on receiving and full-pack counts**; a count UI that accepts "N packs + loose base". Contract DTO changes flow through `@rop/contracts` (Iron Law 2).

**Explicitly out (deferred or rejected):**
- **True catch weight** (weigh-every-piece at receipt, variable per unit). Fixed-weight packs only — revisit only if a by-the-pound item appears.
- **Product-UPC scanning for floor waste/86.** An opened bag has nothing to scan; that path stays tap-the-item or scan-a-shelf-label (the bar-inventory norm). Scanning is for sealed receiving + counting.
- **Recipe-unit ≠ stock-unit auto-conversion.** Recipes already consume in the base unit; no need yet.

## Consequences

- **Easy**: one item spans many vendors and pack sizes without duplicates; the floor counts/handles whatever is convenient while stock, cost, and COGS stay in a stable base unit; receiving and full-pack counts get a fast, low-error scan path; the "weight vs bag" question dissolves (store weight, act in bags, show both).
- **Migration is additive.** New tables (`InventoryItemPack`, `InventoryBarcode`) and one defaulted column (`unit_kind` → `count`). `purchase_unit` + `pack_qty` are **retained** as the implicit default pack and as rollback cover; a backfill can seed one `InventoryItemPack` per item from them. `on_hand` semantics are unchanged, so the ledger (ADR-0028) and actual-COGS (ADR-0573) are untouched.
- **Hard / risk**: catalog-setup UX grows (a manager now defines packs, optionally per vendor) — mitigated by keeping `pack_qty` working so simple items need no packs. A wrong pack factor mis-counts on-hand, but receive stays operator-confirmed (ADR-0592's human-in-the-loop is kept, just seeded from stored factors now), and a wrong barcode→pack mapping is a visible, correctable row, not silent math.
- **Boundaries**: stays inside `db-inventory` (Iron Law 1); DTOs go through `contracts` (Iron Law 2). No new cross-app import.
- **Rollback**: drop the two tables + the column; the legacy single-factor path (`purchase_unit`/`pack_qty` + ADR-0592 client conversion) still functions because it was never removed.

## Alternatives considered

- **Keep `pack_qty` global, split per-vendor pack sizes into separate items.** The status quo. Rejected: re-introduces the duplicate-SKU-per-vendor anti-pattern ADR-0586 worked to kill, fragments on-hand/par/cost across phantom items, and breaks recipe linkage.
- **Make "bag" the stocking unit and decrement bags.** The owner's first instinct, and fine *if* every vendor's bag were identical. Rejected: bag size varies by vendor (A=50, B=40) and gummy bags vary by weight (8 oz vs 12 oz), so "bags on hand" is not a stable quantity — the base unit must be each/oz, with bags as factors on top.
- **Full catch-weight (dual unit of measure, weigh at every touch).** The food-distribution ERP pattern for variable-weight goods. Rejected as over-engineered: the packs here are fixed-weight, so a stored `baseQtyPerPack` is exact and a scale is unnecessary. Left as a future ADR if a true by-weight item appears.
- **Recursive pack tree (pack contains pack contains pack, arbitrary depth).** Rejected: the business has 2–3 fixed levels; a flat set of packs each carrying `baseQtyPerPack` (with a display hint for "case = 10 bags") is simpler to author, query, and reason about, and is what the mature systems do.
- **Auto-learn and auto-apply pack factors with no confirmation.** Rejected for the same reason ADR-0592 rejected it: silent application to stock + cost math is the corruption risk. Factors are authored or operator-confirmed; the alias may *suggest*, never auto-commit.
- **Do nothing.** Leaves the owner choosing box-vs-bag-vs-each per item, duplicating items per vendor, and with no answer for weight packs or fast receiving. Rejected — this ADR exists because "do nothing" is what hurts today.
