# ADR-0795: PosAccount → PosStore unified store-identity model

- **Status**: Accepted
- **Date**: 2026-06-18
- **Deciders**: @example-org
- **Extends**: [ADR-0018](./0018-multi-location-architecture.md) (multi-location umbrella) and [ADR-0019](./0019-decouple-store-identity-from-clover.md) (decouple store identity from Clover). This ADR is the realization of ADR-0019's deferred `CloverMerchant` → `PosStore` rename, triggered by store #2 landing on a different POS (Square).

## Context

[ADR-0018](./0018-multi-location-architecture.md) introduced a POS-agnostic `Location` as the canonical store identity and kept the `locationId`-vs-`merchantId` split (POS-derived rows scope by `merchantId`, brand-owned data by `locationId`). [ADR-0019](./0019-decouple-store-identity-from-clover.md) then chose **Option C — defer**: do not re-thread the 15 KDS FKs onto `Location`, keep `CloverMerchant.id` as the store key, document its dual role, and treat onboarding a non-Clover store as *additive*. ADR-0019 explicitly deferred two things "until the 2nd POS is chosen": the `CloverMerchant` → `StoreAccount`/`PosStore` rename, and any per-provider credential modeling.

The 2nd POS is now chosen — **store #2 runs on Square** (see [docs/square-onboarding.md](../square-onboarding.md)). Square forces the credential question ADR-0019 left open, because Clover and Square address data at *different grains*:

- **Clover** addresses data only by `merchant_id` (`/v3/merchants/{mId}/...`), with one OAuth token per merchant. A Clover merchant *is* a store; a multi-location Clover business provisions multiple merchant accounts. So `merchant_id ≡ store` — the token and the store are the same row, which is exactly the shape `clover_merchants` has today.
- **Square** has one seller account (`merchant_id`) that natively owns **N `location_id`s** under **one** OAuth token; orders/payments are scoped by `location_id`, catalog is shared with per-location price overrides. The credential lives one level *above* the store.

The pre-existing schema put the access/refresh token directly on the per-store `clover_merchants` row. Carrying that forward to Square would either duplicate one Square token across N store rows (a write-amplification + rotation-consistency hazard — rotate in one place, miss the others) or bolt a Square-only special case onto the store table. Neither generalizes. ADR-0019's "additive, no big future problems" bar requires that store #1 (Clover) keep working untouched while the second POS lands.

## Decision

**Split the POS *credential* from the per-store *binding*, with a new `PosAccount` entity above the existing per-store row, and unify both POS shapes under one relationship where Clover is the fan-out-of-one special case.**

```
PosAccount  1 ──── N  PosStore  ──── 1  Location
(credential)          (per-store binding)   (canonical store)

Clover:  1 PosAccount ── 1 PosStore  (account ≡ store; fan-out-of-one)
Square:  1 PosAccount ── N PosStore  (one seller token → N locations)
```

- **`PosAccount`** (new table `pos_accounts`, [schema.prisma](../../packages/db-kds/prisma/schema.prisma) `model PosAccount`) — a connected POS account = the credential. One row per connected account: `(id, provider, providerMerchantId, environment, accessToken(+Cipher), refreshToken(+Cipher), tokenExpiresAt, refreshTokenExpiresAt, authStatus, region)`, unique on `(provider, providerMerchantId, environment)`. **The OAuth/PAT token lives HERE, never duplicated onto a per-store row** — so a Square token is stored once and rotated once regardless of how many locations it fans out to.
- **`PosStore`** (the per-store binding) — realized on the **existing `CloverMerchant` table** (`clover_merchants`), which gains a nullable `posAccountId` FK → `PosAccount` and a nullable `providerStoreId` (the POS-side store id). `id` stays the partition key the rest of the system already uses (KDS tickets/orders/devices, reconciliation, analytics `sync_targets`). Clover: `id = providerStoreId = providerMerchantId`. Square: `id = square:{location_id}`, `providerStoreId = location_id`.
- **`Location`** (`locations`, ADR-0018) — the canonical store. Unchanged.

**Clover is the fan-out-of-one special case, not a separate code path.** The Clover/Square asymmetry collapses into "how many `PosStore`s share one `PosAccount`," which is the platform's call, not ours. There is no "Square branch" in the identity model — only in the irreducibly POS-specific ingest adapters (ADR-0019).

**The physical `CloverMerchant` → `PosStore` table rename stays deferred** (consistent with ADR-0019's cost/benefit). What shipped is the *functional* credential split — the new `PosAccount` table and the `posAccountId` / `providerStoreId` columns — because that is what a non-Clover store actually needs. The rename is a cosmetic, low-risk mechanical refactor that touches 15 FK names and can land in its own migration at any time; doing it now buys nothing against the onboarding bar and risks destabilizing the working Clover path. The dual role is recorded in the `model CloverMerchant` schema comment and `packages/db-kds/AGENTS.md`, exactly as ADR-0019 prescribed. The name `PosStore` in this ADR refers to the *role* that table plays, not (yet) its physical name.

### Migration checkpoints

Store #1 (Clover) stays untouched throughout; the store-key (`clover_merchants.id`) never changes, so every FK and partition key is intact.

1. **Add `PosAccount`; add nullable `posAccountId` + `providerStoreId` to the per-store table.** Purely additive — no behavior change. `posAccountId` is null on every legacy row at this point.
2. **Backfill one `PosAccount` per existing Clover row.** For each `clover_merchants` row, create one `PosAccount` (`provider = CLOVER`, `providerMerchantId = row.id`, copy its token) and point `posAccountId` at it. Compatibility: the row `id` is unchanged → no FK churn.
3. **Dual-read the token during the transition.** Reads resolve cipher-first via `resolvePosAccountSecrets` / `resolveCloverMerchantSecrets` ([apps/kds-api/src/lib/pos-token.ts](../../apps/kds-api/src/lib/pos-token.ts)), falling back to the legacy column. The legacy `accessToken`/`refreshToken`/`recoveryToken` columns on both tables remain populated (blanked-then-ciphered on encrypting writes per the at-rest-encryption pass) until a **separately-checkpointed later migration drops them** and simplifies the resolvers to cipher-only. **Rollback note:** until that drop lands, a revert to a pre-`PosAccount` build still reads the legacy columns and keeps working.
4. **Square onboarding writes one `PosAccount` (the seller) + one `PosStore` per active location.** `bootstrapSquareAccountFromEnv()` (dev/sandbox) and `POST /api/square/connect` (prod) upsert the account, then one binding per `ListLocations` entry.

> ⚠️ **VarChar(32) PK budget guard.** `clover_merchants.id` is `@db.VarChar(32)` and every FK keys off it. The Square store id `square:{location_id}` (`square:` + a ~13-char Square location id ≈ 20 chars) fits today, but Square location ids are **not** contractually length-capped. The id-minting code must guard it (reject/log if > 32 chars); if there is any doubt, widen the PK to `VarChar(64)` in the *same* migration, since retrofitting a PK widening across all FKs later is far costlier. Analytics `sync_targets.merchant_id` is already `text`, so it has no cap.

## Consequences

- **ADR-0019's deferred credential question is now answered**, and onboarding a non-Clover store is genuinely additive: add the `OrderProvider` enum value, upsert a `PosAccount` + `PosStore`, write the POS-specific ingest adapter. No live KDS-data migration, no FK re-thread.
- **One token, one rotation.** A multi-location POS (Square) stores and rotates its token in exactly one place. The previous "token on every store row" shape could not express this without duplication.
- **The store partition key is unchanged**, so KDS, device tokens, reconciliation, and analytics `sync_targets` all keep working with no re-keying. The cost is the `square:{location_id}` synthetic-id convention plus the VarChar(32) guard above.
- **A naming debt persists**: the table is still physically `clover_merchants` while playing the `PosStore` role, and its legacy token columns linger through the dual-read window. Both are documented (schema comment + AGENTS.md) and both are low-risk to clear later; neither blocks store #2.
- **Stays inside `packages/db-kds` — no Iron Law crossing.** This elaborates the ADR-0018 / ADR-0019 store-identity decisions; `analytics-api` and `inventory-api` still receive `merchantId` / `locationId` as opaque strings.
- **New Prisma model registered** in `ARCHITECTURE.md` (ADR-0012 doc-drift guard); the `PosAccount` model is now documented in the db-kds package row.

## Alternatives considered

- **Keep the token on the per-store row, special-case Square.** Rejected — for Square it forces either duplicating one token across N location rows (rotation-consistency hazard) or a Square-only column set bolted onto the store table. Neither generalizes to a third POS, and both fight the unified shape.
- **Do the full `CloverMerchant` → `PosStore` table rename now (ADR-0019 Option A).** Rejected for *this* change — the rename is cosmetic and touches 15 FK names; it buys nothing against the onboarding bar and adds risk to the working Clover path. Deferred again as a standalone low-risk refactor (the credential split is the functional part that store #2 actually needs).
- **Re-thread all 15 FKs onto `Location` (ADR-0019 Option B).** Rejected — same reasoning as ADR-0019: a live-data migration that is the single genuinely-painful change, speculative for a 2nd POS whose shape was unknown when ADR-0019 was written and unnecessary now that the synthetic-store-account + `PosAccount` pattern decouples the credential without it.
- **A separate `packages/db-pos` for the credential layer.** Rejected — same rationale ADR-0018 used against `db-location`: it forces a cross-Prisma-package FK (`clover_merchants.posAccountId` → `pos_accounts`) that Prisma can't model cleanly. Same-package in `db-kds` is simpler and in-pattern.
- **Do nothing (block on the deferred rename).** Rejected — store #2 is landing on Square now; the credential grain mismatch is a hard blocker, not a future nicety.

## Related

- [ADR-0018: Multi-location architecture](./0018-multi-location-architecture.md) — the `Location` registry this model binds up to.
- [ADR-0019: Decouple store identity from Clover](./0019-decouple-store-identity-from-clover.md) — chose to defer the rename + credential modeling; this ADR realizes the credential half.
- [docs/square-onboarding.md](../square-onboarding.md) §1 — the integration plan this ADR formalizes (the model, the migration checkpoints, the VarChar(32) guard).
- [ADR-0037: ADR ids are the pull-request number](./0037-adr-ids-are-the-pull-request-number.md) — why this ADR's id is its PR number.
