# ADR-0028: Sales-driven inventory depletion via an append-only stock-movement ledger

- **Status**: Proposed
- **Date**: 2026-05-31
- **Deciders**: @example-org
- **Builds on**: [ADR-0022](0022-loyalty-ledger-and-accrual.md) (append-only, idempotent, one-way ledger — reused here for stock), [ADR-0018](0018-multi-location-architecture.md) (location scoping), [ADR-0027](0027-clover-online-payment-and-order-bridge.md) (Clover orders — in-store + online — fire the webhook → sync path), and the "event-sourced stock ledger" option recorded in docs/inventory-handoff.md §5.
- **Absorbs**: the narrower "wire COGS to analytics" idea floated in conversation — COGS now derives from this ledger, so no separate ADR is needed.

## Context

The owner wants **perpetual (theoretical) inventory**: every Clover sale should auto-deplete the components it consumes via a per-item **BOM** (bill of materials). One ice cream sold → −1 cup, −1 spoon, −N oz base, −Y syrup, etc. Today `on_hand` is a mutable scalar mutated only by manual flows (count / waste / receive); COGS, net-sales and `sold_today` are seeded `InventoryMetrics` placeholders deferred to analytics-api by Iron Law 5.

Grounding facts (verified 2026-05-31):

- **The sales-event stream already exists.** Clover orders — in-store and online ([ADR-0027](0027-clover-online-payment-and-order-bridge.md)) — are ingested by analytics-api **with line items and modifiers** (`ORDER_EXPAND` includes `lineItems.item` + `lineItems.modifications`) into `mart.fact_order_line_items`. analytics-api already exposes HTTP reads (`/admin/api/items`, `/admin/api/sales`) reachable at `INTERNAL_ANALYTICS_API_URL`.
- **BOMs have a partial home.** `InventoryRecipe.lines` already models `{ component sku, qty }`. Missing: (a) a link from a Clover menu item to a recipe (the join key), (b) modifier-level lines, (c) a per-unit vs per-order distinction for packaging.
- **The correction side already exists.** Counts (physical recount) and Waste flows are built; theoretical inventory always drifts from physical (over-portioning, spillage, comps), so auto-depletion must be paired with these as the correction mechanism — not treated as exact.

Boundary constraints that shape the design:

- **Iron Law 5** — analytics-api is read-only OLAP; it must **not** write inventory. Whoever applies depletion writes through inventory-api.
- **Iron Law 1** — no cross-app DB-client import; the engine reads analytics over **HTTP**, never its database.
- **handoff "don't build" list** — no BullMQ/Redis job infra for this; a scheduled poll inside inventory-api suffices.

## Decision

**Model stock as an append-only movement ledger; deplete from sales in a batch worker inside inventory-api that reads normalized line items from analytics-api over HTTP.** Concretely:

1. **`InventoryStockMovement` — append-only, location-scoped ([ADR-0018](0018-multi-location-architecture.md)).** Columns: `id`, `location_id`, `item_id`, `delta` (signed int, in the item's stock unit), `reason` (`sale` | `waste` | `receive` | `count_adjust` | `manual`), `source_ref` (nullable), `actor`, `created_at`. `on_hand` becomes the projection `start + Σ delta`, maintained on `inventory_item_state`. This is the **same append-only, idempotent, one-way pattern already accepted for the loyalty points ledger in [ADR-0022](0022-loyalty-ledger-and-accrual.md)** — applied to stock.
2. **Idempotency is the foundation (absorbs handoff P1).** Unique `(reason, source_ref)`. For `sale` depletion, `source_ref` = the Clover **line-item id**, so a replayed or re-ingested order line **cannot double-deplete**. Manual writes (waste/count/receive) also carry an idempotency key, retiring the ad-hoc "don't re-receive a received PO" guard.
3. **Batch depletion engine in inventory-api** (owner Decision A). A scheduled poll (no new job infra — a timer in the inventory-api process) calls analytics-api for line items since a stored watermark, resolves each line to a BOM, appends `sale` movements in one transaction, and advances the watermark. Reads analytics via HTTP (Iron Laws 1 + 5 honored); writes only inventory's own DB.
4. **New analytics-api read endpoint** — `GET /api/sales/line-items?since=<cursor>&location=<id>` → normalized `{ clover_line_item_id, clover_item_id, item_name, quantity, modifiers[], business_date, location_id }`, served read-only from `mart.fact_order_line_items`. analytics stays a read source.
5. **BOM model extensions in `packages/contracts` (Iron Law 2):** add `clover_item_id` (+ `clover_item_name` for display) to `InventoryRecipe` as the sale→recipe join key; allow modifier-keyed extra lines (`clover_modifier_id` → component deltas); tag each line `per_unit` (1 cup per drink) vs `per_order` (1 bag per ticket).
6. **COGS derives from the ledger.** COGS for a period = `Σ (sale-delta × item cost)`; `sold_today` = count of `sale` movements per recipe. This **retires the `InventoryMetrics` COGS/sold-today placeholders** — the Overview tab reads real numbers with no separate analytics-join in the BFF.
7. **Reconciliation is unified.** Counts → `count_adjust` deltas, Waste → `waste`, Receiving → `receive`. Every flow is one ledger reason; `on_hand` is always `start + Σ` and fully auditable.
8. **Clover catalog pull for BOM bootstrap.** Extend the Clover client with `/v3/merchants/{id}/items` + `/modifier_groups` to seed the recipe/modifier list (the left column of the BOMs) carrying `clover_item_id`. It must run where the Clover token lives (deployed system or a local run with creds), exposed as a one-shot operator-triggered sync.

### Phased rollout

- **Phase 1 — foundation (no behavior change):** `InventoryStockMovement` migration; `on_hand` becomes a projection; idempotency keys on existing writes. Seed the **packaging / disposables** catalog (cups, straws, bags, spoons, napkins) per the owner's "先录入纸杯吸管" — these are the universal `per_unit`/`per_order` components.
- **Phase 2 — depletion (item-level):** analytics line-item read endpoint; inventory-api batch worker; `recipe.clover_item_id`; Clover catalog pull → BOM bootstrap.
- **Phase 3 — BOM editor:** an in-app (backoffice) editor so the owner maintains recipes + modifier BOMs (the rest of the ingredients — fruit, milk, sugar, syrup, cream, smoothie powder).
- **Phase 4 — modifiers + COGS:** modifier-level depletion; COGS/sold-today derived from the ledger replaces the placeholder on the Overview tab.

**Modifier timing:** the owner did not pin (a) "modifiers now vs later." Decision: **item-level depletion ships first (Phase 2), modifier-level is designed into the schema from day one but applied in Phase 4.** Rationale: get the core engine + base recipes correct before layering modifier math; the schema does not need to change to add it. Revisit if modifier-driven consumption (sizes, add-ins) proves too material to defer.

## Consequences

- `on_hand` becomes a **derived, auditable projection** (event-sourced) rather than a mutable scalar — a larger change than a counter, but the correct model for a stream of sale deltas, and it folds the existing waste/count/receive flows into one ledger.
- inventory-api gains a scheduled poll + a read-only HTTP dependency on analytics-api; analytics-api gains one read endpoint; `packages/contracts` gains the recipe mapping + modifier + packaging-granularity fields.
- **Idempotency is now mandatory** (a feature, not a tax — it makes replayed Clover lines safe and completes handoff P1).
- Theoretical inventory is a **continuously-corrected estimate**; it will drift and is reconciled by physical Counts. This must be set as an expectation, not sold as exact stock.
- Until Phase 4, depletion/COGS slightly mis-counts modifier-driven consumption (e.g. "add whipped cream", "large").

## Alternatives considered

- **Real-time Clover-webhook depletion.** Rejected as the first cut (owner chose batch): gives instant "remaining stock" but duplicates the ingestion + dedup analytics already performs; batch reuses it. Revisit if live remaining-count becomes a hard requirement.
- **Mutable `on_hand` scalar (no ledger).** Rejected: simplest, but loses the audit trail and makes idempotent dedup of replayed sales awkward; depletion is inherently a delta stream, which a ledger models natively.
- **Depletion engine in analytics-api or kds-api.** Rejected: analytics writing inventory violates Iron Law 5; kds-api touching the inventory DB violates Iron Law 1 (it would have to call inventory-api regardless). inventory-api owns inventory writes, so the engine lives there.
- **analytics-api computes COGS.** Rejected: it would need inventory ingredient costs, crossing the boundary; COGS instead falls out of the inventory ledger for free.
