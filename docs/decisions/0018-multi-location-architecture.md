# ADR-0018: Multi-location architecture (Location over merchantId)

> **Superseded by:** [ADR-0818](0818-multi-tenant-platform-architecture.md) — the "NOT multi-tenant" stance is reversed (Example Kitchen is now a multi-tenant platform); the multi-location mechanics below remain valid as the *within-tenant* shape.

- **Status**: Superseded by [ADR-0818](0818-multi-tenant-platform-architecture.md)
- **Date**: 2026-05-28
- **Deciders**: @example-org

> **⚠️ Shared ADR number.** The number **0018** is also used by [`0018-tooling-selection-for-agent-dev.md`](0018-tooling-selection-for-agent-dev.md) — a parallel-branch collision (both authored 2026-05-28). Per the immutability convention ([README](README.md#superseding-an-adr): *"Never delete an ADR"*; numbers are never reused-by-renaming), neither was renumbered. Cite the full filename, not the bare number, when cross-referencing. **This** ADR is the *multi-location architecture* one.

> **Update (2026-06-18) — two forward pointers.** (1) This ADR's core scoping note (*"1 location = 1 Clover merchant; keep `merchantId`, don't re-thread"*) is refined by [ADR-0019](./0019-decouple-store-identity-from-clover.md): store identity is conceptually `Location`, and a multi-location POS (Square) maps **one account to N stores**, so the Clover 1:1 mapping is a special case, not the general model. (2) The credential layer that followed — `PosAccount` → `PosStore` → `Location`, with **Square onboarded as store #2** — is described in [docs/square-onboarding.md](../square-onboarding.md) and `ARCHITECTURE.md` §1; its own dedicated decision record (the deferred ADR-0019 follow-up) is still owed.

## Context

Example Kitchen shipped as a **single-merchant** suite (see [ADR-0004](./0004-static-clover-token-from-db.md), `ARCHITECTURE.md` §1). The owner is now growing it to serve **several stores that he owns and co-manages with one business partner**.

This is the **multi-location** shape (one brand, N stores — like McDonald's/Starbucks), **not** the multi-tenant SaaS shape (selling the software to independent, competing restaurants — like Toast/Square). The distinction is load-bearing:

- There is exactly **one "tenant"** (the Example Kitchen brand). Stores are its children.
- **Cross-store visibility is a feature**, not a leak. Both owner accounts see every store; consolidated and side-by-side reporting is a goal.
- Therefore we do **not** build tenant isolation, billing, or tenant onboarding. The textbook silo/pool/bridge isolation decision does not apply.

What already fits this shape (verified):

- Every KDS table (`packages/db-kds`) and every analytics table (`apps/analytics-api/sql`) is **already keyed by `merchantId` / `merchant_id`**. There is no data-grain migration to do there.
- Clover itself models **each location as its own `merchantId` with its own access token**; a token for one merchant cannot read another. The repo's `clover_merchants` table + per-merchant OAuth install flow already matches that grain.
- `app_setting` already carries a composite `(merchantId, key)` PK (schema V2, [ADR-0016](./0016-app-setting-table.md)) — multi-scope scaffolding that has been inert until now.

The gap is the **control plane**: there is no store registry above the POS merchant id, no store switcher, the analytics runtime is a hard single-merchant singleton, and the inventory database has no location scoping at all.

## Decision

1. **Multi-location, not multi-tenant.** One brand, N stores, both owners see all. No tenant isolation, no billing, no onboarding flow.

2. **Introduce a POS-agnostic `Location` as the canonical store identity.** `Location` lives in `packages/db-kds` (the existing home of the POS-connection domain — `clover_merchants`, `provider_app_states`). It carries store metadata only (name, slug, timezone, operating hours, active) — **no Clover-specific fields**. The Clover POS binding (`clover_merchants`) gains a nullable `locationId` FK that points *up* to its location (`Location` 1—* `CloverMerchant`, so a location can hold other/multiple POS bindings later).

3. **Keep the `locationId`-vs-`merchantId` split; do not re-thread `merchantId`.**
   - **POS-derived data** (KDS tickets/orders, analytics sales) keeps scoping by the Clover **`merchantId`** — it's already on every row, DTO, and WebSocket path; re-threading is pure churn.
   - **Brand-owned data** (inventory) scopes by the POS-agnostic **`locationId`** (the owner explicitly wants other POS systems possible).
   - Backoffice resolves a selected Location → its Clover `merchantId` when querying KDS/analytics, and uses `locationId` directly for inventory.

4. **Settings are tiered: brand-level by default; location-level for operating hours, timezone, and POS credentials.** The registry in `packages/contracts/src/settings.ts` gains a `tier` per key. The hardcoded `DEFAULT_MERCHANT_ID` in `apps/backoffice-web/lib/settings/tenancy.ts` is replaced by a scope resolver: brand-tier keys read/write under a reserved brand scope id; location-tier keys under the active `locationId`. The `(merchantId, key)` PK already supports this — `merchantId` becomes "scope id". Clover credentials already live per-merchant in `clover_merchants`, so they are per-location by construction; no secret migration is part of this ADR.

5. **Boundary discipline (Iron Law 1) is preserved.** Backoffice reads/writes `Location` through a new `apps/backoffice-web/lib/location/**` ESLint carve-out, exactly analogous to the `lib/ai/**` ([ADR-0011](./0011-ai-tables-bounded-exception.md)) and `lib/settings/**` ([ADR-0016](./0016-app-setting-table.md)) carve-outs. `analytics-api` and `inventory-api` **never** import Location; they receive `merchantId` / `locationId` as opaque strings (the way `merchant_id` already flows into analytics today).

6. **Authorization stays minimal for now.** The two co-owners are trusted and see all stores; no per-store access gate is built. This re-escalates only if non-owner, store-restricted staff logins are added later (`WebAdminAccount` would then gain a location-membership relation).

This ADR is the umbrella. Two surfaces need their own follow-up ADRs when their phases land: **analytics multi-merchant sync discovery** (analytics owns its own DB and cannot import `db-kds`, so it needs a `config.sync_targets` table fed by backoffice) and **inventory location scoping** (brand catalog vs per-store state split + per-store recipe overrides).

## Consequences

- **Supersedes the "deliberately single-merchant" stance** in `ARCHITECTURE.md` §1 and `README.md`. Those statements are updated to point here. [ADR-0004](./0004-static-clover-token-from-db.md)'s "multi-merchant becomes a future migration" note is now in progress.
- Rollout is phased and additive. Phase 0 (this change) adds the `Location` registry and backfills one location per existing merchant; **no behavior changes** — the single store keeps working with a nullable, now-populated `locationId`.
- The `merchantId`/`locationId` duality costs backoffice a small mapping step (Location → Clover merchantId) but avoids a high-risk rename across KDS/analytics.
- A new Prisma model is registered in `scripts/check-doc-drift.sh` (ADR-0012 guard).

## Alternatives considered

- **Multi-tenant SaaS (silo / pool / bridge isolation).** Rejected — wrong shape. The owner is not selling to independent restaurants; tenants-as-competitors isolation would be cost and complexity for a problem we don't have, and would *fight* the desired cross-store rollup.
- **Reuse `CloverMerchant` as the location.** Rejected — it's Clover-specific. The owner wants other POS systems possible, so the canonical store identity must be POS-agnostic.
- **A separate `packages/db-location` package** (mirroring the db-auth split). Rejected for now — it forces a cross-Prisma-package FK for `clover_merchants.locationId`, which Prisma can't model cleanly. Same-package FK in `db-kds` is simpler and in-pattern; the future physical-DB split (if ever) stays a Prisma config change, as ADR-0015 established for auth.
- **Re-thread everything from `merchantId` to `locationId`.** Rejected — high-churn rename across every KDS table, contract DTO, and WebSocket path for zero functional gain, since 1 location = 1 Clover merchant today.

## Related

- [ADR-0002: Five Iron Laws](./0002-five-iron-laws.md) — Law 1 (DB boundary) is why analytics/inventory get opaque strings, not a shared Location client.
- [ADR-0004: Static Clover token from DB](./0004-static-clover-token-from-db.md) — flagged multi-merchant as a future migration; now in progress.
- [ADR-0011: AI tables bounded exception](./0011-ai-tables-bounded-exception.md) and [ADR-0016: AppSetting table](./0016-app-setting-table.md) — the `lib/<feature>/**` carve-out pattern that `lib/location/**` follows.
- [ADR-0015: Extract auth tables into db-auth](./0015-extract-auth-tables-into-db-auth-package.md) — precedent for "package boundary now, physical DB split later as a config change".
