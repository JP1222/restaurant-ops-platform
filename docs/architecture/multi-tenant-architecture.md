# Multi-Tenant Platform Architecture

> **Status:** current — target architecture. This is the canonical reference for where Example Kitchen is going: a Toast-style multi-tenant restaurant platform. It describes the *target*, not today's shipped state; the live system is single-tenant-implicit (one brand, two stores). The phased path from here to there lives in [docs/multi-tenant-migration-roadmap.md](../multi-tenant-migration-roadmap.md). This doc supersedes the "NOT multi-tenant" framing of [ADR-0018](../decisions/0018-multi-location-architecture.md) per [ADR-0818 (multi-tenant platform architecture)](../decisions/0818-multi-tenant-platform-architecture.md).

## TL;DR

Example Kitchen is **one brand today, architected for N tenants tomorrow**. We adopt Toast's exact tenancy shape: a **Tenant** (the paying business — Toast calls it a "Management Group") is the top-level isolation unit, containing **Locations** (stores), which host **Devices** (screens). A single-store shop is just a one-location tenant, so "multi-location" and "multi-tenant" are the *same model* — adding a store or adding a customer is **more rows, not a rewrite**.

The core invariant: **`tenant_id` is a hard trust boundary; `merchantId`/`locationId` are partition keys *underneath* it.** Cross-tenant isolation is absolute (Postgres RLS + an authenticated tenant claim, never a client-supplied param). Cross-location sharing *within* a tenant is configurable (an ordinary, relaxable `WHERE` clause). That asymmetry is the whole design.

This is **additive** — it preserves all five Iron Laws with no carve-out. The owner is not selling to external customers yet, so billing/self-serve is **design-ready, build-later**; the trust boundary and isolation primitives are **build-now**.

## The entity model: Tenant → Location → Device

```
Tenant  (Org / paying business — the HARD isolation unit; Toast "Management Group")
  │  one per customer; tenant_id is the RLS key + token claim on every tenant-owned row
  │
  ├── Location  (a store — canonical store identity, lives in db-kds)
  │     │  scoped by locationId WITHIN the tenant (a soft, relaxable filter)
  │     │
  │     ├── CloverMerchant  (the per-store POS binding; the misnamed "PosStore")
  │     │     │  KDS tickets + analytics sales scope by merchantId (= CloverMerchant.id,
  │     │     │  or "square:{location_id}" for a Square store)
  │     │     └── PosAccount  (provider credential; 1:N PosStore per ADR-0795/0019)
  │     │
  │     ├── inventory rows  (scoped by locationId)
  │     └── Device  (a screen: KDS board, customer-display, crew iPad — paired token)
  │
  ├── CrmCustomer + points ledger  (tenant-global: one identity across the tenant's
  │     stores, hard-walled across tenants — see Per-domain → CRM)
  │
  ├── WebAdminAccount membership  (which tenant + which locations an operator may act on)
  └── per-tenant DEK  (wraps this tenant's POS tokens; enables crypto-shred offboarding)
```

| Tier | Entity | Identity home | Scope semantics |
| --- | --- | --- | --- |
| **Tenant** | `Tenant` | `db-kds` (new model, beside `Location`) | The trust boundary. `tenant_id` on every tenant-owned row, RLS-enforced. Uniqueness guaranteed *within* a tenant, not across (mirrors Toast's "uniqueness within a management group"). |
| **Location** | `Location` | `db-kds` (existing canonical store identity) | A store. Gains a `tenantId` FK. The within-tenant partition; cross-location sharing is configurable. |
| **POS binding** | `CloverMerchant` | `db-kds` | Per-store POS binding. Tenant derived via its `Location`; `tenantId` denormalized for the RLS predicate. |
| **Credential** | `PosAccount` | `db-kds` | One tenant; all its stores share a tenant. Its DEK = the owning tenant's DEK. |
| **Device** | `KdsDeviceToken` | `db-kds` | A screen, paired to `(tenantId, locationId)`. The token *is* the screen's trust boundary. |

**Why Tenant lives in `db-kds`:** `Location` (the canonical store identity) already lives there, and `db-auth`'s tables are physically in the same Postgres ([ADR-0015](../decisions/0015-extract-auth-tables-into-db-auth-package.md) is a Prisma-package split, not a physical-DB split). Putting `Tenant` beside `Location` keeps the canonical identity tree in one package and lets `WebAdminAccount` membership reference it within one physical DB. The other three databases (`db-inventory`, `db-crm`, analytics OLAP) carry `tenant_id` as a **bare, un-FK'd string** — exactly as they already carry `merchantId`/`locationId` today (Iron Law 1: no cross-app DB-client imports, no cross-DB FKs).

> **Deferred option — `db-identity`:** a future `packages/db-identity` could own the tenant tree + membership + a richer org-group hierarchy if the read-surface for tenancy outgrows `db-kds`/`db-auth`'s scope guards. We explicitly defer it: for 2 tenants the extra package boundary + table-move migration buys nothing today. Revisit when (a) a non-kds app needs to read the tenant tree directly, or (b) the Toast-style arbitrary-depth restaurant-group tree gets built.

## The three planes

The apps split cleanly into a **control plane** (config + reporting, human-authenticated) and a **data/device plane** (live ops, token-authenticated). This is Toast's cloud-control-plane / per-location-data-plane split, and it falls out of the existing **Floor vs Backoffice** boundary (Iron Law 4) — we are labelling a boundary that already exists, not adding one.

| Plane | Apps | Bound to | Trust posture | Who shares what |
| --- | --- | --- | --- | --- |
| **Control** | `backoffice-web` (+ BFF), `analytics-api`, `inventory-api`, `crm-api` | a **Tenant** (via operator session); Location is a *selected scope* | human passkey login; low error tolerance; **mints** the tenant claim | One console per tenant; a store switcher selects location scope. CRM/loyalty + brand settings are tenant-wide. |
| **Data / Device** | `kds-web` (board + customer-display), `crew-web`, `order-web`, `kds-api` | a **(Tenant, Location)** pair via a device-pairing token | always-on screens, no human re-auth, high resilience; **consumes** the claim | Each screen sees only its location's tickets/orders. A board token for `(T1, Anytown)` cannot read `(T1, Square-store)`. |

**Customer edge (`order-web`):** the customer is anonymous, so `(tenant, location)` is resolved from the **hostname/route** (e.g. `order.example...` → a location), turned into a server-trusted claim, and passed into the `kds-api /api/order/*` BFF. The customer never supplies tenant/location.

## Chosen isolation strategy: shared-schema + `tenant_id` + Postgres RLS (the "bridge" model)

**Decision: one shared Postgres per app (pool), with a hard logical boundary via a `tenant_id` column + Postgres Row-Level Security. NOT database-per-tenant.**

Rationale (the AWS SaaS-Lens silo/pool/bridge framing): with 8 apps over 4 Prisma DBs + 1 raw-SQL OLAP DB, owner-operated, 2 tenants today and N small tenants later, Example Kitchen is a textbook **bridge** case — keep the shared-DB pool, harden the logical wall.

- **DB-per-tenant (silo) is overkill.** It multiplies migration fan-out (every `db-kds`/`db-inventory`/`db-crm` migration × N tenants) and infra cost for near-zero benefit at this scale. Reserved only as a documented escape hatch for a future enterprise tenant with a *contractual physical-isolation* requirement — the bridge lets us silo just that one tenant.
- **Shared-schema + RLS** keeps **one migration set applied once**, one connection pool, and turns "provision a tenant" into a runtime data `INSERT`, not DDL — which is what makes self-serve possible later with no migration step.

How RLS turns `tenant_id` from a partition key into a trust boundary:

```sql
ALTER TABLE kds_tickets ENABLE ROW LEVEL SECURITY;
ALTER TABLE kds_tickets FORCE ROW LEVEL SECURITY;       -- table owner must NOT bypass
CREATE POLICY tenant_isolation ON kds_tickets
  USING      (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
```

Three rules that make it real (and one that is non-negotiable under our deployment):

1. **Each app connects as a non-superuser, non-`BYPASSRLS`, non-owner role.** Superusers, `BYPASSRLS` roles, *and the table owner* all bypass RLS by default — hence `FORCE`. The migration role (owns tables, runs DDL) stays separate from the runtime role (gets DML grants, is RLS-forced).
2. **Default-deny:** a forgotten `WHERE` returns zero cross-tenant rows. RLS is *defense-in-depth on top of* the app-code boundary — even an app bug can't leak.
3. **Tenant context is set with `set_config('app.tenant_id', tid, true)` — the `true` means `SET LOCAL` — INSIDE the same transaction as the queries.** This is **mandatory, not optional**: PgBouncer transaction pooling reassigns a server connection per-transaction, so a plain session `SET` leaks to the next client on that pooled connection (a cross-tenant leak that only shows under concurrent prod load), and custom `app.*` GUCs aren't trackable by `track_extra_parameters` (no `GUC_REPORT` flag). `SET LOCAL` inside the transaction is the only safe form.
4. **Within-tenant cross-location sharing is free:** the RLS predicate keys on `tenant_id` only (the immovable wall); location filtering stays an ordinary, relaxable `WHERE`. So "CRM is brand-global within a tenant" = "tenant-scoped, no location predicate" — no special case.

**Prisma wiring:** a `forTenant(tenantId)` scoped client per DB package (`packages/db-kds/src/forTenant.ts`, etc.), built on Prisma's official `prisma-client-extensions/row-level-security` pattern — `prisma.$extends` wraps each op in a `$transaction` that first runs ``$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, TRUE)` ``. Build it **once per package**; never scatter raw `SET` calls. Documented caveat: because each op gets its own transaction, an explicit `.$transaction([...])` on the scoped client needs a deliberate helper (`forTenant().$tx(fn)` that sets the GUC as the first statement inside the caller's transaction).

## Per-domain design (in brief)

### db-kds (POS/KDS; also physically hosts db-auth tables)
- New `Tenant` model. `tenantId` added to `Location`/`PosAccount` (FK, intra-DB allowed) and to `CloverMerchant` + all operational rows (`CloverOrder`, `KdsTicket*`, `KdsDeviceToken`, `KdsRealtime*`, AI conversations, webhook tables…) as a **denormalized column** so RLS is a single-column compare, no JOIN.
- **Key insight that makes this the cheapest migration:** POS merchant ids are *already globally unique* (a Clover merchant id / `square:{loc}` never collides across tenants), so existing `@@unique([merchantId, …])` constraints (`KdsTicket`, `CloverWebhookEvent`, `KdsProviderConfig`, …) **need no `tenantId`**. `tenant_id` is purely additive (a filter + index), not a uniqueness rewrite.
- **Exception — the settings sentinel:** `AppSetting`/`AppSettingAudit` key on `merchantId @default("default-merchant")` as a *scope id*. That sentinel collides across tenants, so it gains `tenantId`: `@@id([tenantId, merchantId, key])`, where `merchantId` becomes the intra-tenant scope tier (brand vs `Location.id`).
- `ProviderAppState` (webhook bookkeeping) is the one legitimately-soft boundary: nullable `tenantId`, kept global for the shared-marketplace-app case, gated in the auth layer rather than RLS.

### db-inventory (brand catalog + per-location operations)
- Inventory **catalog is tenant-shared, not location-shared**: a tenant's stores share one item catalog and recipe BOMs; two *tenants* never see each other's items. `tenantId` walls the catalog; `locationId` scopes stock/operations *within* the tenant.
- Unlike db-kds, inventory's business keys are **brand-local strings that WILL collide across tenants** → they MUST gain `tenantId`: `InventoryItem.sku` → `@@unique([tenantId, sku])`; `InventoryItemAlias(vendor, normalized)`, `InventoryEmployee.pinLookup`, `InventoryRecipe.cloverItemId/squareCatalogObjectId`, and `InventoryLaborCost @@id` likewise.
- The `default-location` sentinel and `singleton`-PK config rows (`InventoryWasteSettings`, `InventorySecuritySetting`, `InventoryMetrics`, `InventoryDepletionCursor`) become per-tenant via a `tenantId`-leading PK.

### db-crm (the headline change: brand-global → tenant-global)
- Today CRM is deliberately brand-global — one customer + one points ledger across stores. That is **correct within a tenant and wrong across tenants** (two independent restaurant businesses must not share a customer table — a cross-tenant PII leak + legal problem).
- **`CrmCustomer.phoneE164 @unique` → `@@unique([tenantId, phoneE164])`.** Same human, same phone = a separate customer row *per tenant*. This preserves the existing earn-at-A/burn-at-B semantics *within* a tenant exactly, while hard-walling tenants. `CrmReward.slug`, `CrmRewardRedemption.code` likewise gain `tenantId`.
- The loyalty accrual path arrives with a `merchantId` (from a POS webhook), not a tenant. crm-api can't import db-kds (Iron Law 1) → **put `tenantId` in the loyalty-accrual contract event** (kds-api knows the tenant when it emits); crm-api never reverse-looks-up. Iron-Law-2-clean (a zod DTO change in `packages/contracts`).

### db-auth (the membership spine — what makes RBAC real)
- `WebAdminAccount` stays global in its own fields but gains a **membership table** (no single `tenantId` on the account — Toast's "powerful at store A, limited at store B" can't live on the account). Membership is the allow-list [ADR-0029](../decisions/0029-federated-rbac-and-auth-lifecycle.md) P5 calls for.
- `TenantMembership { accountId, tenantId, role, locationIds[] }` (empty `locationIds` = all locations in the tenant = Toast group-level). **Role moves from account → membership.** No FK to `Tenant`/`Location` (cross-package; opaque strings, validated by the auth service).
- **No RLS on the auth/membership tables** — they're read at login *before* a tenant context exists (look up account by username → *then* learn its tenant). RLS keyed on `app.tenant_id` would be circular. Enforced in the auth service instead; the *session* becomes the claim carrier.

### analytics-api (read-only OLAP, raw SQL, cannot import db-kds)
- The loudest hole: `dashboard.ts` reads any store's mart via `?merchant_id=` behind one shared admin token. The trust is entirely BFF-side; analytics authenticates *that a caller is admin*, never *which stores they may see*.
- Fix: **`tenant_id` becomes a leading scope column on every mart/raw/audit table** (additive to `merchant_id`, which stays the store partition key). The authoritative `merchant → tenant` map lives in analytics' **own** `config.sync_targets` (gains a `tenant_id` column) — so analytics never imports db-kds.
- **Ingest stamps `tenant_id`** from the `SyncTarget` the scheduler already iterates (the loader adds `tenant_id` as the first INSERT column). No client ever supplies it on the write path.
- **Reads authenticate a signed JWT carrying a `tenant` claim** (+ the caller's allowed `merchants[]`), minted by the BFF via `packages/auth`, verified by a new `src/http/tenant-auth.ts`. `?merchant_id=` is demoted to a *within-tenant filter* validated against `claim.merchants` (403 if not owned). Every query gets two predicates: `WHERE tenant_id = $1 AND merchant_id = ANY($2)`.
- **Free-form AI SQL (`safe-query.ts`) is the one surface app-level `WHERE` can't protect** → it runs inside a `withTenant()` wrapper that `SET LOCAL`s the GUC, and is **gated behind RLS being on** (a restricted `analytics_app` role, `FORCE` RLS, per the same bridge model on analytics' own Postgres).

## RBAC model (extending ADR-0029)

[ADR-0029](../decisions/0029-federated-rbac-and-auth-lifecycle.md)'s P1 shipped: the `Role`/`Permission` vocabulary + the pure, DB-free `can(role, permission)` in `packages/auth/src/rbac.ts`. **Keep all of it.** This design fills the two unbuilt phases without changing the vocabulary:

- **P5 (per-location role scoping)** = the `TenantMembership` table. A role is now attached at tenant, (future) org-node, or location — Toast's "scoped per location."
- **P3 (enforcement everywhere)** = the request-context resolver yields a **per-location effective role**, so `can(effectiveRole, perm)` can be called at every Fastify route, not just backoffice settings.
- **One new pure helper:** `effectiveRole(grants, locationId): Role` — most-specific grant wins (location > tenant-wide), Toast's downward cascade + "you can only grant what you hold" rule. Grants are passed as plain data (loaded from db-auth by the resolver), preserving the no-DB-in-`rbac.ts` invariant.
- **Tenant super-user (Toast "gatekeeper"):** a `TenantMembership { role: OWNER, locationIds: [] }` = every permission at every location. Provisioning a tenant **must** create exactly one such row, or the owner locks themselves out.

For 2 flat stores: build the membership table + a coarse owner/manager-per-location split **now**; defer the arbitrary-depth restaurant-group tree + cascade-grant UI as **ceremony** until there are tenants that need it.

## Provisioning, secrets, and the deferred billing seam

**Provisioning is a runtime data operation, not a migration.** A `provisionTenant(input)` saga (idempotent on a `provisioningKey`):
1. **Core (one Prisma `$transaction` in db-kds+db-auth, same physical Postgres):** `INSERT Tenant` → mint + wrap the per-tenant DEK → seed tenant-scoped settings → create the gatekeeper `WebAdminAccount` + `TenantMembership{OWNER}` → first `Location` → bind `PosAccount`/`CloverMerchant`. Atomic — the trust boundary is created all-or-nothing.
2. **Eventual-consistent tails (idempotent upserts after the core commits):** analytics `config.sync_targets` upsert; CRM `tenantId` namespace. A failure here leaves a tenant that exists but isn't yet ingesting — benign + re-runnable. Progress recorded on `Tenant.provisioningState`.

Today's store #1 + #2 are created by **backfill** (one tenant, two locations), not this flow; the flow proper is first exercised standing up a *second tenant*.

**Per-tenant secrets (envelope encryption):** today's brand-global `AI_TOKEN_ENCRYPTION_KEY` (AES-256-GCM, kds-api-only, [Infisical Layer-1](../decisions/0020-adopt-infisical-for-runtime-secrets.md)) becomes the **KEK**. Each tenant gets a **DEK**, wrapped by the KEK, stored on `Tenant.wrappedDek` (plaintext DEK only ever in memory). POS token cipher columns are encrypted with the owning tenant's DEK; `pos-token.ts`'s `encryptSecretForStorage`/`resolveCloverMerchantSecrets`/`resolvePosAccountSecrets` gain a `tenantId` param. **Crucially: exactly one secret stays in Infisical (the KEK)** — the wrapped DEK lives in the tenant's own DB row (useless without the KEK). Deleting `Tenant.wrappedDek` **crypto-shreds** a tenant on offboarding.

**Billing seam (build-now: the attachment points; build-later: the engine):** nullable `Tenant.planId`; a `Plan` table with an `INTERNAL`/`UNLIMITED` no-op sentinel (so your own stores are never enforced); a `Subscription` stub with nullable provider-id columns; an `assertWithinPlan(tenantId, action)` helper that returns *allow* for internal plans. The billing provider, metering, dunning, trials, and the self-serve signup → first-payment → `provisionTenant` gate are all **build-when-selling**.

**Lifecycle:** `Tenant.status ∈ {ACTIVE, SUSPENDED, OFFBOARDING, ARCHIVED}`. Suspend = reversible freeze (deny login for that tenant, flip its `sync_targets.active=false`; destroy nothing — the right default for a missed payment). Export = a `tenantId`-scoped dump across the 4 DBs + the mart partition (the `tenant_id` column *is* the export feature). Crypto-shred (delete the DEK) is the cheap, defensible final erasure.

## How the Iron Laws are preserved (no carve-out needed)

| Law | Under this design |
| --- | --- |
| **1 — each app owns its DB; no cross-app client imports** | `tenant_id` + RLS live inside each app's own Prisma package. The other 3 DBs carry `tenant_id` as un-FK'd data (like today's `merchantId`). Analytics authenticates a *cryptographic claim*, never imports db-kds. |
| **2 — DTOs via `packages/contracts` (zod)** | Session shape, the tenant-claim JWT shape, membership DTOs, and the `tenantId`-bearing loyalty event all go in contracts. |
| **3 — auth via `packages/auth`** | The tenant claim rides the existing cookie session; minting is single-sourced there. |
| **4 — Floor vs Backoffice** | *Reinforced* by the control/data-plane split. Floor surfaces get tenant context via device pairing, the same shape. |
| **5 — analytics read-only OLAP** | All analytics changes are ingest-stamping, schema, and auth. Still ingests → mart, never writes back; `deleteMartRange`'s read-source-of-truth guard is unchanged. |

The design is **additive** (new columns, a new root entity, an envelope layer over the existing key), so it needs **no ADR exception** — only re-framings: supersede ADR-0018's "NOT multi-tenant" line, and new ADRs for the Tenant entity, the RLS/scoped-client pattern, the device-pairing token, and the envelope-encryption model.

## Security model: `tenant_id` is the trust boundary; fail closed

1. **`tenant_id` is never client-supplied.** It is resolved from the validated session (control plane) or the device/claim (data plane), set as a `SET LOCAL` GUC, and enforced by RLS. `merchantId`/`locationId` from a request are *validated against* the session's tenant + allowed locations before use — derived partition keys under an authenticated boundary, not boundaries themselves.
2. **Fail closed.** A request whose resolved scope is empty/unknown returns **403 / zero rows — never a fallback to the env-default merchant.** This kills the silent-default-merchant anti-pattern: a session with no membership resolves to `null → 400`, never to "the default store." (Consequence: every account MUST have explicit membership rows — the P1 backfill must seed the owner's `OWNER` membership for both locations or the owner is locked out.)
3. **Three independent gates** confine every read to one tenant: the auth predicate (`claim.merchants` / session membership), the app predicate (`WHERE tenant_id = $1`), and the DB predicate (RLS default-deny). Any one alone is sufficient; a consolidation bug degrades to "shows all of *my* stores," never "all of everyone's."
4. **Device tokens are tenant-scoped principals.** A leaked/misconfigured board token still can't read another tenant's rows — its `tenantId` drives the same RLS wall.
