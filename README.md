# Example Kitchen

> English · [中文](README.zh-CN.md)

**Example Kitchen** is a **multi-tenant restaurant platform** (Toast-style `Tenant → Location → Device`), currently running one tenant — the owner's brand with two locations (Clover + Square POS): kitchen display, customer pickup display, owner/manager analytics, inventory, line-cook floor app, native iOS KDS, plus the marketing and legal sites that ship with the Clover App Market listing. The target architecture + phased migration are canonical in [docs/architecture/multi-tenant-architecture.md](docs/architecture/multi-tenant-architecture.md) + [docs/multi-tenant-migration-roadmap.md](docs/multi-tenant-migration-roadmap.md); multi-location is the within-tenant shape ([ADR-0018](docs/decisions/0018-multi-location-architecture.md)'s "not multi-tenant" stance is superseded there).

The repo started as a single KDS server and now spans **three product surfaces** across the tenant's stores (Clover + Square POS):

- **Floor** — kitchen displays, customer pickup screen, line-cook inventory app (web + iPad + iOS native)
- **Backoffice** — owner/manager analytics, daypart heatmaps, menu engineering, KDS admin, Clover setup, AI assistant
- **Analytics pipeline** — Clover -> Postgres OLAP mart, headless, read-only

It is a pnpm + Turborepo monorepo deployed to a single Oracle ARM VM, where each app runs as a plain `docker compose` stack pushed over SSH. Production runs the data pipeline against real POS data; the live POS systems run on the stores' own restaurant systems.

> Conceptual map: **[`ARCHITECTURE.md`](ARCHITECTURE.md)** ([中文](ARCHITECTURE.zh-CN.md))
> Day-2 deployment / ops: **[`OPERATIONS.md`](OPERATIONS.md)** ([中文](OPERATIONS.zh-CN.md))
> Rules for AI agents and humans editing the code: **[`AGENTS.md`](AGENTS.md)**

---

## Apps

Ten applications split into **core** (carry the order / analytics / inventory / loyalty data flow) and **satellite** (the customer ordering surface + a prototype floor app + two static sites + the native iOS client) deployments.

### Core

| App | Path | Stack | Production URL | Role |
|---|---|---|---|---|
| **kds-api** | [`apps/kds-api`](apps/kds-api) | Fastify + Prisma + Redis + BullMQ | `kds.example.com/api` | Floor backend — Clover ingest, ticket state, WebSocket fan-out, KDS admin JSON API, auth + passkeys |
| **kds-web** | [`apps/kds-web`](apps/kds-web) | Next.js 16 (custom CSS) | `kds.example.com` | Floor frontend — board, customer display, login. No admin UI (moved to Backoffice). |
| **analytics-api** | [`apps/analytics-api`](apps/analytics-api) | Node http + raw SQL (`pg`) + Luxon + zod | `analytics.example.com` | OLAP ingest — Clover -> mart pipeline with 9 worker subsystems (scheduler, realtime, export, hydration, repair, dq, mart, webhook-inbox, http). Read-only by design. |
| **backoffice-web** | [`apps/backoffice-web`](apps/backoffice-web) | Next.js 16 + Tailwind v4 + shadcn/ui + TanStack Query | `backoffice.example.com` | Owner / manager admin — analytics dashboards, KDS admin, Clover setup, inventory, AI assistant, runtime config store |
| **inventory-api** | [`apps/inventory-api`](apps/inventory-api) | Fastify + Prisma (`db-inventory`) | internal | Inventory persistence — items, recipes, vendors, purchase orders, counts, waste. Single write path serving both `crew-web` (floor) and `backoffice-web` (manager) |
| **crm-api** | [`apps/crm-api`](apps/crm-api) | Fastify + Prisma (`db-crm`) | internal | Loyalty / CRM backend — customers, append-only points ledger, rewards. POS-agnostic; earns from the order data flow. See [ADR-0021](docs/decisions/0021-loyalty-crm-domain.md). |

### Satellite

| App | Path | Stack | Production URL | Role |
|---|---|---|---|---|
| **crew-web** | [`apps/crew-web`](apps/crew-web) | Next.js 16 + Tailwind v4 + React 19 | `crew.example.com` (floor-action UI still maturing) | Floor inventory app for Spanish-speaking line cooks: PIN login, record waste / receive deliveries / view 86 list / quick re-counts. iPad + phone, ES-first with EN toggle. |
| **order-web** | [`apps/order-web`](apps/order-web) | Next.js 16 + Tailwind v4 + React 19 | `order.example.com` | Customer-facing online ordering — menu, build a roll, Clover Hosted Checkout, pickup at Anytown. BFF-wired to `kds-api` `/api/order/*`; sandbox-verified, prod live-pay pending `NEXT_PUBLIC_CLOVER_*`. See [ADR-0025](docs/decisions/0025-online-ordering-architecture.md). |
| **legal-site** | [`apps/legal-site`](apps/legal-site) | Vanilla HTML/CSS + nginx | `legal.example.com` | EULA + Privacy Policy + Support for the Clover App Market listing. Zero-dep markdown -> HTML build from [`docs/legal/`](docs/legal/). |
| **marketing-site** | [`apps/marketing-site`](apps/marketing-site) | Vanilla HTML/CSS/JS + nginx | `www.example.com` | Customer-facing storefront for the Anytown location — menu, gift cards, hours, mall map. No tracking, strict CSP. |
---

## Packages

| Package | Path | Owns |
|---|---|---|
| **contracts** | [`packages/contracts`](packages/contracts) | Shared Zod schemas + TypeScript types for any DTO crossing an app boundary (also code-generated into Swift for iOS) |
| **auth** | [`packages/auth`](packages/auth) | Passkey (WebAuthn) + Argon2id password + cookie session, shared by kds-api / kds-web / backoffice-web; also exports `@rop/auth/crew` for the inventory crew session + PIN helpers |
| **db-kds** | [`packages/db-kds`](packages/db-kds) | Prisma schema, migrations, generated client for KDS business tables (tickets, orders, merchants, sync state) |
| **db-auth** | [`packages/db-auth`](packages/db-auth) | Prisma schema, migrations, client for auth tables (`web_admin_accounts`, `web_authn_credentials`). Same physical Postgres as `db-kds`; split at the package boundary — [ADR-0015](docs/decisions/0015-extract-auth-tables-into-db-auth-package.md). |
| **db-inventory** | [`packages/db-inventory`](packages/db-inventory) | Prisma schema, migrations, generated client for the inventory database (separate Postgres from KDS) |
| **db-crm** | [`packages/db-crm`](packages/db-crm) | Prisma schema, migrations, generated client for the loyalty/CRM tables (`crm_customers`, `crm_loyalty_accounts`, the append-only `crm_points_ledger`, `crm_rewards`, `crm_reward_redemptions`, `crm_referrals`). Its own Postgres (`CRM_DATABASE_URL`); consumed only by crm-api. See [ADR-0021](docs/decisions/0021-loyalty-crm-domain.md). |

---

## Quick Start

**Prerequisites** (cannot be auto-installed): Docker Desktop (running) and Node 22 with `corepack` (ships with Node — `pnpm` auto-activates).

This repo is pnpm-only. Use `pnpm install` (or `make dev-up`); npm/yarn installs
are rejected by the root install guard.

```bash
make dev-up    # fresh clone -> bootstrapped stack (idempotent, safe to re-run)
make dev       # launch the 6-app stack, then open http://localhost:3001
make admin     # (re)set the local admin login: admin / admin (dev-up already did this)
```

Log in at `http://localhost:3001` with **admin / admin** (a fixed local
password — dev only; change it via `DEV_ADMIN_PASSWORD` in `scripts/dev-defaults.sh`).

`make dev-up` runs the whole bootstrap: installs deps, starts the three Postgres
databases (`kds:5432`, `inventory:5433`, `analytics:5434`) + Redis and **waits
for healthy**, creates the analytics database, generates Prisma clients,
**builds the workspace libraries** (required before the `tsx` apps can import
them), applies migrations to **all three** logical DBs (KDS **+ auth** +
inventory; analytics self-migrates on first boot), and seeds demo data. Run
`make help` for every verb, or [`make doctor`](Makefile) to diagnose the env.

Default local ports:

| App | URL |
|---|---|
| kds-web (Floor board) | http://localhost:3000 |
| backoffice-web (admin) | http://localhost:3001 |
| kds-api | http://localhost:4000 |
| inventory-api | http://localhost:4100 |
| analytics-api (health) | http://localhost:3100/healthz |
| crew-web (`pnpm --filter @rop/crew-web dev`) | http://localhost:3003 |

Static previews: legal-site `8080`, marketing-site `8081`.

**Secrets.** By default the stack injects committed non-secret localhost values
(`scripts/dev-defaults.sh`) — zero setup. For real secrets, set
`SECRETS_BACKEND=infisical` after `infisical login` (no `.env` on disk; ADR-0020,
which ships with the Infisical secrets work). Infisical is also auto-selected when
`.infisical.json` is present and either an `INFISICAL_*` credential is set (CI /
machine identity) **or** you're interactively logged in (`infisical login` — keyring
creds, detected by a quick silent probe); a fresh clone with no login still boots on
the dummy defaults. Force either with `SECRETS_BACKEND=local|infisical`. Override any
default locally in a gitignored `.env.local`.

**Zero-login teammate onboarding.** You don't have to `infisical login` interactively
— drop an Infisical credential into `.env.local` and the stack boots from Infisical
with no login: a service token (`INFISICAL_TOKEN=…`) is used directly, or a read-only
dev **machine identity** (`INFISICAL_MACHINE_CLIENT_ID=…` + `INFISICAL_MACHINE_CLIENT_SECRET=…`)
is exchanged for a short-lived access token (same Universal Auth flow as the prod
`with-infisical` entrypoint). Hand a teammate that one credential + a container runtime
(Docker / OrbStack / colima for the Postgres + Redis the stack needs) and `./scripts/dev-local-test.sh`
runs — no interactive login, no per-secret handoff. The dev Infisical env holds only
dev dummies + a dev-scoped Gemini key + Clover sandbox creds, so a dev token exposes
nothing production-sensitive.

**Tests are a separate verb from the stack:** `make test` is self-contained and
needs no running services. New here? Read [docs/LOCAL-DEV-GUIDE.md](docs/LOCAL-DEV-GUIDE.md)
for how local dev/test is meant to work and why.

### Verify before declaring "done"

```bash
pnpm lint
pnpm build
pnpm test
pnpm docs:check
pnpm test:e2e     # if UI flows changed
```

### Local pre-push checks (opt-in)

Want lint + typecheck to fail-fast locally before CI sees it? Install the opt-in pre-push hook once with `bash scripts/install-pre-push-hook.sh`. It writes a hook to `.git/hooks/pre-push` that runs `pnpm lint` and `pnpm exec turbo run typecheck` on every push (sub-30s on a warm Turbo cache). Nothing is added to `package.json` or `pnpm-lock.yaml`, so this is strictly per-contributor. Bypass once with `git push --no-verify`; uninstall with `rm .git/hooks/pre-push`.

---

## Endpoints

### kds-api (Floor backend)

Browser routes (`apps/kds-web` proxies to these):

- `/` — browser board shell
- `/board` — browser board route
- `/display` — public customer pickup display for a store TV
- `/login` — browser login page
- `/setup-passkey` — passkey enrollment

API + realtime:

- `GET /api/health` — health check for Docker + operators
- `GET /api/auth/session`, `POST /api/auth/logout` — browser session state
- `/api/auth/passkeys/*` — passkey registration, authentication, listing, deletion
- `GET /api/clover/install`, `GET /api/clover/oauth/callback` — optional Clover OAuth
- `POST /api/clover/webhooks` — Clover webhook receiver (mirrored from Traefik fan-out alongside analytics)
- `GET /api/clover/status` — Clover integration state
- `GET /api/kds/tickets` — board snapshot / incremental sync
- `POST /api/kds/tickets/:ticketId/actions` — ticket-level KDS actions
- `POST /api/kds/tickets/:ticketId/items/:itemKey/actions` — item-level actions
- `PUT/DELETE /api/kds/tickets/:ticketId/local-edit` — local ticket edits
- `DELETE /api/kds/tickets/:ticketId` — local-only ticket deletion
- `GET/PUT /api/kds/config`, `GET/PUT /api/kds/settings` — board configuration
- `POST /api/kds/demo/orders` — seed demo KDS orders
- `/api/deliverect/*` — Deliverect registration, order, product, and order-status routes
- `POST /api/internal/sync/orders/:orderId` — manual internal order sync
- `/ws?merchantId=...` — realtime board stream

### inventory-api (Floor + Backoffice inventory backend)

- `GET /api/inventory` — full `InventoryDataset`
- `GET /api/inventory/pos/:id` — purchase-order detail for the floor receive flow
- `POST /api/inventory/items/:id/toggle-86`
- `POST /api/inventory/counts` — body `InventoryCountSubmission`
- `POST /api/inventory/waste` — body `InventoryWasteSubmission`
- `POST /api/inventory/pos/:id/receive` — body `InventoryReceiveSubmission`
- `POST /api/crew/login`, `POST /api/crew/logout`, `GET /api/crew/me` — crew PIN session (6-digit PIN, rate-limited per device/IP)
- `GET /api/admin/crew`, `POST /api/admin/crew`, `PATCH /api/admin/crew/:id`, `POST /api/admin/crew/:id/pin` — manager-only crew roster (bearer-auth)
- `GET /api/health`, `GET /api/ready`

Crew writes are server-side actor-stamped from the session; the bearer-only `/api/admin/*` path is the trusted-BFF surface for backoffice.

### backoffice-web (admin UI + BFF)

Pages (under [`app/(authed)/`](apps/backoffice-web/app)):

- `/today` — today's sales snapshot
- `/trends` — multi-period trend lines
- `/dayparts` — daypart heatmap
- `/compare` — period-over-period comparison
- `/menu` — menu engineering
- `/inventory`, `/inventory/crew` — inventory management + crew roster
- `/ops` — operational dashboards (analytics-api admin lives here)
- `/settings`, `/settings/ai` — runtime config (model id, rate limits, kill switches via `app_setting`; `/settings/system` is now just a redirect)
- `/admin/board`, `/admin/devices`, `/admin/integrations`, `/admin/reset`, `/admin/users` — KDS admin migrated from `kds-web`

BFF route handlers (under `app/api/*`) — browser never talks to `analytics-api`, `kds-api`, or `inventory-api` directly:

- `/api/auth/*` — passkey + password login wrapped on `packages/auth`
- `/api/ai/chat`, `/api/ai/sql`, `/api/ai/conversations` — AI assistant (DeepSeek backend per [ADR-0017](docs/decisions/0017-deepseek-replaces-codex.md))
- `/api/admin/*` — KDS admin proxy (board-settings, devices, daily-reset, users, integrations)
- `/api/inventory/*` — inventory proxy
- `/api/compare`, `/api/dayparts`, `/api/today`, `/api/trends`, `/api/menu` — analytics proxies hitting `analytics-api`

### analytics-api (OLAP pipeline)

- `POST /webhooks/clover` — Clover webhook receiver (verified signature, idempotent inbox queue)
- `/admin/api/*` — JSON admin endpoints consumed by the Backoffice BFF
- `/admin` — redirect to Backoffice `/ops`

Free-form SQL **must** go through [`src/analytics/safe-query.ts`](apps/analytics-api/src/analytics/safe-query.ts) (SELECT/WITH only, schema allowlist, statement timeout, audit log to `audit.ai_query_log`). Aggregates prefer `mart.sales_daily_mv` / `mart.sales_hourly_mv`, maintained by `mart-refresh-worker`.

### Static sites

- **legal-site** — `/eula`, `/privacy`, `/support`, `/` (landing). Strict CSP, `script-src 'none'`. Source: [`docs/legal/`](docs/legal/).
- **marketing-site** — single-page storefront with sections for hero, marquee, menu (Rolled Ice Cream / Bubble Tea / Smoothies), signatures, reviews, gallery, gift cards, visit info. Berry palette in [`apps/marketing-site/src/styles.css`](apps/marketing-site/src/styles.css).

---

## Environment

Master `.env.example` lives at the repo root. App-specific examples: [`apps/analytics-api/.env.example`](apps/analytics-api/.env.example), [`apps/backoffice-web/.env.example`](apps/backoffice-web/.env.example).

Common keys (set in `.env` for dev; in production, injected from Infisical at container boot via the `with-infisical` entrypoint, with secret-zero bootstrap values in each stack's host `.env`):

| Variable | Used by | Notes |
|---|---|---|
| `APP_BASE_URL`, `APP_DOMAIN` | kds-api, kds-web | Public base URL + cookie domain |
| `DATABASE_URL` | kds-api, db-kds, db-auth | KDS + auth Postgres (one physical DB, two Prisma schemas) |
| `INVENTORY_DATABASE_URL` | inventory-api, db-inventory | Separate Postgres for inventory |
| `ANALYTICS_DATABASE_URL` | analytics-api | Separate Postgres for the OLAP mart |
| `REDIS_URL` | kds-api | BullMQ + sync queue |
| `SESSION_SECRET` | kds-api, packages/auth | Cookie session signing |
| `BACKOFFICE_SESSION_COOKIE_NAME` | backoffice-web | Distinct from KDS cookie so local dev on 3000/3001 does not collide |
| `WEB_LOGIN_USERNAME`, `WEB_LOGIN_PASSWORD_HASH` | kds-api | Argon2id; generate with the snippet below |
| `WEBAUTHN_RP_ID` | kds-api, backoffice-web | Must match the browser hostname; HTTPS required in production |
| `INTERNAL_API_BASE_URL` | kds-web, backoffice-web | Backend hostname for SSR proxying |
| `INVENTORY_INTERNAL_TOKEN` | inventory-api, backoffice-web BFF | Trusted bearer for backoffice-side inventory writes |
| `CREW_SESSION_SECRET`, `CREW_PIN_PEPPER` | inventory-api, packages/auth/crew | Required in production; must match what seeded the `pin_lookup` index |
| `CLOVER_MERCHANT_ID`, `CLOVER_TOKEN` | kds-api, analytics-api | Static merchant + token (current primary integration path) |
| `CLOVER_APP_ID`, `CLOVER_APP_SECRET`, `CLOVER_WEBHOOK_AUTH_CODE` | kds-api | Optional — Clover OAuth path |
| `AI_TOKEN_ENCRYPTION_KEY` | kds-api | 32-byte hex (64 chars). At-rest encryption for POS provider tokens (Clover / Square / Deliverect) in db-kds (Phase 4.5+). Distinct from `APP_SETTING_ENCRYPTION_KEY`. |
| `APP_SETTING_ENCRYPTION_KEY` | backoffice-web | 32-byte hex (64 chars). At-rest encryption for the `app_setting` store — a **distinct** key from kds-api's. |
| `DELIVERECT_API_URL`, `DELIVERECT_WEBHOOK_SECRET`, `DELIVERECT_WEBHOOK_SIGNATURE_HEADER` | kds-api | Optional — Deliverect provider |

Generate `WEB_LOGIN_PASSWORD_HASH`:

```bash
pnpm --filter @rop/kds-api exec node --input-type=module \
  -e "import { hash, Algorithm } from '@node-rs/argon2'; console.log(await hash(process.argv[1], { algorithm: Algorithm.Argon2id }));" \
  "replace-with-your-password"
```

Runtime secrets follow a **three-layer model** ([ADR-0020](docs/decisions/0020-adopt-infisical-for-runtime-secrets.md)) — see [`OPERATIONS.md` §7 Security & Secrets](OPERATIONS.md#7-security--secrets):

- **Layer 1 — Infisical (runtime injection).** Steady-state app secrets (`CLOVER_*`, `INVENTORY_INTERNAL_TOKEN`, `CREW_*`, `ANALYTICS_ADMIN_TOKEN` / `ADMIN_TOKEN`, `REDIS_URL`, `WEB_LOGIN_PASSWORD_HASH`, `CLOVER_WEBHOOK_AUTH_CODE`, and the AES-GCM master keys `AI_TOKEN_ENCRYPTION_KEY` / `APP_SETTING_ENCRYPTION_KEY`) are pulled from Infisical and injected into the process environment by the `with-infisical` entrypoint at container start.
- **Layer 2 — `app_setting` rows.** Operator-rotatable secrets (e.g. `ai.deepseek_api_key`) live as AES-GCM-encrypted rows in the `app_setting` store, re-saved by managers at `/settings/ai` without a redeploy.
- **Layer 3 — host `.env` + 1Password (bootstrap / break-glass).** Secret-zero bootstrap values that Infisical itself cannot inject (`DATABASE_URL`, `INVENTORY_DATABASE_URL`, `SESSION_SECRET`, `KDS_INTERNAL_ADMIN_TOKEN`, the Infisical machine-identity credential + infra URLs) live in a thin gitignored per-stack host `.env` (template `.env.prod.example`), sourced from 1Password. The AES-GCM master keys `AI_TOKEN_ENCRYPTION_KEY` / `APP_SETTING_ENCRYPTION_KEY` are **Layer 1** (Infisical), not bootstrap — see OPERATIONS.md §7.1 and ADR-0020's 2026-06-18 amendment — with a 1Password break-glass copy.

CI / deploy control-plane secrets (the host SSH key, `SENTRY_AUTH_TOKEN`) remain **GitHub Actions secrets** and are out of scope of the runtime layers above. Never paste credentials into `compose/*.yml` — they are checked into git.

---

## Deployment

Production runs on a single Oracle ARM VM. Each app is a self-contained `docker compose` stack defined in [`compose/`](compose/) and deployed over SSH — there is no orchestrator or control plane (see the Dokploy-removal ADR, which supersedes ADR-0005 + ADR-0007). The nine stacks:

| Stack | File | Public host |
|---|---|---|
| KDS | [`compose/kds.yml`](compose/kds.yml) | `kds.example.com` |
| Analytics | [`compose/analytics.yml`](compose/analytics.yml) | `analytics.example.com` |
| Backoffice | [`compose/backoffice.yml`](compose/backoffice.yml) | `backoffice.example.com` |
| Inventory | [`compose/inventory.yml`](compose/inventory.yml) | internal |
| Crew | [`compose/crew.yml`](compose/crew.yml) | `crew.example.com` (floor-action UI still maturing) |
| Legal | [`compose/legal.yml`](compose/legal.yml) | `legal.example.com` |
| Marketing | [`compose/marketing.yml`](compose/marketing.yml) | `www.example.com` |
| CRM | [`compose/crm.yml`](compose/crm.yml) | `crm.example.com` (internal callers) |
| Order | [`compose/order.yml`](compose/order.yml) | `order.example.com` |

Legacy Traefik on the same host remains the public edge (DNS-01 + Cloudflare for the `*.example.com` wildcard cert); every stack's containers single-home on one shared external bridge, `rop-net`, which carries both cross-stack service DNS and ingress (Traefik discovers each routed service via a `traefik.docker.network=rop-net` label). Datastores are plain compose services with named volumes (`postgres-kds`, `redis-kds`, `postgres-analytics`, `postgres-inventory`; `postgres-crm` staged). See [ADR-0527](docs/decisions/0527-collapse-to-single-app-network.md).

### CI / CD — merge is not deploy

Code merges to `main` are AI-friendly: CI green -> AI may self-merge. **Deploys are a separate, manual step** (see [ADR-0014](docs/decisions/0014-manual-deploy-trigger.md)):

```bash
# Default: incremental — only apps changed since the last deploy rebuild.
gh workflow run build-images.yml --ref main
gh run list --workflow=build-images.yml --limit 1 --json databaseId,status,url \
  --jq '.[0] | "Run #\(.databaseId): \(.status) -> \(.url)"'
```

The dispatch builds `linux/arm64` images on a self-hosted Mac runner ([ADR-0008](docs/decisions/0008-cutover-arm64-runner-to-mac-mini.md)), pushes `ghcr.io/example-org/rop-<app>:main` (+ `:<sha>`), then SSHes to the Oracle host and runs `scripts/deploy-stack.sh <stack>` (git-sync, then `docker compose pull && up -d`). Secrets are injected at container boot from Infisical ([ADR-0020](docs/decisions/0020-adopt-infisical-for-runtime-secrets.md)) — no webhook, no control plane. The full day-2 runbook (redeploy, rollback, disaster recovery) is in [`OPERATIONS.md`](OPERATIONS.md).

---

## Architecture invariants

The repo enforces **five Iron Laws** at build time via ESLint, doc-drift scripts, and contract sync checks — see [`AGENTS.md`](AGENTS.md) and [ADR-0002](docs/decisions/0002-five-iron-laws.md):

1. **Database boundary** — each app owns its own Postgres. No cross-app DB clients.
2. **Contract boundary** — cross-app DTOs flow through `packages/contracts`. No hand-written DTOs.
3. **Auth boundary** — passkey / cookie / session logic lives in `packages/auth`.
4. **Floor vs Backoffice** — `kds-web` / `crew-web` are Floor (kitchen TVs, line cooks); `backoffice-web` is admin (owners, managers). Don't conflate.
5. **Reads are not writes** — `analytics-api` is read-only OLAP; backoffice never writes directly to either OLTP DB.

Crossing a boundary on purpose requires an ADR **and** a scoped carve-out citing it ([ADR-0011](docs/decisions/0011-ai-tables-bounded-exception.md) shows the pattern). Silent crossing fails `pnpm lint` / `pnpm docs:check`.

---

## Working docs

- [Architecture map](ARCHITECTURE.md) ([中文](ARCHITECTURE.zh-CN.md))
- [Operations + day-2 ops](OPERATIONS.md) ([中文](OPERATIONS.zh-CN.md))
- [Decision records (ADRs)](docs/decisions/)
- [Local Dev Guide](docs/LOCAL-DEV-GUIDE.md) — **start here** for local setup
- [Agent Secret Workflow](docs/agent-secret-workflow.md)
- [Web UI Testing Auth](docs/web-ui-testing-auth.md)
- [Multi-Provider KDS Roadmap](docs/multi-provider-kds-roadmap.md)
- [YRUI Design Tokens](docs/yrui-design-tokens.md) · [YRUI Component Map](docs/yrui-component-map.md)
- [Operations & deployment runbook](OPERATIONS.md)

---

## Notes

- **Multi-location is in progress** (one brand, several owner-operated stores co-managed by the owner and a partner — see [ADR-0018](docs/decisions/0018-multi-location-architecture.md)). A POS-agnostic `Location` registry sits above the Clover `merchantId`: KDS/analytics scope operational rows by `merchantId`, brand-owned data (inventory) by `locationId`. This is a multi-*location* shape, **not** multi-tenant SaaS — there is one brand, stores are its children, and cross-store visibility is intended.
- The old Clover Python scripts under the parent `Icecream/` directory are intentionally unused here.
- Static merchant token mode is the current primary Clover integration path. Save the active token in the Backoffice admin page; `.env` values are optional bootstrap/fallback. OAuth remains available.
- Production passkeys require HTTPS and a stable `WEBAUTHN_RP_ID` matching the browser hostname.
