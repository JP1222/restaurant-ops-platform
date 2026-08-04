# Multi-Tenant Migration Roadmap

> **Status:** current — the phased path from today's single-tenant-implicit system (one brand, two stores) to the target in [docs/architecture/multi-tenant-architecture.md](architecture/multi-tenant-architecture.md). Each phase is independently shippable, CI-gateable, behind a flag, and rolls back to the *prior* boundary — never to "no boundary." Tenant #1 is created by backfill and behaves identically to today until a phase explicitly changes behavior.

## Guiding rules

1. **The 2 live stores never break.** Every phase backfills tenant #1 (store #1 + #2 = one tenant, two locations) to behave exactly as today.
2. **Boundary in app code first, RLS second.** The real trust boundary (session tenant claim + fail-closed scope) ships *before* the DB-level RLS defense-in-depth, so the wall exists even before the database enforces it.
3. **Additive migrations, staged.** Add `tenant_id` nullable → backfill → set-not-null/add-constraints in *separate* steps; never `SET NOT NULL` in the same migration as the add on a live table. Backfill *before* adding any `tenantId`-leading unique constraint (the `default-merchant`/`default-location`/`singleton` sentinels collide otherwise).
4. **Mark every item:** **[NOW]** = genuine value for 2 stores; **[AHEAD]** = architecting for N tenants / external customers (build the seam, defer the muscle).

---

## Phase 1 — Introduce the Tenant entity + backfill (zero behavior change) [NOW]

**Goal:** a `Tenant` row exists above `Location`; every tenant-owned table gains a nullable-then-backfilled `tenant_id`; the single implicit tenant is materialized. **No code reads it yet** — pure plumbing.

- **Apps + DBs touched:** `db-kds` (new `Tenant` model; FK `Location.tenantId`; columns on `CloverMerchant`/`PosAccount`/operational rows), `db-inventory` + `db-crm` (`tenant_id` columns + backfill), analytics OLAP mart + `config.sync_targets` (`tenant_id` column + backfill to `t_default`). `packages/contracts` gets the `Tenant`/`TenantScope` zod shapes. New ADR re-framing ADR-0018. **The `Tenant`/`TenantMembership` Prisma models MUST land in `ARCHITECTURE.md` in the same PR** (the drift gate reds otherwise).
- **Backfill:** one `UPDATE … SET tenant_id='tenant-default' WHERE tenant_id IS NULL` per table; seed the `Tenant` row; both existing locations re-parented to it.
- **Add the new tenant-leading indexes + the unique-key reworks** that the per-domain design calls for (inventory `sku`/`pinLookup`, CRM `phoneE164`/`slug`/`code`, the settings sentinel) — *after* backfill.
- **Risk:** **Low.** Additive, all backfilled to one tenant. Only real risk is a lock on a hot table → stage nullable-add / backfill / set-not-null separately.
- **Rollback:** drop the columns / `Tenant` table. Nothing reads them → free.
- **Safe while 2 stores run?** **Yes** — invisible to runtime.

---

## Phase 2 — Tenant context in the session + fail-closed scope derivation [NOW]

**Goal:** the session carries `{ accountId, tenantId, locations[] }`; `merchantId`/`locationId` become **derived from the authenticated tenant, server-side, never from a client param**. This converts the partition key into a real boundary *in app code*, before the DB even gets RLS. **This is the load-bearing security phase for today's 2 stores.**

- **Apps + DBs touched:** `packages/auth` (extend cookie-session shape — single source, Iron Law 3), `db-auth` (`WebAdminAccount` gains `TenantMembership`), `kds-api` `kds-auth.ts` (rewrite `resolveKdsMerchantId` → membership-validated + fail-closed, **kill the env-default fallback**), backoffice BFF (read tenant from validated session), `analytics-api` (`tenant-auth.ts` signed claim replacing `?merchant_id=` trust; `dashboard.ts` intersects `merchant_id` against `claim.merchants`), `apps/backoffice-web/lib/analytics-api/client.ts` (mint the claim). DTOs (session, claim, membership) in `packages/contracts`.
- **The fail-closed rule:** any request whose resolved scope is empty/unknown returns **403 / zero rows — never fall back to the default merchant.** A session with no membership → `null → 400`.
- **Analytics is the headline fix:** the `?merchant_id=`-behind-shared-token hole is closed by the signed tenant claim; analytics derives merchant_ids server-side and rejects any not owned by the claim. No db-kds import (validates a signature), still read-only.
- **Risk:** **Medium** — changes live request paths. Failure mode is "legit request now returns nothing" (over-tight scope) — *safe* (no leak) but *visible* (broken dashboard).
- **Mitigation:** feature flag + a dual-read window — log-and-allow the legacy path while asserting the new derivation returns the same rows, then flip to enforce. Keep `ANALYTICS_LEGACY_TOKEN_ALLOWED` (default-off after cutover) for break-glass.
- **Rollback:** flag back to the legacy shared-token path; keep the old code one deploy cycle.
- **Safe while 2 stores run?** **Yes, behind the flag** — the dual-read window proves parity before enforce.

---

## Phase 2b — Location switcher + device pairing (the owner's actual ask) [NOW]

**Goal:** the UX of "manage both stores from one backoffice with a store switcher," and "pin a screen to a store" via a device token instead of the default merchant.

- **Apps touched:** `backoffice-web` (header location switcher over `session.locations`; tenant-default vs location-override settings — generalize the shipped `Location.operatingHours` per-store override pattern; "Tenant-wide" badge on CRM/brand-settings pages), `kds-api` + `db-kds` (`KdsDeviceToken` gains `tenantId`; pairing flow mints a `(tenantId, locationId, deviceRole)` token, RBAC-gated by `can(effectiveRole, "devices.manage")`), `kds-web`/`crew-web`/`order-web` (consume the paired claim; `order-web` resolves `(tenant, location)` from hostname/route). crew PIN must resolve to a crewMember of the device's tenant+location (closes the crew-admin id-only gap).
- **Risk:** **Medium** — touches floor surfaces. A bad pairing flow could lock a board out.
- **Mitigation:** keep the legacy default-merchant pin behind the flag until a screen is re-paired; re-pairing is a one-time per-screen op.
- **Rollback:** flag back to default-merchant pinning.
- **Safe while 2 stores run?** **Yes** — re-pair screens one at a time; unpaired screens keep working on the legacy pin until flipped.

---

## Phase 3 — Postgres RLS as defense-in-depth [AHEAD — but cheap insurance; ship it]

**Goal:** even an app-code bug that forgets a `WHERE` returns zero cross-tenant rows, because the DB default-denies. Belt-and-suspenders on top of Phase 2.

- **Apps + DBs touched:** `db-kds`, `db-inventory`, `db-crm`, and (raw SQL) the analytics OLAP Postgres. Each app's DB role → non-superuser/non-`BYPASSRLS`/non-owner; `ENABLE` + `FORCE ROW LEVEL SECURITY`; default-deny `tenant_isolation` policy; `forTenant()` `$extends` client (or analytics' `withTenant()` wrapper) using `set_config('app.tenant_id', tid, true)`. Gate `safe-query.ts` (free-form AI SQL) behind RLS being on.
- **The one hard constraint:** `SET LOCAL` inside the query transaction (PgBouncer transaction pooling discards plain `SET`; `app.*` GUCs aren't trackable). Get this wrong and it leaks under load.
- **Risk:** **Medium-high operationally.** The leak vector is invisible in dev, only shows under concurrent prod load; the break vector ("everything returns empty") shows when a query runs outside the scoped client or a grant is missing.
- **Mitigation:** an integration test runs **two tenants through one pooled connection** and asserts isolation — the required gate for this phase.
- **Rollback:** `ALTER TABLE … DISABLE ROW LEVEL SECURITY` per table. Because Phase 2 already enforces in app code, disabling RLS degrades to "app-code-only boundary," not "no boundary."
- **Safe while 2 stores run?** **Yes** — but validate the role-swap + GUC plumbing in staging under a pooled connection first; this is the phase most likely to surface a subtle prod-only bug.
- **Decisiveness:** for 2 trusted stores this is genuinely defense-in-depth, not load-bearing. Ship it for the insurance and to make external onboarding a config change, not a security audit. If forced to choose, Phase 2 is the must-have; Phase 3 may trail it.

---

## Phase 4 — RBAC membership enforcement (ADR-0029 P3/P5) [NOW, lightly]

**Goal:** turn the federated-RBAC vocabulary into an enforced account → tenant → location allow-list.

- **[NOW]** A coarse split: owner (all locations, all perms) vs store-manager (one location) vs crew (floor only) — so a Anytown manager can't edit the Square store. This is the real `TenantMembership` allow-list + `effectiveRole()` + `can()` at every Fastify route.
- **[AHEAD]** Arbitrary-depth restaurant-group tree, cascade grants, per-location permission overrides, the formal "gatekeeper holds every permission everywhere." Pure ceremony for 2 flat locations — build the membership table now, defer the tree.
- **Apps + DBs touched:** `db-auth` (membership role/perms), `packages/auth` (enforcement helpers + `effectiveRole`), backoffice (user-management/grant UI), every BFF (check permission, not just tenant).
- **Risk:** **Medium** — getting RBAC wrong locks the owner out.
- **Mitigation:** seed the owner as full-access-everywhere in the backfill; first enforcement check is "owner bypasses" until the grant UI exists.
- **Rollback:** disable the permission check → fall back to "any authenticated tenant member sees all tenant locations." Tenant boundary (P2/P3) unaffected.
- **Safe while 2 stores run?** **Yes** — owner-bypass-by-default means enforcement can't lock anyone out before the UI lands.

---

## Phase 5 — Runtime tenant provisioning + per-tenant keys [AHEAD — design-ready, build-thin]

**Goal:** `provisionTenant` is a runtime saga (core in one db-kds+db-auth `$transaction`; idempotent analytics/CRM tails); per-tenant envelope encryption (KEK = existing `AI_TOKEN_ENCRYPTION_KEY`, DEK wrapped on `Tenant.wrappedDek`); `pos-token.ts` re-keyed to take a tenant DEK.

- **Apps touched:** a provisioning service (kds-api admin route or a CLI), all `db-*` (seed rows), secrets (mint/wrap/unwrap helpers; no new Infisical entry — the KEK is unchanged).
- **For 2 stores this is [AHEAD]:** one shared key is correct while one owner owns both stores. Build per-tenant keys before tenant #2 has a *different owner*, not before.
- **Risk:** **Low** — net-new path; live stores don't touch it until a 2nd tenant is created.
- **Rollback:** delete the new tenant's rows; existing tenants untouched.
- **Safe while 2 stores run?** **Yes** — the live stores were provisioned by backfill, not this flow.

---

## Phase 6 — Lifecycle ops [NOW for suspend/export, AHEAD for hard-purge]

**Goal:** `Tenant.status` state machine; reversible suspend; `tenantId`-scoped export; DEK crypto-shred.

- **[NOW]** Suspend (deny login for a suspended tenant at the `packages/auth` boundary; flip `sync_targets.active=false`); the `tenantId`-scoped export script (the column *is* the export feature); the DEK-delete crypto-shred primitive (one column).
- **[AHEAD]** Self-serve "download my data" UI + format guarantees; retention-timer hard purge of tenant-scoped rows.
- **Risk:** **Low.** Status flips + `WHERE tenant_id =` operations.
- **Rollback:** flip status back to `ACTIVE` (suspend is non-destructive by design — never crypto-shred on a missed payment).
- **Safe while 2 stores run?** **Yes** — the live tenant stays `ACTIVE`; these ops only act on explicitly-targeted tenants.

---

## Phase 7 — Billing / self-serve signup [AHEAD — explicitly deferred]

Not selling externally yet. **Build-now:** the *seam only* — nullable `Tenant.planId`, a `Plan` table with an `INTERNAL`/`UNLIMITED` no-op sentinel (so your own stores are never enforced), a `Subscription` stub, an `assertWithinPlan()` no-op helper at the few quota-consuming mutation points. **Build-when-selling:** provider integration + webhooks, metering, dunning/trials/proration, real plan limits, and the self-serve signup → email-verify → first-payment → `provisionTenant` gate.

- **Risk:** **None now** (seam is inert columns + a no-op helper).
- **Safe while 2 stores run?** **Yes** — `INTERNAL` plan = no enforcement on your tenant.

---

## The decisive cut — 2 stores genuinely need vs architecting-ahead

| Item | Verdict | Why |
| --- | --- | --- |
| Tenant entity + backfill (P1) | **NOW** | Makes "one backoffice, two stores" correct; cheapest phase; unblocks everything. |
| Session tenant claim + fail-closed + analytics signed token (P2) | **NOW** | The real security fix for today's 2 stores — kills `?merchant_id=` hole + silent default fallback. |
| Location switcher + tenant/location settings (P2b) | **NOW** | Literally the owner's ask. |
| Device-pairing tokens (P2b) | **NOW** | Replaces "pin to default merchant"; closes KDS-pinning + crew-id-only audit gaps. |
| RLS default-deny (P3) | **NICE NOW, ESSENTIAL BEFORE EXTERNAL TENANTS** | Defense-in-depth on top of P2 for 2 trusted stores; ship for insurance. |
| Coarse per-location RBAC (P4 partial) | **NOW (lightly)** | A Anytown manager shouldn't edit the Square store. |
| Restaurant-group tree / cascade grants / menu version engine | **AHEAD** | Ceremony for 2 flat locations. |
| Per-tenant envelope keys / crypto-shred (P5) | **AHEAD** | One owner → one key is correct. Needed when tenant #2 has a different owner. |
| DB-per-tenant / silo | **DON'T BUILD** | Overkill; multiplies migration fan-out. Keep as a documented escape hatch only. |
| Billing / self-serve (P7) | **AHEAD / DEFERRED** | Not selling yet. One `Tenant.planId` is the whole "design-ready" footprint. |

**Bottom line:** Phases 1–2 (+ the switcher/device-pairing in 2b) are the genuine *now* work. Phase 3 is cheap insurance. Phase 4 is "lightly now, fully later." Phases 5–7 are seams you build *up to*, not *out*.
