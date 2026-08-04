# ADR-0818: Multi-Tenant Platform Architecture

> **Status:** Proposed — supersedes [ADR-0018](0018-multi-location-architecture.md) (multi-location umbrella). The target architecture is in [docs/architecture/multi-tenant-architecture.md](../architecture/multi-tenant-architecture.md); the phased migration in [docs/multi-tenant-migration-roadmap.md](../multi-tenant-migration-roadmap.md).

## Status

**Proposed.** Supersedes [ADR-0018](0018-multi-location-architecture.md) ("Multi-location umbrella; NOT multi-tenant"). ADR-0018 carries a `> **Superseded by:** [ADR-0818](0818-multi-tenant-platform-architecture.md)` banner directly under its H1, and its "NOT multi-tenant" stance is reversed (the multi-*location* mechanics it documents remain valid as the *within-tenant* shape).

## Context

ADR-0018 established a multi-**location** umbrella and explicitly stated the suite is **not multi-tenant** — locations were modelled as stores under one implicit brand, with `merchantId`/`locationId` as partition keys and settings scoped to a single `BRAND_SCOPE_ID = "default-merchant"`. That was the right call for a single-merchant product.

The owner has now decided to build Example Kitchen as a **mature, Toast-style multi-tenant platform**: a system that can host N independent restaurant businesses with hard cross-tenant isolation, where the owner's own brand (2 stores today — Anytown on Clover, store #2 on Square) is simply *tenant #1*. This reverses ADR-0018's central stance, which — per the [ADR-0037](0037-adr-ids-are-the-pull-request-number.md) convention — requires a **superseding ADR**, not an in-place edit.

The reversal is motivated by, and bounded by, concrete facts about today's system:
- **Tenancy is a partition key, not a trust boundary.** `merchantId`/`locationId` is a trusted `WHERE` clause; there is no row-level security anywhere; analytics `dashboard.ts` reads *any* store's mart via `?merchant_id=` behind one shared admin token; web sessions carry only `{ accountId }` and pin to the env-default merchant.
- **No tenant/org layer exists above "store."** `WebAdminAccount` is global with no location/tenant field; [ADR-0029](0029-federated-rbac-and-auth-lifecycle.md)'s federated-RBAC vocabulary shipped but its per-location membership (P5) and enforcement (P3) are unbuilt.
- The owner is **not selling to external customers yet** — so billing/self-serve is design-ready, build-later, but the data-isolation trust boundary is needed *now* to make "manage 2 stores from one backoffice" correct (instead of a `default-merchant` fiction) and to close real holes (the `?merchant_id=` trust gap, the silent default-merchant fallback).

The full target design is in [docs/architecture/multi-tenant-architecture.md](../architecture/multi-tenant-architecture.md); the phased migration is in [docs/multi-tenant-migration-roadmap.md](../multi-tenant-migration-roadmap.md).

## Decision

**1. Adopt the Toast tenancy shape: `Tenant (Org) → Location → Device`.**
A **Tenant** is the paying business and the **hard isolation unit** (Toast's "Management Group"). A single-store shop is a one-location tenant, so multi-location and multi-tenant are the same model — "more rows, not a rewrite." The canonical `Tenant` entity lives in `db-kds` beside `Location`; the other databases carry `tenant_id` as a bare, un-FK'd string (Iron Law 1).

We **defer** a dedicated `packages/db-identity` package: for 2 tenants the extra Prisma-package boundary + table-move migration buys nothing. Tenant lives in `db-kds`, membership lives in `db-auth`. Revisit only if a non-kds app needs to read the tenant tree directly.

**2. Isolation strategy: the bridge model — shared-schema + `tenant_id` + Postgres RLS. NOT database-per-tenant.**
One shared Postgres per app; `tenant_id` on every tenant-owned table; RLS (`ENABLE` + `FORCE`, default-deny) as the hard wall; each app connects as a non-superuser/non-`BYPASSRLS`/non-owner role; tenant context set via `set_config('app.tenant_id', tid, true)` (`SET LOCAL`) **inside the query transaction** (mandatory under PgBouncer transaction pooling), exposed as a `forTenant()` Prisma client extension per DB package. DB-per-tenant is reserved only as a documented escape hatch for a future enterprise tenant with a contractual physical-isolation requirement.

`tenant_id` is the immovable wall (RLS predicate); `merchantId`/`locationId` are relaxable within-tenant filters. Cross-tenant isolation is absolute; cross-location sharing is configurable.

**3. RBAC: extend ADR-0029, don't reinvent.**
Keep the shipped `Role`/`Permission` vocabulary + pure `can()`. Add a `TenantMembership` allow-list (db-auth) carrying a *per-membership* role + allowed locations (Toast's "powerful at A, limited at B"), and a pure `effectiveRole(grants, locationId)` helper. Provisioning seeds exactly one tenant super-user (`OWNER`, all locations). This builds ADR-0029's unbuilt P3 (enforcement at every Fastify route) and P5 (per-location membership).

**4. Analytics: authenticate a tenant claim, never trust `?merchant_id=`.**
`tenant_id` is added to mart tables; ingest stamps it from analytics' own `config.sync_targets` (gains `tenant_id`); reads validate a signed JWT carrying a `tenant` claim + allowed `merchants[]`, minted by the BFF via `packages/auth`. Iron Laws 1 (no db-kds import — trusts a signature) and 5 (read-only) intact.

**5. Per-tenant envelope encryption.**
The existing `AI_TOKEN_ENCRYPTION_KEY` ([ADR-0020](0020-adopt-infisical-for-runtime-secrets.md), Layer-1) becomes the KEK; each tenant gets a DEK wrapped by it, stored on `Tenant.wrappedDek`. Exactly one secret stays in Infisical. Enables crypto-shred offboarding.

**6. Build-now vs build-later.**
- **Build-now (the trust boundary + isolation primitives):** Tenant entity + `tenant_id` backfill; session tenant claim + fail-closed scope derivation; analytics signed-token boundary; RLS defense-in-depth; coarse per-location RBAC membership; device-pairing tokens; per-tenant envelope keys; runtime `provisionTenant`; lifecycle suspend/export/crypto-shred; the billing **seam** (nullable `planId`, `Plan` `INTERNAL` sentinel, `assertWithinPlan` no-op).
- **Build-when-selling:** billing engine (provider, webhooks, metering, dunning, trials), real plan limits, self-serve signup → payment gate, KEK rotation tooling, arbitrary-depth restaurant-group tree + cascade-grant UI.

## Consequences

**Positive:**
- A real trust boundary replaces a trusted `WHERE` clause; three independent gates (auth claim, app predicate, RLS) confine every read to one tenant.
- The owner's 2 stores become *correct* (tenant #1, two locations) instead of a `default-merchant` fiction; the `?merchant_id=` hole and silent-default fallback are closed.
- "Provision a tenant" is a runtime `INSERT`, not DDL — self-serve-ready with zero migration fan-out.
- Crypto-shred gives a clean offboarding/erasure story.
- The design is **additive** — no Iron Law carve-out needed.

**Negative / what gets harder:**
- **RLS discipline becomes load-bearing.** The `SET LOCAL`-inside-the-transaction rule is invisible in dev and leaks under concurrent prod load if violated. Mitigation: the `forTenant()` extension is the *only* sanctioned path; an integration test runs two tenants through one pooled connection and asserts zero bleed. Explicit `.$transaction()` on a scoped client needs a deliberate helper.
- **CRM de-globalization is a behavior change.** `CrmCustomer.phoneE164` goes from globally-unique to `@@unique([tenantId, phoneE164])`. Within a tenant nothing changes; across tenants the same phone is now a separate row. This is correct for independent businesses but must be called out as a migration that changes a uniqueness constraint.
- **Migration risk on hot tables.** Adding `tenant_id` + new tenant-leading unique constraints must be staged (nullable-add → backfill → set-not-null) to avoid locking live tables, and backfill must precede any `tenantId`-leading unique constraint or the sentinel rows (`default-merchant`/`default-location`/`singleton`) collide.
- **Fail-closed means membership is mandatory.** Every account must have explicit membership rows before it can see any store; the backfill must seed the owner's `OWNER` membership for both locations or the owner locks themselves out.
- **Two new operational roles per DB** (migration owner vs RLS-forced runtime role) add deployment complexity.

**Neutral:**
- For 2 owner-operated stores under one trusted owner, RLS is *defense-in-depth*, not load-bearing (the app-code session boundary already makes cross-tenant access impossible). We ship it anyway as the difference between "we trust our WHERE clauses" and "the database guarantees it," and to make onboarding an external tenant a config change rather than a security audit.

## Related ADRs that need notes

| ADR | Action |
| --- | --- |
| [ADR-0018](0018-multi-location-architecture.md) (multi-location umbrella; NOT multi-tenant) | **Superseded by this ADR.** Add the `> **Superseded by:**` banner; its multi-location mechanics survive as the within-tenant shape. |
| [ADR-0019](0019-decouple-store-identity-from-clover.md) (decouple store identity from Clover) | Add a forward-reference note: store identity (`Location`) now also carries `tenantId`; this ADR's decoupling is a prerequisite that this ADR builds on. No reversal. |
| [ADR-0029](0029-federated-rbac-and-auth-lifecycle.md) (federated RBAC) | Add a note: this ADR builds the unbuilt P3 (enforcement) + P5 (per-location membership) via `TenantMembership` + `effectiveRole()`. Flip ADR-0029 to **Accepted** when P3/P5 land. |
| [ADR-0795](0795-posaccount-posstore-unified-store-identity-model.md) (PosAccount 1:N PosStore) | Add a note: `PosAccount` gains `tenantId`; all of a PosAccount's stores share one tenant, and the DEK that decrypts its tokens is the owning tenant's DEK. No reversal. |
| [ADR-0020](0020-adopt-infisical-for-runtime-secrets.md) (token encryption / Infisical Layer-1 key) | Add an amendment note: the Layer-1 `AI_TOKEN_ENCRYPTION_KEY` is recast as the KEK wrapping per-tenant DEKs. Its Infisical home is unchanged. |
| [ADR-0015](0015-extract-auth-tables-into-db-auth-package.md) (db-auth split) | Add a note: `TenantMembership` lands in db-auth; the tenant tree stays in db-kds; the deferred `db-identity` option is recorded but not taken. |
