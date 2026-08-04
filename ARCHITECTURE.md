# Example Kitchen — Architecture

> 🌐 **English** · [中文](ARCHITECTURE.zh-CN.md)
> Last reviewed: 2026-05-24

This is the conceptual map of Example Kitchen: what the system is, how the pieces fit, and which invariants hold. For *how it's deployed*, see [`OPERATIONS.md`](OPERATIONS.md). For *why* specific decisions were made, see [`docs/decisions/`](docs/decisions/). For *rules to follow when changing code*, see [`AGENTS.md`](AGENTS.md).

---

## Table of Contents

1. [What this system is](#1-what-this-system-is)
2. [Domains and surfaces](#2-domains-and-surfaces)
3. [The five Iron Laws](#3-the-five-iron-laws)
4. [Data flow](#4-data-flow)
5. [Auth model](#5-auth-model)
6. [Code organization](#6-code-organization)
7. [Runtime topology](#7-runtime-topology)
8. [Why these shapes — decision records](#8-why-these-shapes--decision-records)

---

## 1. What this system is

Example Kitchen is a **multi-tenant restaurant platform** (Toast-style `Tenant → Location → Device`), currently running one tenant — the owner's brand on **Clover** and **Square** POS (see the tenancy note below). It has three product surfaces:

- **Floor** — Kitchen display screens (iPad / TV / browser). Real-time order board, customer pickup display, kitchen staff actions (fire, bump, hold). Operates 16 hours/day under kitchen-noise conditions; low error tolerance.
- **Backoffice** — Owner / manager dashboards. Sales analytics, daypart heatmaps, menu engineering, KDS device admin, Clover integration setup. Desktop-and-mobile, decision-time UX (minutes not seconds).
- **Analytics pipeline** — Clover → Postgres OLAP mart, no UI of its own. Backoffice reads from it through a BFF layer.

It is a **multi-tenant platform running one tenant today** — the owner's brand with two owner-operated stores (Anytown on Clover, store #2 on Square), co-managed by the owner and a partner. The tenancy model is `Tenant (Org) → Location → Device`: a **`Tenant`** is the hard isolation unit (Toast's "management group"), a **`Location`** is a store within it, and **multi-location is the within-tenant shape** — not the top of the model. `tenant_id` is the trust boundary (target: Postgres RLS + an authenticated claim, never a client param); `merchantId` (POS-derived: KDS/analytics) and `locationId` (brand-owned: inventory) are partition keys *underneath* it. CRM is tenant-global (one customer + points ledger per tenant, hard-walled across tenants). A POS-agnostic `Location` registry sits above the Clover `merchantId`; a `pos_accounts` table (the `PosAccount` credential entity) lets a non-Clover POS be onboarded — Clover maps one account to one store, Square maps one account to many (see [docs/square-onboarding.md](docs/square-onboarding.md)). The target architecture + phased migration are canonical in [docs/architecture/multi-tenant-architecture.md](docs/architecture/multi-tenant-architecture.md) + [docs/multi-tenant-migration-roadmap.md](docs/multi-tenant-migration-roadmap.md) ([ADR-0018](docs/decisions/0018-multi-location-architecture.md)'s "not multi-tenant" stance is superseded there).

The deployment is one Oracle ARM VM running each app as a plain `docker compose` stack, deployed over SSH. The brand's live stores run on their own POS systems (Clover, Square); this repo's production is a dev/staging-grade deployment that processes real POS data for analytics but is not the active POS.

---

## 2. Domains and surfaces

### 2.1 Apps

The **core** apps carry the order / analytics / inventory / loyalty data flow; the **satellite** apps (frontends, a prototype, two static sites) ship independently.

| App | Path | Stack | Role |
|---|---|---|---|
| **kds-api** | [`apps/kds-api`](apps/kds-api) | Fastify + Prisma + Redis + BullMQ | Floor backend — Clover ingest, ticket state, WebSocket fanout, KDS admin JSON API |
| **kds-web** | [`apps/kds-web`](apps/kds-web) | Next.js 16 (custom CSS) | Floor frontend — board, customer display, login. No admin UI (moved to Backoffice in Phase 4). |
| **analytics-api** | [`apps/analytics-api`](apps/analytics-api) | Node http + raw SQL + Luxon | OLAP ingest — Clover → mart with 9 worker subsystems (scheduler, realtime, export, hydration, repair, dq, mart, webhook-inbox, http) |
| **backoffice-web** | [`apps/backoffice-web`](apps/backoffice-web) | Next.js 16 + Tailwind v4 + shadcn/ui | Admin + analytics UI — owner/manager dashboards, KDS admin, Clover setup, inventory, the floating **AI assistant** (Phase 7; persists to `ai_*` tables — see [ADR-0011](docs/decisions/0011-ai-tables-bounded-exception.md)), and the runtime config store **`app_setting`** (plus its immutable change log **`app_setting_audit`**; see [ADR-0016](docs/decisions/0016-app-setting-table.md)) |
| **crew-web** | [`apps/crew-web`](apps/crew-web) | Next.js 16 + Tailwind v4 + React 19 | Floor inventory app for line cooks (PIN login, waste / receive / 86 / recount). Backend-wired to inventory-api (PIN login + waste / receive / 86 / recount via same-origin BFF handlers under app/api/*); deployed at crew.example.com, floor-action UI still maturing |
| **legal-site** | [`apps/legal-site`](apps/legal-site) | Static HTML/CSS via nginx | EULA + Privacy + Support for the Clover Marketplace listing |
| **marketing-site** | [`apps/marketing-site`](apps/marketing-site) | Static HTML/CSS/JS via nginx | Customer-facing marketing site at `www.example.com` |
| **inventory-api** | [`apps/inventory-api`](apps/inventory-api) | Fastify + Prisma (db-inventory) | Inventory backend — items / waste / counts / POs / vendors; serves both crew-web (Floor) and backoffice-web |
| **crm-api** | [`apps/crm-api`](apps/crm-api) | Fastify + Prisma (db-crm) | Loyalty/CRM backend — customers, append-only points ledger, rewards; POS-agnostic. See [ADR-0021](docs/decisions/0021-loyalty-crm-domain.md) |
| **notifications-api** | [`apps/notifications-api`](apps/notifications-api) | Fastify + Prisma (db-notifications) | Operator-notification backend — the events behind the backoffice bell / inbox, per-operator read/snooze/dismiss state, delivery preferences, and a manager-gated, idempotent, audited apply-action endpoint. BFF-only (bearer + `x-operator-id` / `x-operator-role`). See [ADR-0801](docs/decisions/0801-notifications-api-owns-the-operator-notification-domain.md) |
| **order-web** | [`apps/order-web`](apps/order-web) | Next.js 16 + Tailwind v4 | Customer-facing online ordering (order-ahead / pickup). **Backend-wired** to kds-api `/api/order/*` via same-origin BFF; Clover hosted-checkout sandbox-verified, prod live-pay pending `NEXT_PUBLIC_CLOVER_*`. See [ADR-0025](docs/decisions/0025-online-ordering-architecture.md) |

### 2.2 Shared packages

| Package | Path | What it owns |
|---|---|---|
| **contracts** | [`packages/contracts`](packages/contracts) | Zod schemas + TS types for any DTO crossing an app boundary (kds-api ↔ kds-web ↔ backoffice-web ↔ iOS) |
| **db-kds** | [`packages/db-kds`](packages/db-kds) | Prisma schema, migrations, generated client for KDS business tables (tickets, orders, merchants, sync state). **Tenancy layer** ([ADR-0818](docs/decisions/0818-multi-tenant-platform-architecture.md), multi-tenant platform): `tenants` (`Tenant`) is the top-level cross-tenant isolation unit (a restaurant business; Toast "management group"); `Location` carries a `tenantId` — the trust boundary above the store — backfilled to the single implicit tenant in Phase 1 (nothing reads it yet; the phased path is [docs/multi-tenant-migration-roadmap.md](docs/multi-tenant-migration-roadmap.md)). **Multi-provider / POS-account layer** (store #2 = Square; see [docs/square-onboarding.md](docs/square-onboarding.md)): `pos_accounts` (`PosAccount`) is the provider **credential** entity — one row per connected POS account, holding `provider` + `providerMerchantId` + OAuth/PAT tokens + `authStatus`; the token lives here, never duplicated onto a per-store row. `PosAccount 1──N CloverMerchant` (the per-store "PosStore" binding, [ADR-0019](docs/decisions/0019-decouple-store-identity-from-clover.md)) `──1 Location` ([ADR-0018](docs/decisions/0018-multi-location-architecture.md)) — **Clover is the fan-out-of-one special case** (account ≡ store), Square fans one account out to N locations. `kds_provider_configs` (`KdsProviderConfig`) holds per-merchant-per-provider integration config (enable flag, environment, external/provider location ids, channel link id, API token + HMAC secret incl. ciphered columns, webhook-registration status); `kds_provider_events` (`KdsProviderEvent`) is the idempotent provider-event inbox (dedup `fingerprint`, `ProviderEventStatus` lifecycle, attempts/jobId); `provider_app_states` (`ProviderAppState`) tracks per-(provider, environment) app-level webhook-verification / signing state. Order source is discriminated by the `OrderProvider` enum (`CLOVER` / `DELIVERECT` / `DEMO` / `SQUARE`). This layer stays inside db-kds — **no Iron Law crossing**; it elaborates the ADR-0018 / ADR-0019 store-identity decisions, and the unified-model design is recorded in [ADR-0795](docs/decisions/0795-posaccount-posstore-unified-store-identity-model.md) (which realizes ADR-0019's deferred credential split). |
| **db-auth** | [`packages/db-auth`](packages/db-auth) | Prisma schema, migrations, generated client for the auth tables (`web_admin_accounts`, `web_authn_credentials`, and `tenant_memberships`). Same physical Postgres as db-kds; the split is at the Prisma package boundary so `packages/auth` does not depend on `db-kds`. See [ADR-0015](docs/decisions/0015-extract-auth-tables-into-db-auth-package.md). **Tenant axis** ([ADR-0818](docs/decisions/0818-multi-tenant-platform-architecture.md), multi-tenant platform): `tenant_memberships` (`TenantMembership`) records which tenant(s) an admin account belongs to and its role within each — a bare un-FK'd `tenantId` (the `Tenant` table lives in db-kds; Iron Law 1). Backfilled to the single implicit tenant in Phase 2; nothing reads it until the fail-closed session-claim rewrite (the phased path is [docs/multi-tenant-migration-roadmap.md](docs/multi-tenant-migration-roadmap.md)). Orthogonal to the within-tenant *location* axis (an owner sees every Location). |
| **db-inventory** | [`packages/db-inventory`](packages/db-inventory) | Prisma schema, migrations, generated client for inventory tables (items, recipes, vendors, waste, counts, POs, the append-only `inventory_stock_movements` ledger, the `inventory_depletion_cursor` poll watermark, the effective-dated `inventory_labor_costs` write-source for analytics' prime-cost leg, the append-only `inventory_item_cost_history` (per-usage cost effective-dated by a DB trigger, so analytics' count-based actual COGS values each count at the cost effective then), the learned `inventory_item_aliases` that map a vendor's printed invoice wording to a canonical item for the AI invoice scanner, the `inventory_item_packs` + `inventory_barcodes` that model packaging as named (optionally per-vendor) conversion factors to a stable base unit and resolve a scanned UPC to an (item, pack), and the `inventory_receipt_scans` archive that keeps each confirmed scanned receive's original invoice image — bytes in Cloudflare R2, only the object key in Postgres — plus an immutable line snapshot, keyed by the same idempotency ref as the stock movements it explains). Its own Postgres (`INVENTORY_DATABASE_URL`); consumed only by inventory-api. Location-scoped per [ADR-0018](docs/decisions/0018-multi-location-architecture.md); sales-driven depletion via the stock-movement ledger per [ADR-0028](docs/decisions/0028-sales-driven-inventory-depletion.md); labor cost emitted to analytics-api per [ADR-0033](docs/decisions/0033-labor-cost-as-effective-dated-reference.md); count-based actual COGS + effective-dated cost history per [ADR-0573](docs/decisions/0573-count-based-actual-cogs-and-yield-variance.md); learned vendor aliases per [ADR-0586](docs/decisions/0586-learned-vendor-aliases-for-invoice-receiving.md); the base-unit / per-vendor-pack / barcode model per [ADR-0737](docs/decisions/0737-inventory-unit-model-stable-base-unit-per-vendor-packs-and-barcode-mapping.md). |
| **db-crm** | [`packages/db-crm`](packages/db-crm) | Prisma schema, migrations, generated client for the loyalty/CRM tables (`crm_customers`, `crm_loyalty_accounts`, the append-only `crm_points_ledger`, `crm_rewards`, `crm_reward_redemptions`, `crm_referrals`, `crm_dead_letter_jobs`). Its own Postgres (`CRM_DATABASE_URL`); consumed only by crm-api. See [ADR-0021](docs/decisions/0021-loyalty-crm-domain.md). |
| **db-notifications** | [`packages/db-notifications`](packages/db-notifications) | Prisma schema, migrations, generated client for the operator-notification tables (`notifications` events, the per-operator `notification_states` overlay for read/snooze/dismiss, and `notification_prefs` + `notification_category_prefs` for delivery preferences). Enum values match the contract wire strings 1:1. Its own Postgres (`NOTIFICATIONS_DATABASE_URL`); consumed only by notifications-api. See [ADR-0801](docs/decisions/0801-notifications-api-owns-the-operator-notification-domain.md). |
| **auth** | [`packages/auth`](packages/auth) | Passkey (WebAuthn) + Argon2id password + cookie session, shared by kds-api / kds-web / backoffice-web |

---

## 3. The five Iron Laws

These are the invariants that hold across the suite. Violating any of them creates architectural drift that's expensive to undo. See [`AGENTS.md`](AGENTS.md) for the rule text and [`docs/decisions/0002-five-iron-laws.md`](docs/decisions/0002-five-iron-laws.md) for why each one exists.

| # | Law | Why it exists |
|---|---|---|
| 1 | **Database boundary** — each app owns its own Postgres database. No cross-app DB clients. | Migration coordination becomes impossible when one schema is shared. Backoffice reads from KDS DB only because it reuses the auth tables — never business tables. |
| 2 | **Contract boundary** — cross-app DTOs flow through `packages/contracts` zod schemas. No hand-written DTOs. | Prevents the kds-web / iOS / backoffice DTO copies from drifting when kds-api changes. |
| 3 | **Auth boundary** — passkey / cookie / session logic lives in `packages/auth`. No app reimplements. | Three apps need the same passkey flow. Three copies = three subtly-different bugs. |
| 4 | **Floor vs Backoffice** — `kds-web` is Floor (kitchen TVs, board, display); `backoffice-web` is admin (owners, managers). Don't conflate. | Different UX, different refresh cadence, different error tolerance. Mixing them on one surface produces a worse version of both. |
| 5 | **Reads are not writes** — `analytics-api` is read-only OLAP. It never writes to KDS's DB. Backoffice never writes to either. All writes flow through the originating service. | Two-master state machines invent corruption modes that no test catches. |

---

## 4. Data flow

### 4.1 Order ingest (Clover → us)

```
                ┌──────────────┐
                │  Clover POS  │
                └──────┬───────┘
                       │  webhook on order events
                       ▼
         webhooks.example.com/clover    (Traefik dynamic config)
                       │
                       │  Traefik mirroring service
              ┌────────┴────────┐
              ▼                 ▼
         kds-api             analytics-api
         /clover/webhooks    /webhooks/clover
              │                 │
              ▼                 ▼
         realtime sync     webhook-inbox queue
         (Clover REST       (idempotent, retry,
          backfill +         eventually consistent
          ticket state)      OLAP mart refresh)
              │                 │
              ▼                 ▼
         postgres-kds      postgres-analytics
         (OLTP)            (OLAP)
```

Two key properties:

- **Webhook fan-out via Traefik mirroring** — one Clover POST lands on both backends independently. Either failing doesn't impede the other. See [`infrastructure/traefik/dynamic/clover-webhook-fanout.yml`](infrastructure/traefik/dynamic/clover-webhook-fanout.yml) and `HANDOFF-clover-webhook-fanout.md`.
- **Two separate DBs by design** — KDS optimizes for sub-second ticket updates over a few thousand rows; analytics optimizes for multi-year aggregate queries over millions of rows. Different schemas, different indexes, different invariants. See ADR-0001.

### 4.2 Floor real-time

```
kds-api  ──WebSocket /ws──►  kds-web board  (browser)
   │                          ┌──────────────────────────┐
   │                          │  /board /display /login  │
   │                          └──────────────────────────┘
   │
   └──WebSocket /ws──►  iOS YRBoard (native)
                          ┌────────────────────────────┐
                          │  YRUI / YRRealtime / YRStore │
                          └────────────────────────────┘
```

Both clients consume the same `/ws?merchantId=...` stream. The board's authority is `kds-api` + `postgres-kds`; the clients keep an outbox for actions that must reach the server but tolerate brief disconnects.

> ⚠️ This realtime path **assumes the cloud is reachable** — every hop (Clover → kds-api → WebSocket → screen) crosses the public internet. The outbox covers *short* drops; it does not survive a sustained WAN/router outage (tickets won't reach screens). A LAN local-hub fallback is roadmap, not built — see [ADR-0013](docs/decisions/0013-lan-fallback-roadmap.md).

### 4.3 Backoffice analytics

```
browser  ──HTTPS──►  backoffice-web (Next.js)
                      │
                      │  BFF Route Handlers under /api/*
                      │  Bearer auth + zod validation
                      ▼
                  analytics-api /admin/api/*
                      │
                      ▼
                  postgres-analytics  (mart MVs, refreshed ~5min)
```

`backoffice-web` is a **pure BFF** in front of `analytics-api`. The browser never talks to analytics-api directly. Reasoning:
- Session is cookie-based in the browser; analytics-api only knows bearer auth.
- BFF adapts analytics API shapes into UI-shaped JSON, isolating UI from internal schema.
- BFF can compose multiple analytics calls (e.g. `/api/today/insights` parallelizes two analytics queries).

### 4.4 Backoffice ↔ KDS admin

```
browser  ──HTTPS──►  backoffice-web (admin pages)
                      │
                      │  BFF /api/admin/kds/*
                      │  Bearer: KDS_INTERNAL_ADMIN_TOKEN
                      ▼
                  kds-api /api/admin/kds/*
```

Phase 4 (see docs/archive/HANDOFF-phase-closeouts.md) moved all KDS admin out of `kds-web` (it was 1490 lines of inline HTML) and into Backoffice. `kds-api` retained the JSON endpoints; the HTML render is gone. See ADR-0003 for the boundary reasoning.

---

## 5. Auth model

### 5.1 Browser ↔ apps (Floor + Backoffice)

| Surface | Method | Cookie | RP ID |
|---|---|---|---|
| `kds.example.com` (Floor login + admin) | Passkey (WebAuthn) primary, Argon2id password fallback | `rop_session` (default) | `kds.example.com` |
| `backoffice.example.com` (admin shell) | Same | `rop_backoffice_session` (distinct from Floor so localhost dev doesn't collide) | `backoffice.example.com` |

Both apps consume the same `WebAdminAccount` + `WebAuthnCredential` tables. They live in the shared KDS Postgres physically, but the Prisma package that owns them is [`packages/db-auth`](packages/db-auth) (see [ADR-0015](docs/decisions/0015-extract-auth-tables-into-db-auth-package.md)) — `db-kds` no longer surfaces these models. A user registered through Floor's `/setup-passkey` can log into Backoffice with the same passkey **only if** the passkey was registered with `RP_ID = backoffice.example.com` (or you use `WEBAUTHN_RP_ID` set to the shared parent domain). The `WebAdminRole` enum carries `OWNER`/`MANAGER` (plus a deprecated `ADMIN`) per the federated RBAC model in [ADR-0029](docs/decisions/0029-federated-rbac-and-auth-lifecycle.md); floor staff remain a separate identity (`inventory_employees` in db-inventory) and the two stores share one role/permission vocabulary via the db-free `@rop/auth/rbac` module.

> ⚠️ **WebAuthn RP IDs are bound at registration time and cannot migrate**. Changing `WEBAUTHN_RP_ID` forces all users to re-enroll.

### 5.2 Service-to-service

| From → To | Method | Token env (both sides must match) |
|---|---|---|
| backoffice-web → kds-api `/api/admin/kds/*` | `Authorization: Bearer …` | `KDS_INTERNAL_ADMIN_TOKEN` |
| backoffice-web → analytics-api `/admin/api/*` | `Authorization: Bearer …` | `ANALYTICS_ADMIN_TOKEN` (matches analytics-api's `ADMIN_TOKEN`) |

If either token is unset on either side, the request returns `503 admin_not_configured` (fail-closed). Tokens are independent — rotating one doesn't disrupt the other.

These bearer tokens are deliberately **simple shared secrets**, not JWTs. The trust model is: only an operator with host access (via Infisical) can set them; only the two services know them; they rotate yearly. We don't need expiry / refresh / signature verification at this scale. See ADR for the trade-off discussion.

### 5.3 Webhook auth

| Endpoint | Method |
|---|---|
| `/api/clover/webhooks` (kds-api) | Optional Clover signature header verification when `CLOVER_WEBHOOK_AUTH_CODE` is set |
| `/webhooks/clover` (analytics-api) | Same |

---

## 6. Code organization

### 6.1 Monorepo layout

```
restaurant-ops-platform/
├── apps/
│   ├── kds-api/             Fastify backend (Floor authoritative state)
│   ├── kds-web/             Next.js Floor frontend
│   ├── analytics-api/       OLAP ingest (no UI)
│   └── backoffice-web/      Next.js admin shell + BFF
├── packages/
│   ├── contracts/           Zod DTOs (cross-app source of truth)
│   ├── db-kds/              KDS Prisma schema + migrations + client
│   ├── db-auth/             Auth Prisma schema + migrations + client (ADR-0015)
│   └── auth/                Passkey + session library
├── ios/                     Swift Package workspace (native KDS client)
├── compose/         Production `docker compose` stacks (SSH-deployed)
├── docker-compose*.yml      Local dev + observability stacks
├── docs/
│   ├── decisions/           ADRs (this file's siblings)
│   └── ...                  Topic guides
├── scripts/                 Build, deploy, sync, validation
└── infrastructure/
    └── traefik/             Dynamic config (webhook fan-out)
```

### 6.2 Per-app conventions

Each `apps/<name>/AGENTS.md` declares that app's rules. Common patterns:

- **kds-api**: provider-specific payloads stay behind backend adapters. `src/lib/web-auth.ts` is a shim onto `packages/auth/server`.
- **kds-web**: keeps custom CSS (kitchen-display aesthetic); does **not** import the Backoffice design tokens. The two products are intentionally not visually unified.
- **analytics-api**: free-form SQL goes through `src/analytics/safe-query.ts` (parameterized whitelist). No raw client SQL elsewhere.
- **backoffice-web**: pure transforms in `lib/<feature>/*-transform.ts` with injected time anchors for deterministic tests. URL state in `lib/<feature>/url-state.ts`. shadcn Charts (Recharts wrapper), not raw Recharts.

### 6.3 BFF + transform pattern (Backoffice)

The pattern shipped through Phases 2–4:

```
app/api/today/route.ts                 ─► fetch from analytics-api, validate with zod
lib/analytics-api/sales-transform.ts   ─► pure functions that turn API JSON into UI shape
hooks/use-today.ts                     ─► TanStack Query hook (staleTime: 60_000)
components/today/*.tsx                 ─► UI components consuming the hook
```

The transform layer is the **only** thing that knows analytics-api's wire shape. Replace the upstream tomorrow → only the transform layer changes.

---

## 7. Runtime topology

Production runs on a single Oracle ARM VM, each app a plain `docker compose` stack deployed over SSH. The full topology — networks, healthchecks, domains, image flow — is in [`OPERATIONS.md` §1](OPERATIONS.md#1-system-topology). Briefly:

| Stack | Containers |
|---|---|
| `kds` | `migrate`, `kds-api`, `kds-worker × 2`, `kds-web` |
| `analytics` | `analytics-api` |
| `backoffice` | `backoffice-web` |
| (datastores — plain compose services, named volumes, internal-only) | `postgres-kds`, `postgres-analytics`, `redis-kds` |
| (observability, separate compose project) | Grafana, Prometheus, Loki, Promtail |

Build flow: GitHub Actions self-hosted arm64 runner on Mac Mini → multi-stage Docker build → `ghcr.io/example-org/rop-<app>:main` → SSH to Oracle host → `scripts/deploy-stack.sh <stack>` (git-sync, then `docker compose pull && up -d`). Secrets are injected at container boot from Infisical ([ADR-0020](docs/decisions/0020-adopt-infisical-for-runtime-secrets.md)). See [`OPERATIONS.md` §3](OPERATIONS.md#3-cicd-pipeline).

---

## 8. Why these shapes — decision records

The "why" behind each load-bearing shape lives in [`docs/decisions/`](docs/decisions/). Read these when:
- You're tempted to violate an Iron Law and want to know what would break.
- You're proposing a refactor and want to know which constraints are real.
- You inherited the project and want to skip the archaeology.

| ADR | Topic |
|---|---|
| [0001](docs/decisions/0001-pnpm-monorepo-with-four-apps.md) | pnpm monorepo with 4 apps (vs polyrepo, vs single app) |
| [0002](docs/decisions/0002-five-iron-laws.md) | Five Iron Laws as boundary enforcement |
| [0003](docs/decisions/0003-floor-vs-backoffice-split.md) | Floor (kds-web) vs Backoffice (backoffice-web) split |
| [0004](docs/decisions/0004-static-clover-token-from-db.md) | Static Clover token from DB, OAuth optional |
| [0005](docs/decisions/0005-dokploy-over-coolify.md) | Dokploy v0.29 chosen over Coolify v4 |
| [0006](docs/decisions/0006-self-hosted-arm64-runner.md) | Self-hosted arm64 GHA runner on Oracle (superseded by 0008) |
| [0007](docs/decisions/0007-validate-compose-env-script.md) | `validate-compose-env.py` as guardrail against env drift |
| [0008](docs/decisions/0008-cutover-arm64-runner-to-mac-mini.md) | Cutover arm64 GHA runner from Oracle to Mac Mini |
| [0009](docs/decisions/0009-pipeline-optimization-followups.md) | Pipeline optimization follow-ups (backlog) |
| [0010](docs/decisions/0010-heartbeat-on-mac-mini.md) | Heartbeat monitoring on Mac Mini |
| [0011](docs/decisions/0011-ai-tables-bounded-exception.md) | AI assistant tables: bounded exception to the DB boundary |
| [0012](docs/decisions/0012-architecture-as-guardrails.md) | Architecture as guardrails — the AI-agent contract |
| [0013](docs/decisions/0013-lan-fallback-roadmap.md) | Realtime assumes cloud reachability — LAN fallback roadmap |
| [0014](docs/decisions/0014-manual-deploy-trigger.md) | Manual deploy trigger |
| [0014](docs/decisions/0014-sentry-saas-over-glitchtip.md) | Sentry SaaS over GlitchTip |
| [0015](docs/decisions/0015-extract-auth-tables-into-db-auth-package.md) | Extract auth tables into db-auth package |
| [0016](docs/decisions/0016-app-setting-table.md) | `app_setting` runtime config table |
| [0017](docs/decisions/0017-deepseek-replaces-codex.md) | DeepSeek replaces Codex |
| [0018](docs/decisions/0018-multi-location-architecture.md) | Multi-location architecture — `Location` over `merchantId` |
| [0018](docs/decisions/0018-tooling-selection-for-agent-dev.md) | Tooling selection for agent dev |
| [0019](docs/decisions/0019-decouple-store-identity-from-clover.md) | Decouple store identity from Clover — POS-agnostic store model |
| [0020](docs/decisions/0020-adopt-infisical-for-runtime-secrets.md) | Adopt Infisical for runtime secrets |
| [0021](docs/decisions/0021-loyalty-crm-domain.md) | Loyalty/CRM domain |
| [0022](docs/decisions/0022-loyalty-ledger-and-accrual.md) | Loyalty ledger & accrual |
| [0023](docs/decisions/0023-loyalty-points-legal-posture.md) | Loyalty points legal posture |
| [0024](docs/decisions/0024-membership-crm-customer-identity.md) | Membership/CRM customer identity |
| [0025](docs/decisions/0025-online-ordering-architecture.md) | Online ordering architecture |
| [0026](docs/decisions/0026-integration-tests-via-testcontainers.md) | Integration tests via Testcontainers |
| [0027](docs/decisions/0027-clover-online-payment-and-order-bridge.md) | Clover online payment + Atomic-Order bridge |
| [0028](docs/decisions/0028-sales-driven-inventory-depletion.md) | Sales-driven inventory depletion |
| [0029](docs/decisions/0029-federated-rbac-and-auth-lifecycle.md) | Federated RBAC + auth lifecycle |
| [0030](docs/decisions/0030-semantic-metric-registry-as-ai-grounding.md) | Semantic metric registry as AI grounding |
| [0031](docs/decisions/0031-profitability-analytics-cost-dimension.md) | Profitability analytics cost dimension |
| [0032](docs/decisions/0032-forecasting-compute-surface.md) | Forecasting compute surface |
| [0033](docs/decisions/0033-labor-cost-as-effective-dated-reference.md) | Labor cost as an effective-dated reference dimension (prime cost) |
| [0033](docs/decisions/0033-verify-clover-webhook-hmac.md) | Verify Clover webhook HMAC signatures (staged fail-open → fail-closed) |
| [0034](docs/decisions/0034-clover-sync-dead-letter-queue.md) | Dead-letter queue + replay API for failed Clover sync events |
| [0035](docs/decisions/0035-analytics-read-dtos-into-contracts.md) | Move analytics-api read DTOs into @rop/contracts |

New decisions: copy [`docs/decisions/README.md`](docs/decisions/README.md)'s template, increment the number, link from this section.

---

> Architecture changes? Edit this file *and* add an ADR if the change is load-bearing. The Chinese mirror [`ARCHITECTURE.zh-CN.md`](ARCHITECTURE.zh-CN.md) should be updated in the same PR.
