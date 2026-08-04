# Multi-Location Architecture & Status

> **Status:** current — the **within-tenant** location model. Locations are stores *inside a tenant*; the tenant boundary above them is canonical in [architecture/multi-tenant-architecture.md](architecture/multi-tenant-architecture.md). The `locationId`-vs-`merchantId` distinction here is the *partition* model underneath `tenant_id` (the trust boundary). The intentionally-deferred work below is now sequenced in [multi-tenant-migration-roadmap.md](multi-tenant-migration-roadmap.md).

> Orientation doc for anyone (human or AI) picking up the multi-store work.
> Decisions live in [ADR-0018](decisions/0018-multi-location-architecture.md) (umbrella)
> and [ADR-0019](decisions/0019-decouple-store-identity-from-clover.md) (POS decoupling).
> This file is the narrative + status + how-to-extend that ties them together.

## TL;DR — what this is (and isn't)

This doc describes **location scoping *within one tenant***. Example Kitchen is becoming a
**Toast-style multi-tenant platform** (`Tenant → Location → Device`) — the tenant
boundary and its hard cross-tenant isolation are canonical
[upstream](architecture/multi-tenant-architecture.md). A **`Location`** is a store
*inside* a tenant; today there is one tenant (the owner's brand) with two locations, so
everything described here is also exactly what runs in production.

What that means for scope:

- **`tenant_id` is the trust boundary; `locationId`/`merchantId` are partition keys
  underneath it.** Cross-*location* visibility *within a tenant* is a feature — both
  owner accounts see all of the tenant's stores, and consolidated + side-by-side
  reporting is a goal, not a leak. Cross-*tenant* isolation is a separate, harder
  boundary (RLS + an authenticated claim) covered [upstream](architecture/multi-tenant-architecture.md).
- The next store **might not be Clover.** The model is POS-agnostic on purpose so a
  non-Clover store is additive, not a rewrite (ADR-0019).

## Core model: `locationId` (canonical) vs `merchantId` (POS partition)

We introduced a canonical, POS-agnostic **`Location`** identity but deliberately did
**not** re-thread the existing `merchantId` out of KDS/analytics. The two keys
coexist:

| Data domain | Scoped by | Why |
| --- | --- | --- |
| POS-derived (KDS tickets/orders, analytics sales) | **`merchantId`** (Clover merchant id) | Already on every row, DTO, and WebSocket path. Re-threading would be high-risk churn for zero benefit. |
| Brand-owned (inventory) | **`locationId`** (POS-agnostic) | Inventory isn't tied to a POS; the owner wants other POS systems possible. |
| Registry / switcher / settings | **`locationId`** canonical, maps 1→N to `merchantId` | A Location *has* a POS binding (Clover today). 1 location = 1 merchant today; the model allows other POS later. |

`Location` lives in **`packages/db-kds`** (the existing home of the POS-connection
domain), not a new package — so the `CloverMerchant.locationId` FK is a same-package
relation, not a cross-Prisma-package FK Prisma can't model cleanly.

Key constants:

- `BRAND_SCOPE_ID = "default-merchant"` — the reserved scope id for brand-tier
  `app_setting` rows (kept at the pre-multi-location value so existing rows need no
  backfill). Only `apps/backoffice-web/lib/settings/**` references it.
- `DEFAULT_LOCATION_ID = "default-location"` — the single-store default for
  inventory's `location_id` columns + `InventoryItemState`.

`CloverMerchant` is misnamed: per ADR-0019 it is the **generic store-account** table,
already used by non-Clover sources (Deliverect) via a synthetic id. Renaming it is
deferred until a non-Clover store actually lands. Don't bake Clover-only assumptions
onto it.

## What shipped (by phase)

| Phase | What | PR(s) |
| --- | --- | --- |
| 0 | `Location` model + `CloverMerchant.locationId` + `lib/location/**` carve-out (ADR-0018) | #267 |
| 1 | Tiered settings scope (brand vs location) + Location read seam; replace hardcoded merchant id with a scope resolver | #269 |
| 2 | Backoffice store switcher + Locations admin page; analytics dashboards route by the active store | #271, #281 |
| — | ADR-0019: decouple store identity from Clover (Option C) | #273 |
| 3 | Analytics de-singletoned — `config.sync_targets`, one Scheduler iterating active targets, per-store timezone, env bootstrap fallback | #277 |
| 4 | Inventory per-location: `location_id` on store-level tables (part 1), API filters reads/writes by location (part 2), per-store stock state `InventoryItemState` (part 3) | #279, #280, #284 |
| 5 | KDS device resolves its store from its token (`KdsDeviceToken.merchantId`) instead of a hand-typed `?merchantId=` | #288 |
| — | Create-store onboarding: Locations admin **Add store** (server slug-dedup + default hours seed) | #706 |

### Per-domain specifics

- **Backoffice** (`apps/backoffice-web`): reads `Location` / `CloverMerchant` only
  through `lib/location/**` (a db-kds carve-out, eslint-enforced, same pattern as
  `lib/settings/**` and `lib/ai/**`). The `StoreSwitcher` persists the active store
  to the `yr_active_location` cookie; `lib/location/scope.ts` reads it server-side and
  maps `locationId → merchantId`, which the analytics BFF passes as `?merchant_id=`.
  A selected store with no POS binding resolves to its own `locationId` (matches no
  mart rows → "no data") rather than silently showing the default store's numbers.
- **Analytics** (`apps/analytics-api`): cannot import db-kds (Iron Law 1), so it owns
  `config.sync_targets` (`merchant_id`, `provider`, `token`, `store_timezone`,
  `active`). One `Scheduler` re-reads active targets each tick; a per-merchant
  `CloverClient` factory resolves the right client per `job.merchantId`; the
  webhook-inbox filter accepts any merchant in active targets. Single-store deploys
  bootstrap one target from env on boot. `?merchant_id=` selects the store on the
  dashboard reads, falling back to the env default.
- **Inventory** (`apps/inventory-api` + `packages/db-inventory`): store-level tables
  (`inventory_purchase_orders`, `inventory_po_lines`, `inventory_count_records`,
  `inventory_waste_entries`, `inventory_activity_entries`, `inventory_employees`)
  carry `location_id`. Live per-store **stock state** (`on_hand`, par levels,
  `last_counted`, `flagged_86`) lives in `inventory_item_state` keyed by
  `(location_id, item_id)`; the `InventoryItem` columns are the brand catalog
  defaults **and** a non-destructive fallback for a location with no row yet. The API
  merges catalog + state back into the same `InventoryItem` DTO, so the
  `InventoryDataset` contract is untouched. The crew session derives the actor's
  `locationId`, which scopes writes.
- **KDS** (`apps/kds-api`): `KdsDeviceToken` / `KdsScreenSession` already carry
  `merchantId`. `resolveKdsMerchantId(services, auth, requested)` =
  `requested ?? deviceMerchant ?? providerDefault`. The `/api/kds/*` auth preHandler
  resolves + access-checks the store and stashes it on `request.kdsMerchantId`; routes
  read it (with a query-param fallback so the route module stays self-contained). A
  device that omits the query param now scopes to its own store; web sessions are
  unchanged.

## Boundaries are still intact

The Iron Laws (root `AGENTS.md`) all still hold. Multi-location added bounded,
eslint-enforced carve-outs (`lib/location/**` for db-kds reads in backoffice) and an
analytics-owned `config.sync_targets` rather than crossing a DB boundary. No app
imports another app's DB client; cross-app DTOs still flow through
`packages/contracts`.

## Deferred / remaining work — intentional, not bugs

If you find these "missing," they were left out on purpose. Do them when the second
store is actually being onboarded (cheaper + verifiable then), not pre-emptively.

1. **Bind-POS onboarding flow — ✅ SHIPPED (PR #713).** Both halves are self-serve
   now. Create-store: **Stores → Add store** (`POST /api/locations`, PR #706) inserts
   a `Location` with a server-deduped slug + default hours. Bind-POS: the **Connect
   POS** action on a store's row (`apps/backoffice-web/components/locations/locations-table.tsx`)
   → `POST /api/locations/[id]/bind` (ADMIN-gated) sets `CloverMerchant.locationId`,
   so a connected-but-unlinked merchant is linked from the UI and then appears in the
   switcher. Store #2 onboarding is fully self-serve through this step. *(Historical:
   the bind step was the "half of the gap" that remained at ADR-0018 time.)*
2. **Analytics sync-target auto-provisioning (Phase 3 tail).** When a store's POS
   connects, something must POST `{ merchant_id, token, store_timezone }` to the
   analytics `/admin/api/sync-targets` endpoint. The OAuth token lives in kds-api's
   `CloverMerchant`, not in backoffice — so this is a security-sensitive
   cross-service push (kds-api → analytics, or a manual operator action). Design it
   deliberately; don't log the token. Store #1 is covered by the env bootstrap.
3. **Cross-store consolidation analytics ("All stores").** The switcher's "All
   stores" mode currently resolves to the env default merchant. True consolidation
   belongs in analytics-api SQL (`GROUP BY merchant_id`), and needs a real second
   store's data to validate the money math — not a BFF-side fan-out.
4. **iOS + web board.** iOS can drop its hardcoded `YRStationID` plist value and rely
   on the device token (Phase 5 enables this server-side). Session-authenticated web
   boards still use `?merchantId=` / the default; a per-board store binding is a
   separate, session-based mechanism.

## How to onboard a second store (practical checklist)

1. **Connect its POS.** For Clover: the per-merchant OAuth install creates a second
   `CloverMerchant`. For a non-Clover store: upsert a store-account row with a
   synthetic id + provider creds (ADR-0019).
2. **Create the Location, then bind its POS.** Create the store in the UI
   (Stores → **Add store**), then use **Connect POS** on that store's row to bind it
   to its POS account (sets `CloverMerchant.locationId`) — both steps are self-serve
   in the UI now (PR #713).
3. **Register analytics sync.** Add a `config.sync_targets` row for the new
   `merchant_id` (token + timezone). *(See deferred item 2.)*
4. **Inventory.** Give the store's crew `InventoryEmployee` rows the new `locationId`;
   operations auto-scope. Per-store stock starts from the catalog defaults until the
   store's first count/receive writes its `InventoryItemState`.
5. **KDS.** Pair each screen as a device (`POST /api/kds/devices` with the store's
   `merchantId`); the screen then resolves its own store from the token — no
   `?merchantId=` needed.

## Key files

- `packages/db-kds/prisma/schema.prisma` — `Location`, `CloverMerchant.locationId`.
- `apps/backoffice-web/lib/location/**` — Location reads + `locationId → merchantId`
  resolution + the active-store cookie seam.
- `apps/analytics-api/sql/migrations/009_sync_targets.sql` +
  `apps/analytics-api/src/sync-targets/**` — the analytics-owned store registry.
- `packages/db-inventory/prisma/schema.prisma` (`InventoryItemState`) +
  `apps/inventory-api/src/lib/inventory-store.ts` — per-store stock.
- `apps/kds-api/src/lib/kds-auth.ts` (`resolveKdsMerchantId`) +
  `apps/kds-api/src/app.ts` (preHandler stash) — device → store.
