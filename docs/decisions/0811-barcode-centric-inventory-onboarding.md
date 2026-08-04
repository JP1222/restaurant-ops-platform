# ADR-0811: barcode-centric inventory onboarding

- **Status**: Proposed
- **Date**: 2026-06-19
- **Deciders**: @example-org
- **Extends**: [ADR-0737](./0737-inventory-unit-model-stable-base-unit-per-vendor-packs-and-barcode-mapping.md) (the `InventoryItemPack` + `InventoryBarcode` model this builds the onboarding flow on top of), [ADR-0538](./0538-ai-invoice-scan-for-receiving-via-deepseek-vision.md) (the crew invoice-scan pipeline), [ADR-0028](./0028-sales-driven-inventory-depletion.md) (stock kept in one base unit; depletion accuracy is what the pack-confirmation UX protects)

## Context

ADR-0737 shipped the data model for packs and barcodes (`InventoryItemPack`, `InventoryBarcode` with `source = manufacturer | internal`), the inventory-api write/resolve endpoints, and a backoffice catalog editor (`ItemPackagingSection`). What it did **not** ship is a way to *get products into the catalog quickly*. Today an item is created only by hand — a crew Artículos form, a backoffice add-item dialog, or an inline new-SKU during an invoice scan — and a barcode is attached only by **typing the UPC digits** into a numeric field in backoffice. There is no camera scan-to-register, no UPC auto-fill, no internal-code minting for no-UPC items, and no label printing.

The owner's actual sourcing decides the shape of the answer. Example Kitchen buys **most goods from Sam's Club / Walmart**, which are retail-packaged with **real manufacturer UPC barcodes**. The only no-barcode items are cups/straws/spoons/packaging, for which the owner is willing to **print internal barcodes**. This is materially different from the generic foodservice assumption (cash-and-carry at Restaurant Depot, no barcodes, invoice-as-seed), and it makes the onboarding flow genuinely **barcode-centric**: scan a package UPC → auto-fill → register; mint + print an internal code for the no-UPC supplies.

The hard constraint is **where** scan-to-register lives. Scanning a haul of new products is ergonomically a phone-camera activity (floor-shaped), but it is master-data **creation** (manager-shaped). The codebase's auth model resolves this: inventory write-auth is binary — an active crew session **or** the internal bearer token — and `resolveActor` deliberately returns `{ id, name, locationId }` with **no role field**. The manager-vs-cook boundary is enforced by *surface separation* (which app you are in: crew = Floor, backoffice = manager), per Iron Law #4. There is no role primitive to gate "a trusted cook may register a master item," and inventing one would be exactly the architectural drift the suite guards against.

Two research findings also bear on the decision: (1) `@zxing/browser`, the decoder crew-web lazy-loads today, is effectively discontinued (no npm release in 12+ months); the maintained path is the native `BarcodeDetector` API with the `barcode-detector` ponyfill (zxing-wasm core) — same API surface, still works on iOS Safari, which has no native `BarcodeDetector`. (2) For UPC → product auto-fill, Open Food Facts is the data-boundary-correct source because its full dataset is downloadable (ODbL) and can be **self-hosted**, so a scanned UPC never leaves the host — unlike commercial UPC APIs that require posting each scanned code to a third-party cloud.

## Decision

All catalog **creation** (scan-to-register, OFF auto-fill, internal-code mint, label print) lives in **backoffice-web**, behind the passkey session, used on the manager's phone (backoffice is already mobile-responsive). crew-web stays **resolve-only** and is not modified except for the shared decoder migration. The flow reuses the already-deployed ADR-0737 primitives (`createItem`, `savePack`, `saveBarcode`, `resolveBarcode`) — no new domain table. Specifics:

### D1 — Decoder migration (shared, foundation)

Replace `@zxing/browser` with the native `BarcodeDetector` API plus the `barcode-detector` ponyfill (zxing-wasm fallback) in crew-web's `BarcodeScanner`, lazy-imported so the WASM core stays out of the Floor bundle. The component's external contract (`lang`/`onDetect`/`onClose`, decode-once-then-stop, the denied/nocam/generic error states) is unchanged. This is independent debt repayment on a path crew-web already ships, done first so the ponyfill is validated before backoffice reuses it.

### D2 — Scan-to-register lives in backoffice (the core flow)

A new `ScanRegisterSheet` in backoffice-web: scan UPC → resolve → (already-registered → show item / unknown → review form) → three-step save (`createItem` → optional `savePack` → `saveBarcode`) → camera re-arms for the next package (the rapid-fire haul loop). The review form carries a **match-or-create** control (a "find existing item" search) and an "already registered as X" branch so a missed `resolveBarcode` does not silently create a duplicate. A live plain-English confirmation sentence ("1 case = 24 each · UPC maps to case") guards the pack factor that depletion depends on. crew-web's decoder is factored so backoffice reuses the same headless scanner; the **register write stays backoffice-only** (Iron Law #4).

**Update (2026-06-20 — opened to the floor, supersedes "backoffice-only"):** the owner opted to let line cooks register products too, so crew-web gained a Spanish, camera-first `ScanRegisterFlow` (in the Artículos screen, the `Escanear` button) — UPC scan → OFF auto-fill → create + bind barcode + optional receive-on-register. This needed **no role primitive and no server auth change**: inventory writes are dual-auth (the crew session cookie is accepted), and the floor *already* authored items via "＋ Nuevo" (cost + vendor included), so scan-to-register crosses no new trust boundary — it only adds OFF auto-fill + barcode binding on top of an existing capability. The original D2 reasoning ("crew auth has no role") therefore doesn't gate this: with no role distinction to enforce, scan-register is available to **all** cooks. The mint-internal-code + label-print path (D4) stays backoffice-only for now (kitchen-iPad label printing is awkward).

### D3 — UPC auto-fill from Open Food Facts

A new inventory-api enrichment endpoint `GET /api/inventory/barcode/lookup/:upc` pre-fills a scanned Sam's food UPC's name/category/unit suggestions from Open Food Facts. The endpoint **fails open**: an OFF miss (every cup/straw, store brands, any dev environment, or an OFF outage) returns a blank manual form, never an error.

**Update (2026-06-20 — supersedes the original self-host approach):** the lookup calls the **free OFF public API** (`world.openfoodfacts.org`; no key, no cost). The original D3 self-hosted a daily OFF dump as a filtered SQLite on the Oracle host (read via built-in `node:sqlite`) so the scanned code never left the host. The owner subsequently **approved this egress** — a scanned UPC is a public product barcode, not sensitive data — which made the multi-GB host dataset (build + weekly refresh) unnecessary ops for identical coverage; the SQLite reader + `scripts/rebuild-off-db.mjs` + the `/data/off` mount were removed. Commercial UPC APIs remain **not** adopted: they cost money and still under-cover the store brands (Member's Mark / Great Value) the owner actually buys, and auto-fill only saves typing at *first* registration anyway (the barcode binds to the item thereafter).

### D4 — Internal-code mint + Code128 label print for no-UPC items

For cups/straws/spoons, mint an internal code in a `YR-` prefixed namespace (structurally collision-proof against GS1 GTINs, which are 8/12/13/14 decimal digits) via a Postgres sequence, stored as an `InventoryBarcode` with `source = internal`. Render Code128 with `bwip-js` and print via the browser (`@page`) to a Dymo LabelWriter. The floor then scans the printed label through the existing resolve path — no crew-web change.

### D5 — Receive-on-register (one motion)

After a successful registration, `ScanRegisterSheet` offers an optional, skippable "receive quantity" step that calls the existing `receiveAdHoc` endpoint, so a Sam's haul goes from 0 → actual on-hand in the same scan loop.

### D6 — Incomplete-item nudge via notifications-api

When an item is registered without a pack size, inventory-api emits a best-effort (never-blocking) notification to notifications-api so the manager sees a "finish this item" badge in the backoffice inbox rather than letting half-registered items rot.

### D7 — POS barcode seeding is deferred and conditional

Stopping the Clover `item.code` / Square `CatalogItemVariation.upc` drop at catalog-sync time is held as a **last, conditional** phase: the POS catalog is the *sellable menu* (keyed as `InventoryRecipe`), while Sam's UPCs are on *ingredients*, so this only has value if the owner cross-references UPCs in Clover's code field. If they do not, this decision point is dropped. Any POS-sourced barcode is a manager-reviewed **proposal**, never an auto-write (Iron Law #5).

## Consequences

- **Easy**: the dominant Sam's/Walmart sourcing maps onto a fast scan-to-register loop; the no-UPC supplies get a first-class mint+print answer; the entire create/save chain reuses shipped ADR-0737 endpoints (no new table, one bare Postgres-sequence migration for D4); the data boundary stays clean by construction (OFF self-hosted; the scanned code never leaves the host).
- **Hard / risk**: the three-step save (`createItem` → `savePack` → `saveBarcode`) has partial-failure states the UI must surface; `better-sqlite3` on Alpine musl may need `sql.js` as a fallback; the OFF dump is a ~5–8 GB host-only one-time build with a weekly refresh cron (host-ops, not CI); iOS Safari camera requires HTTPS, so the local dev path must lean on the type-it-instead fallback.
- **Boundaries**: creation stays in backoffice (Iron Law #4); cross-app DTOs (`InventoryBarcodeEnrich`, mint request/response, notification payload) go through `packages/contracts` (Iron Law #2); POS data only *proposes* (Iron Law #5); the OFF lookup is a read-only enrichment with no write-back and no third-party egress.
- **Lethal trifecta**: OFF auto-fill adds an external-data *intake* path; it must never be wired into an AI surface that also holds private data + an outbound channel. It is a plain server-side keyed lookup, not an AI input.

## Alternatives considered

- **Floor-capture → manager review queue** (a cook scans the haul; items land in a backoffice "To Review" queue). Strong ergonomics, but it needs a new `InventoryItemProposal` table + staging boundary and leans on a floor "role" the auth model does not express. Rejected as the default for cost and for inventing a role primitive; its match-or-create review UX and a lightweight "flag an unknown UPC for the manager" on-ramp are grafted in as later, optional work.
- **Unified receiving-scan on the crew surface** (one loop does resolve-or-register-then-receive on the Floor). Best match to the physical put-away motion, and crew-web already owns some catalog edit (cost/vendor). Rejected because first-time master-data creation on the shared-iPad/PIN Floor session blurs Iron Law #4 with no role to gate it; its unified scan→receive motion is preserved as D5 inside backoffice.
- **Commercial UPC lookup API (UPCitemdb / Go-UPC) as the default auto-fill.** Broader coverage, but posts each scanned code to a third-party cloud with retention/terms we do not control — the repo's own guidance says a mature option that ships our data off-host is not automatically better. Kept only as a possible explicit, manager-opt-in, single-item fallback; never the default.
- **Keep `@zxing/browser`.** Rejected: discontinued (no release in 12+ months), and the ponyfill is a near-drop-in with a maintained core and the same iOS-Safari fallback.
- **Do nothing (manual typing only).** Rejected — this ADR exists because hand-typing UPCs is the current state and is exactly the onboarding friction the owner asked to remove.
