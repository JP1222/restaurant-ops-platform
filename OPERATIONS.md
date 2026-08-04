# Example Kitchen — Operations & Deployment Guide

> 🌐 **English** · [中文](OPERATIONS.zh-CN.md)
> Last reviewed: 2026-06-04 · Authoritative for production on Oracle (ARM)

This document is the single entry point for everything operational about Example Kitchen: how the system is laid out, how to deploy it, how to keep it running, and how to recover when something breaks. Topic-specific runbooks ([`.github/OBSERVABILITY.md`](.github/OBSERVABILITY.md), [`compose/README.md`](compose/README.md)) remain canonical for their narrow domains; this file ties them together and fills gaps.

> **Deployment migrated off Dokploy + Docker Swarm.** Production now runs each app as a plain `docker compose` stack on the Oracle host, deployed over SSH (recorded in the Dokploy-removal ADR, which supersedes [ADR-0005](docs/decisions/0005-dokploy-over-coolify.md) and ADR-0007). Both the compose/CI/secret machinery and the live-host cutover (infra URLs repointed, the old Dokploy/Swarm install torn down) are complete; the steps below describe the live state.

---

## Table of Contents

1. [System Topology](#1-system-topology)
2. [First-time Production Deployment](#2-first-time-production-deployment)
3. [CI/CD Pipeline](#3-cicd-pipeline)
4. [Day-2 Operations](#4-day-2-operations)
5. [Observability](#5-observability)
6. [Troubleshooting](#6-troubleshooting)
7. [Security & Secrets](#7-security--secrets)
8. [Disaster Recovery & Backup](#8-disaster-recovery--backup)
9. [Appendix](#9-appendix)

---

## 1. System Topology

### 1.1 Bird's-eye view

```
                       Internet
                          │
              Cloudflare DNS (gray cloud, DNS only)
                          │
                    Oracle ARM VM (single node, 24 GB RAM)
                          │
        ┌─────────────────┴─────────────────────────────────┐
        │                                                   │
   Host Traefik                              Self-hosted GHA runner
   (legacy, file +                            (on the Mac Mini; builds
    docker provider)                           arm64 GHCR images, SSHes
        │                                       deploys to this host)
        │
        ├── kds.example.com ─────────► kds compose stack (rop-kds)
        │                                       ├─ postgres-kds (Postgres 16, named volume)
        │                                       ├─ redis-kds    (Redis 7, named volume)
        │                                       ├─ migrate / migrate-auth (one-shot prisma)
        │                                       ├─ kds-api  (Fastify, :4000)
        │                                       ├─ kds-worker × 2 (BullMQ)
        │                                       └─ kds-web  (Next.js, :3000)
        │
        ├── analytics.example.com ────► analytics compose stack (rop-analytics)
        │                                       ├─ postgres-analytics (Postgres 16, named volume)
        │                                       └─ analytics-api (:3100)
        │
        ├── backoffice.example.com ───► backoffice compose stack (rop-backoffice)
        │                                       └─ backoffice-web (Next.js, :3001)
        │                                          (no DB of its own — uses postgres-kds + redis-kds
        │                                           over the rop-net bridge)
        │
        ├── inventory.example.com ────► inventory compose stack (rop-inventory)
        │                                       ├─ postgres-inventory (Postgres 16, named volume)
        │                                       └─ inventory-api (:4100)
        │
        ├── crew / order / legal / marketing ► one plain compose stack each
        │                                       (crm staged — file exists, not deployed)
        │
        └── metrics.example.com ──────► Grafana (observability stack, host compose)
```

Every stack is a self-contained `compose/<stack>.yml` (the directory name is historical) brought up by plain `docker compose`. There is no control plane: the datastores are ordinary compose services with named volumes, and cross-stack DNS rides the shared external bridge `rop-net` (e.g. backoffice → `postgres-kds:5432`). The datastores publish no host ports — they're reachable only over the compose networks.

### 1.2 Service inventory

| Compose stack | Service | Image | Port | Public host | Notes |
|---|---|---|---|---|---|
| `kds` | `postgres-kds` | `postgres:16-alpine` | — (no host port) | — | Plain compose service, named volume `postgres-kds-data`. DB `rop_kds`. Reached over `rop-net`. |
| `kds` | `redis-kds` | `redis:7-alpine` | — (no host port) | — | Plain compose service, named volume `redis-kds-data`. BullMQ + sessions. |
| `kds` | `migrate` | `ghcr.io/example-org/rop-kds-api:main` | — | — | `restart: "no"`. Runs `prisma migrate deploy` (db-kds), exits. Gates kds-api/kds-worker startup. |
| `kds` | `migrate-auth` | `ghcr.io/example-org/rop-kds-api:main` | — | — | `restart: "no"`. Runs the db-auth Prisma migration (ADR-0015) against the same Postgres. Idempotent baseline. |
| `kds` | `kds-api` | `ghcr.io/example-org/rop-kds-api:main` | 4000 | `kds.example.com` (`/api`, `/ws`, `/admin`) | Fastify, Clover ingest, KDS state, WebSocket fanout. |
| `kds` | `kds-worker` | `ghcr.io/example-org/rop-kds-api:main` (same image, `node dist/worker.js`) | — | — | `replicas: 2`. BullMQ workers — Clover sync, fulfillment, daily reset. |
| `kds` | `kds-web` | `ghcr.io/example-org/rop-kds-web:main` | 3000 | `kds.example.com` (catch-all) | Next.js Floor surface — board, customer display, login. Admin pages are gone (301 → backoffice). |
| `analytics` | `postgres-analytics` | `postgres:16-alpine` | — (no host port) | — | Plain compose service, named volume `postgres-analytics-data`. DB `rop_analytics`. Own Postgres (Iron Law 1/5). |
| `analytics` | `analytics-api` | `ghcr.io/example-org/rop-analytics-api:main` | 3100 | `analytics.example.com` (`/webhooks/clover`, `/admin`) | Node http + raw SQL. Clover→Postgres OLAP mart ingest. |
| `backoffice` | `backoffice-web` | `ghcr.io/example-org/rop-backoffice-web:main` | 3001 | `backoffice.example.com` | Next.js admin shell. Sole admin surface — BFF to kds-api and analytics-api. No DB of its own; uses `postgres-kds` + `redis-kds` over `rop-net`. |
| `legal` | `legal-site` | `ghcr.io/example-org/rop-legal-site:main` | 80 | `legal.example.com` | nginx static — EULA / Privacy / Support for the Clover Marketplace listing. |
| `marketing` | `marketing-site` | `ghcr.io/example-org/rop-marketing-site:main` | 80 | `www.example.com` | nginx static — customer-facing marketing site. |
| `crew` | `crew-web` | `ghcr.io/example-org/rop-crew-web:main` | 3003 | `crew.example.com` | Next.js Floor inventory app — PIN login, waste / receive / 86 / recount; backend-wired to inventory-api via same-origin BFF. |
| `inventory` | `postgres-inventory` | `postgres:16-alpine` | — (no host port) | — | Plain compose service, named volume `postgres-inventory-data`. DB `rop_inventory`. Own Postgres (Iron Law 1). |
| `inventory` | `migrate` | `ghcr.io/example-org/rop-inventory-api:main` | — | — | `restart: "no"`. Runs `prisma migrate deploy` + `ensure-singletons.sql`, exits. Gates inventory-api startup. |
| `inventory` | `inventory-api` | `ghcr.io/example-org/rop-inventory-api:main` | 4100 | `inventory.example.com` (internal; via crew + backoffice BFF) | Fastify. Single write path for inventory — items, recipes, vendors, waste, counts, POs — plus crew PIN auth. |
| `order` | `order-web` | `ghcr.io/example-org/rop-order-web:main` | 3004 | `order.example.com` | Next.js customer ordering — menu → build a roll → Clover Hosted Checkout. BFF to kds-api `/api/order/*`. |
| `crm` | `postgres-crm` + `crm-*` | `postgres:16-alpine` + `ghcr.io/example-org/rop-crm-*:main` | 4200 (api) | — (staged) | **Staged** — `compose/crm.yml` exists with `postgres-crm` (named volume `postgres-crm-data`) but the stack is not yet deployed. |

### 1.3 Network layers

Every app container in every stack is **single-homed on one external bridge**, `rop-net` ([ADR-0527](docs/decisions/0527-collapse-to-single-app-network.md)):

| Network | Driver | Scope | Purpose |
|---|---|---|---|
| `rop-net` | bridge | `external: true` (host-created) | **Everything.** East-west DNS — intra-stack (`kds-api` ↔ `kds-worker` ↔ `postgres-kds` ↔ `redis-kds`) and cross-stack (backoffice → `postgres-kds`, inventory-api → analytics-api) — **and** ingress (the host Traefik discovers each routed service here via a per-service `traefik.docker.network=rop-net` label) |

`rop-net` replaced the old Docker Swarm `dokploy-network` overlay. It's a plain external bridge: every service joins it and resolves any peer — in its own stack or another — by compose service name (`postgres-kds:5432`, `redis-kds:6379`). There is deliberately **no** per-stack `internal` network and **no** `traefik-servicenet` membership on app containers: a container multi-homed on ≥2 shared bridges makes Docker's embedded DNS return an ambiguous IP for a peer's name (the Phase-B east-west outage that prompted [ADR-0527](docs/decisions/0527-collapse-to-single-app-network.md)), whereas single-homing every service on one bridge makes name→IP resolution unambiguous. No `--default-addr-pool` override is needed — there is no Swarm overlay pool to collide with the Oracle `10.0.0.0/8` VPC.

### 1.4 Data ownership (Iron Law #1)

Each app **owns its own Postgres database**. No cross-app DB imports.

| Database | Owner | Used by | Migration mechanism |
|---|---|---|---|
| `postgres-kds` | kds-api | kds-api, kds-worker, **backoffice-web** (shared auth store) | Prisma — `packages/db-kds/prisma/migrations/` (db-kds) + `packages/db-auth/prisma/migrations/` (db-auth, ADR-0015), applied by the `migrate` + `migrate-auth` Compose services |
| `postgres-analytics` | analytics-api | analytics-api only | Raw SQL — `apps/analytics-api/sql/migrations/`, applied at app startup |
| `postgres-inventory` | inventory-api | inventory-api only | Prisma — `packages/db-inventory/prisma/migrations/`, applied by the inventory `migrate` Compose service |

Each `postgres-*` is now a plain compose service inside its own stack with a named volume — no separate provisioning step, no control plane. backoffice-web reaches `postgres-kds` over the `rop-net` bridge (it has no datastore of its own).

Backoffice shares the KDS Postgres only because it reuses the `WebAdminAccount` + `WebAuthnCredential` tables for SSO. It never writes to KDS business tables.

### 1.5 Inter-service trust

| From → To | Auth | Env var holding the bearer |
|---|---|---|
| Backoffice → analytics-api `/admin/api/*` | `Authorization: Bearer …` | `ANALYTICS_ADMIN_TOKEN` (matches analytics-api's `ADMIN_TOKEN`) |
| Backoffice → kds-api `/api/admin/kds/*` | `Authorization: Bearer …` | `KDS_INTERNAL_ADMIN_TOKEN` (same value on both sides) |
| Clover webhooks → kds-api / analytics-api | Clover signature + `CLOVER_WEBHOOK_AUTH_CODE` | Infisical (`with-infisical`) |

If a bearer is unset, the receiving side returns `503 admin_not_configured` (fail-closed). The two tokens (`ANALYTICS_ADMIN_TOKEN`, `KDS_INTERNAL_ADMIN_TOKEN`) are independent — you can rotate one without touching the other.

---

## 2. First-time Production Deployment

This section is the path from a bare Oracle ARM VM to a working production stack. Skip to §4 for ongoing operations.

### 2.1 Prerequisites

| Requirement | Why |
|---|---|
| Oracle Cloud ARM instance (Ampere A1, 24 GB RAM, Ubuntu 24.04) | Free tier sufficient for this footprint (~6 GB working set + observability) |
| Public IP + Cloudflare DNS zone (`example.com` family) | TLS via HTTP-01 ACME challenge against the public IP |
| GitHub repo admin (Settings → Secrets and Actions) | Workflows need `ORACLE_SSH_*` and `SLACK_*` secrets |
| `docker`, `docker compose`, `git` on host | The deploy script and every stack run as plain `docker compose` |
| A checkout of the repo at `~/restaurant-ops-platform` on the host | `scripts/deploy-stack.sh` git-syncs it to `origin/main` and runs compose from there |
| 1 × deploy SSH key (host) + 1 × superuser SSH key (operator) | The GHA runner SSHes in with the deploy key; the operator key is for break-glass |
| An Infisical machine identity ("secret zero") | `with-infisical` uses it to fetch runtime secrets at container boot (ADR-0020) |

### 2.2 Prepare the host

There is no control plane to install. The host needs Docker, a repo checkout, and the external `rop-net` bridge network (created in §2.4).

```bash
# On Oracle host, one-time. (Docker Engine + compose plugin via the official
# convenience script, or apt; then clone the repo to the canonical path.)
git clone https://github.com/example-org/restaurant-ops-platform.git ~/restaurant-ops-platform
```

`scripts/deploy-stack.sh` always `git fetch`es and hard-resets this checkout to `origin/main` before running compose, so the working tree just needs to exist and track the right remote. Gitignored `compose/*.env` files survive the reset.

### 2.3 Legacy host Traefik

restaurant-ops-platform runs Traefik on the host via `host` network mode (unchanged by the Dokploy removal). Each routed compose service advertises itself with `traefik.*` labels and pins `traefik.docker.network=rop-net`, so Traefik resolves the backend on the flat `rop-net` bridge — which it reaches from the host routing table — instead of on its provider-default network ([ADR-0527](docs/decisions/0527-collapse-to-single-app-network.md)). TLS and routing are untouched.

Required Traefik static config (`/etc/traefik/traefik.yml` on host):

```yaml
providers:
  docker:
    # Traefik's provider-default network; each routed stack overrides it
    # per-service with a traefik.docker.network=rop-net label (ADR-0527).
    network: traefik-servicenet
    exposedByDefault: false
  file:
    directory: /etc/traefik/dynamic
    watch: true

certificatesResolvers:
  production:
    acme:
      email: ops@example.com
      storage: /etc/traefik/acme.json
      httpChallenge:
        entryPoint: web
```

For the Clover webhook fan-out (one request mirrored to both kds-api and analytics-api), drop [`infrastructure/traefik/dynamic/clover-webhook-fanout.yml`](infrastructure/traefik/dynamic/clover-webhook-fanout.yml) into `/etc/traefik/dynamic/`. Traefik hot-reloads.

Verify: `curl -s http://127.0.0.1:8080/api/http/routers | jq '.[].name'` lists the expected routers after the first compose deploy.

### 2.4 Create the external Docker network

The single flat app bridge `rop-net` must exist *before* any compose stack comes up — every service single-homes on it ([ADR-0527](docs/decisions/0527-collapse-to-single-app-network.md)). The legacy host Traefik's own `traefik-servicenet` network (§2.3) is separate and already exists; the app stacks neither create nor join it.

```bash
docker network create --driver bridge rop-net
docker network ls --filter name=rop-net
```

### 2.5 Configure Cloudflare DNS

A-records for each public surface, **DNS only (gray cloud)** to the Oracle public IP:

```
kds.example.com         A  <oracle-ip>   DNS only
analytics.example.com   A  <oracle-ip>   DNS only
backoffice.example.com  A  <oracle-ip>   DNS only
inventory.example.com   A  <oracle-ip>   DNS only
crew.example.com        A  <oracle-ip>   DNS only
order.example.com       A  <oracle-ip>   DNS only
legal.example.com       A  <oracle-ip>   DNS only
www.example.com         A  <oracle-ip>   DNS only
metrics.example.com     A  <oracle-ip>   DNS only
```

Gray cloud is intentional — HTTP-01 ACME needs a direct connection. Once production passes a stress test, you can flip to proxied (orange cloud) and switch to DNS-01 with a CF API token, but it's not required.

### 2.6 Datastores: no separate provisioning step

There are no externally-managed Postgres/Redis resources anymore. Each datastore is a plain compose service declared inside its own stack file with a named volume:

| Stack | Datastore services | Named volumes |
|---|---|---|
| `kds` | `postgres-kds`, `redis-kds` | `postgres-kds-data`, `redis-kds-data` |
| `analytics` | `postgres-analytics` | `postgres-analytics-data` |
| `inventory` | `postgres-inventory` | `postgres-inventory-data` |
| `crm` (staged) | `postgres-crm` | `postgres-crm-data` |

`backoffice` has no datastore of its own — it joins `rop-net` and reaches `postgres-kds` + `redis-kds` by service name. The volumes are created on first `docker compose up`; nothing to provision ahead of time.

### 2.7 Per-stack host env files

Each stack is brought up with its own thin, **gitignored** env file, `compose/<stack>.env`. The committed template is [`.env.prod.example`](.env.prod.example) — copy each section into a separate real file per stack (one shared file does **not** work: `DATABASE_URL` / `SESSION_SECRET` mean different things in the kds vs backoffice stacks).

These files carry only the irreducible host-side bootstrap, **not** application secrets:

- **Infisical secret-zero** — `INFISICAL_MACHINE_CLIENT_ID` / `INFISICAL_MACHINE_CLIENT_SECRET` (Universal Auth machine identity). This is the one real credential on the host; `with-infisical` uses it to fetch everything else at container boot.
- **Local datastore credential** — `POSTGRES_PASSWORD` (fresh volume; not network-exposed).
- **Infra URLs pointing at local compose DNS** — e.g. `DATABASE_URL=postgresql://postgres:postgres@postgres-kds:5432/rop_kds`, `REDIS_URL=redis://redis-kds:6379`, `INVENTORY_DATABASE_URL=…@postgres-inventory:5432/rop_inventory`.
- **Non-secret config** the app reads directly (e.g. `APP_BASE_URL`, `WEBAUTHN_RP_ID`, `CLOVER_REGION`).

> ⚠️ **Infisical override rule.** The `with-infisical` entrypoint **overrides** same-named process env at boot. So any infra URL you set in the host env file that *also* exists in the Infisical `prod` scope gets replaced by the Infisical value. Because the URLs above now point at the **local** compose DNS, a stale overlay-DNS value left in Infisical (e.g. `postgres-kds-<suffix>`) would win and the container could not reach its database. Keep the infra URLs in the host `.env` file and **out of Infisical** (or repoint them in Infisical to the local DNS). The recommended posture is: infra URLs live only in the host `.env`.

Everything else — `SESSION_SECRET`, `CLOVER_*`, the `*_ADMIN` / `*_INTERNAL` tokens, `CREW_*`, `APP_SETTING_ENCRYPTION_KEY`, `AI_TOKEN_ENCRYPTION_KEY`, `DEEPSEEK_API_KEY`, … — is injected by `with-infisical` from the Infisical `prod` scope (ADR-0020). See §7.1 for the full secret model.

`compose/<stack>.yml` declares every var with a `${VAR:-default}` form, so a stack still boots (with empty/no-op values) before Infisical is wired. The `validate-compose.yml` CI check runs `docker compose config` to catch structural breakage; there is no longer an env-drift validator against any external store.

### 2.8 Configure GitHub Actions secrets

Repo → Settings → Secrets and variables → Actions. The deploy path needs just two host secrets plus the notification webhook:

| Secret | Used by | Value |
|---|---|---|
| `ORACLE_SSH_KEY` | `build-images.yml` (deploy step) | Private SSH key whose public half is in the host's `~/.ssh/authorized_keys`. The runner SSHes in and runs `scripts/deploy-stack.sh`. |
| `ORACLE_SSH_HOST` | `build-images.yml` (deploy step) | `user@203.0.113.10` (the Oracle host). |
| `SENTRY_AUTH_TOKEN`, `SENTRY_ORG` | `build-images.yml` (source-map / release upload at image build) | From Sentry. |
| `DOCKERHUB_USERNAME`, `DOCKERHUB_TOKEN` | `build-images.yml` (base-image pull auth) | Docker Hub username + a **read-only access token** (Hub → Account settings → Personal access tokens). Authenticates `node:` / `nginx:` base-image pulls so the shared runner IP doesn't hit Docker Hub's anonymous pull cap (100/6h → 429, which fails every build). Optional but strongly recommended; the build step skips the login when unset. |
| `SLACK_WEBHOOK_URL` | `slack-notify.yml` | Slack → api.slack.com/apps → create app → Incoming Webhooks → Add New Webhook to Workspace → pick channel → copy URL |
| `AI_PRICES_REFRESH_TOKEN` *(optional)* | `ai-prices-refresh.yml` (weekly cron) | A random shared token, e.g. `openssl rand -hex 32`. Enables the weekly refresh of the AI model price table (Settings → AI "Usage & cost") without a deploy. **Two-sided + dormant until both set:** the same value must ALSO be the backoffice container env `AI_PRICES_REFRESH_TOKEN` (Infisical `prod`) so `POST /api/ai/prices/refresh` accepts the cron's bearer token. With the GitHub secret unset the cron skips (exit 0); with the backoffice env unset the endpoint's token branch is off. The manual Settings button works regardless. |

The `ORACLE_SSH_KEY` / `ORACLE_SSH_HOST` pair **replaced** the old Dokploy control-plane secrets (`DOKPLOY_API_KEY`, every `DOKPLOY_*_COMPOSE_ID`, every `DOKPLOY_WEBHOOK_*`) — those are deleted.

GitHub Actions does not read 1Password directly. These repo secrets are a
GitHub-side mirror, refreshed from a local 1Password-authenticated shell with
`op run --env-file=.env.tpl -- scripts/sync-github-secrets-from-agent-env.sh`.
During a job, GitHub Actions injects the repo secret into the runner
environment. The Mac Mini runner executes the job; it is not the secret source.

### 2.9 Provision the self-hosted Mac Mini runner

The active CI/build runner pool is the Mac Mini, not Oracle. Required labels:
`self-hosted`, `mac` (and `macmini`). The older Oracle runner labels were retired so CI
cannot accidentally run heavy builds on the production host. The runner needs SSH
reachability to the Oracle host (it runs the deploy step), plus `docker buildx`
for arm64 image builds.

### 2.10 First deploy

```bash
# Manual-only (ADR-0014). Build every app and deploy each stack:
gh workflow run build-images.yml --ref main --field force_all=true
```

`force_all=true` ignores the incremental paths-filter and builds every app in
the matrix. Watch in the GitHub Actions UI; expect ~5–10 min for the slowest app
on a cold cache. Each build job pushes `:main` + `:<sha>` to GHCR, then the deploy
step SSHes to the host and runs `scripts/deploy-stack.sh <stack>` — which git-syncs
the host checkout to `origin/main` and runs `docker compose -f compose/<stack>.yml [--env-file compose/<stack>.env] pull && up -d`.

You can also bring any stack up by hand on the host before/after the first CI run:

```bash
bash ~/restaurant-ops-platform/scripts/deploy-stack.sh kds
```

### 2.11 Smoke tests

```bash
# Health endpoints (TLS via Traefik)
curl -fs https://kds.example.com/api/health
curl -fs https://analytics.example.com/healthz
curl -fs https://backoffice.example.com/

# Login surfaces (should return HTML, not 5xx)
curl -fsI https://kds.example.com/login | head -1
curl -fsI https://backoffice.example.com/login | head -1
```

Then create the first admin user via `/admin/integrations/clover` on backoffice (passkey-only by default; generate a password hash with `pnpm --filter @rop/kds-api exec node …` per the [`README.md`](README.md) snippet if you want a fallback).

---

## 3. CI/CD Pipeline

### 3.1 Workflow overview

The operational workflows live in `.github/workflows/`:

| Workflow | Trigger | Purpose |
|---|---|---|
| `ci.yml` | PR + manual dispatch (no push:main — see the workflow header for why) | lint, build, unit tests, E2E (Playwright on ephemeral Postgres + Redis) |
| `validate-compose.yml` | PR touching `compose/**` + manual dispatch | Runs `docker compose config` on every stack file — structural validation (bad YAML, undefined network/volume). No Dokploy, no secrets. |
| `build-images.yml` | **manual dispatch only** (ADR-0014) | Build per-app Docker images on the self-hosted **Mac Mini** arm64 runner, push `:main` + `:<sha>` to GHCR, then SSH to the host and run `scripts/deploy-stack.sh <stack>` for each built app |
| `ghcr-cleanup.yml` | weekly cron | Prune old GHCR image tags; keep `main`, `latest`, and the last 5 SHA tags per app |
| `runner-maintenance.yml` | weekly cron + dispatch | `pnpm store prune` on the self-hosted runner — GC the host pnpm store (the one cache with no built-in eviction) |
| `slack-notify.yml` | `workflow_run` of any of the above (failure only) | Post a Slack message when a watched workflow fails |
| `claude-review.yml` | PR | Claude-assisted review (separate from ops) |

The old `sync-compose-to-dokploy.yml` is **deleted** — there is no external store to push YAML to; the host reads `compose/*.yml` straight from its `origin/main` checkout at deploy time.

### 3.2 `ci.yml` — the merge gate

These jobs run on PRs (and manual `workflow_dispatch`; push:main was dropped so a merge doesn't contend with the manual deploy for the 2-runner self-hosted pool — see the `ci.yml` header). A separate `validate-compose.yml` runs on compose-file changes (see §3.1):

1. **`ci` (Lint, build, test)** — runs `pnpm lint && pnpm build && pnpm test && pnpm docs:check` (unit suites across analytics-api, auth, kds-api, kds-web, backoffice). Order matters because `pnpm lint` depends on `db:generate` + workspace package builds. **Required check.**
2. **`e2e` (E2E)** — Playwright Chromium suite for `kds-web` (4 specs) and `backoffice-web` (2 specs), all API-stubbed (no Postgres/Redis — migration validation moved to `migration-smoke`). Failure uploads `playwright-report/` + `test-results/` as 7-day artifacts. **Required check.**
3. **`migration-smoke`** — only when Prisma schemas change: applies db-kds + db-auth + db-inventory migrations against an ephemeral Postgres and verifies `migrate status`. Path-gated, not a required check.

Image builds are **not** validated at PR time (the per-PR `docker-build` matrix from ADR-0036 was removed — see that ADR's 2026-06-05 note). A broken Dockerfile surfaces when `build-images.yml` builds at deploy (it fails loudly and Slack-alerts). To validate image builds without deploying, dispatch `build-images.yml` with `skip_deploy=true`.

### 3.3 End-to-end build → deploy flow

```
You run `gh workflow run build-images.yml --ref main` (manual; ADR-0014)
        │
        ▼
┌────────────────────────────────────────────────────────────────┐
│  GitHub Actions control plane                                   │
│  ─ schedules jobs and injects repo secrets                      │
│  ─ does not read 1Password                                      │
└────────────────────────────────────────────────────────────────┘
        │ jobs dispatched to self-hosted runner
        ▼
┌────────────────────────────────────────────────────────────────┐
│  Mac Mini M4 — 2 self-hosted runners                            │
│  ─ ci.yml — lint / build / test                                 │
│  ─ build-images.yml `setup` — last-built marker → JSON matrix   │
│  ─ build-images.yml `build` job, runs-on [self-hosted, mac]     │
│      docker buildx build --platform linux/arm64                 │
│      → ghcr.io/example-org/rop-<app>:main + :<sha>            │
│  ─ buildx local cache: ~/buildx-cache/<app>/                    │
│  ─ build-images.yml `deploy` step — ssh -i $ORACLE_SSH_KEY      │
│      $ORACLE_SSH_HOST 'bash ~/restaurant-ops-platform/scripts/deploy-stack.sh <stack>' │
└────────────────────────────────────────────────────────────────┘
        │ SSH (per built stack)
        ▼
┌────────────────────────────────────────────────────────────────┐
│  Oracle Ampere A1 — plain docker compose + host Traefik         │
│  ─ deploy-stack.sh: git reset --hard origin/main, then          │
│    docker compose -f compose/<stack>.yml \              │
│      [--env-file compose/<stack>.env] pull && up -d     │
│  ─ Stacks: kds, analytics, backoffice, inventory, crew,         │
│    order, legal, marketing  (crm: staged, not deployed)         │
│  ─ Observability stack: independent host docker compose         │
└────────────────────────────────────────────────────────────────┘
        │
        ▼
   Any failure → Slack (slack-notify.yml)
```

The `build` job uses `runs-on: [self-hosted, mac]` and runs in parallel across the matrix (one job per app to build). Each job's deploy step SSHes to the host and runs `scripts/deploy-stack.sh <stack>`; `ssh`'s exit code is the remote script's exit code, so a failed `docker compose up` fails the job loudly and Slack notifies. The image is always pushed to GHCR before the deploy step, so a deploy failure leaves a recoverable image behind.

**Incremental vs full.** The `setup` job decides what to build by diffing `HEAD` against the `last-built` marker — the `.last-built` file on the orphan `deploy-state` branch, advanced automatically by the `advance-marker` job after every successful dispatch. Only apps whose paths changed since the last deploy get rebuilt; batched PRs since the last deploy are all picked up. `--field force_all=true` skips the marker and builds everything; `--field skip_deploy=true` builds without deploying (smoke-test mode that does not touch production). If the marker is missing or stale (first-ever deploy, or `main` was rewritten), the workflow warns and falls back to force_all semantics.

Per-app trigger mapping (a matching change since the marker rebuilds that app):

| App | Triggers |
|---|---|
| `kds-api` | `apps/kds-api/**`, `packages/{db-kds,db-auth,contracts,auth}/**`, root configs |
| `kds-web` | `apps/kds-web/**`, `packages/{contracts,auth}/**`, root configs |
| `analytics-api` | `apps/analytics-api/**`, root configs |
| `backoffice-web` | `apps/backoffice-web/**`, `packages/{auth,db-kds,contracts}/**`, root configs |
| `inventory-api` | `apps/inventory-api/**`, `packages/{db-inventory,contracts}/**`, root configs |
| `crew-web` | `apps/crew-web/**`, root configs |
| `order-web` | `apps/order-web/**`, root configs |
| `legal-site` | `apps/legal-site/**`, `docs/legal/**` |
| `marketing-site` | `apps/marketing-site/**` |

### 3.4 Host redeploy flow (`scripts/deploy-stack.sh`)

For each built app, the deploy step SSHes to the host and runs [`scripts/deploy-stack.sh`](scripts/deploy-stack.sh) `<stack>`. The script:
1. Takes a global flock (`/tmp/rop-deploy.lock`) so two matrix jobs targeting the same stack (e.g. kds-api + kds-web → `kds`) serialize.
2. `git fetch origin main` + `git reset --hard origin/main` on the `~/restaurant-ops-platform` checkout, so the compose file and the script itself match `main`. Gitignored `compose/*.env` files survive the reset. (If the host can't fetch, it deploys the current checkout and warns.)
3. Runs `docker compose -f compose/<stack>.yml [--env-file compose/<stack>.env] pull` against GHCR (only the changed layer pulls; previous layers are cached on the host docker daemon).
4. Runs `docker compose … up -d --remove-orphans` with dependency ordering. For kds: `postgres-kds` + `redis-kds` become healthy, then `migrate` + `migrate-auth` run to exit 0, then `kds-api` + `kds-worker` + `kds-web` start. Each app sets `pull_policy: always` so a bare `up -d` on the host also picks up the latest `:main` (a release's bundled schema migrations are never skipped by a stale local image).

A container that fails its healthcheck within `start_period + interval × retries` (kds-api: 10 + 5 × 6 = 40 s) is reported unhealthy; `restart: unless-stopped` keeps it cycling. There is no automatic rollback — see §4.7.

### 3.5 Editing compose files

There is no separate sync step. Edit `compose/<name>.yml` in a branch, open a PR (`validate-compose.yml` runs `docker compose config`), merge to main. The change reaches production the next time `build-images.yml` deploys that stack — `deploy-stack.sh` git-syncs the host checkout to `origin/main`, so it always runs the merged YAML. A compose-only change with no image rebuild still needs a manual `build-images.yml` dispatch (or a hand-run of `deploy-stack.sh` on the host) to take effect.

### 3.6 Branch protection

Set up per [`.github/BRANCH_PROTECTION.md`](.github/BRANCH_PROTECTION.md). Required status checks: `Lint, build, test` and `E2E + migrations`. `Validate compose stacks` (the `docker compose config` check) runs on compose-file changes.

---

## 4. Day-2 Operations

### 4.1 Deploy new code

**Deploy is manual-only** (ADR-0014) — merging to `main` does **not** roll production. When you're ready to ship:

```bash
# Incremental (default): only apps changed since the last deploy.
gh workflow run build-images.yml --ref main

# Surface the run URL (don't block on it):
sleep 5
gh run list --workflow=build-images.yml --limit 1 \
  --json databaseId,status,url --jq '.[0] | "Run #\(.databaseId): \(.status) → \(.url)"'
```

Always use `--ref main` even from a worktree or feature branch — the deploy source-of-truth is `main`. See the root [`AGENTS.md`](AGENTS.md) "Deploy is user-gated" section for the full rules (never trigger unprompted; don't auto-retry on failure).

**Live status while it runs**: open https://backoffice.example.com/ops — the **Pipeline** tab shows the in-flight deploy in real time (service health strip, 5-stage flowchart, recent runs, GHCR image freshness). Requires `GITHUB_PIPELINE_TOKEN` in the backoffice env (PAT scopes: `actions:read`, `read:packages`); without it the service-health portion still works.

**Force rebuild + redeploy everything** (e.g. suspected corrupt buildx cache, or the `deploy-state` marker was lost): `gh workflow run build-images.yml --ref main --field force_all=true`. Pass `--field skip_deploy=true` to build-only (smoke-test mode that does not affect production).

**Deploy a single stack by hand on the host** (no CI):
```bash
bash ~/restaurant-ops-platform/scripts/deploy-stack.sh kds   # git-syncs to origin/main, then pull + up -d
```

### 4.2 Edit a Compose YAML

1. Edit `compose/<name>.yml` in a branch.
2. Open PR. `validate-compose.yml` runs `docker compose config` on every stack.
3. Merge to main.
4. The change reaches production on the next `build-images.yml` deploy of that stack (`deploy-stack.sh` git-syncs the host to `origin/main`). A compose-only change with no image rebuild needs a manual dispatch (or a hand-run of `deploy-stack.sh`) to take effect.

### 4.3 Edit env / secrets

Almost everything is an Infisical secret now — change it in the Infisical `prod` scope, then restart the consuming stack so `with-infisical` re-injects it (§4.5). The only values in the per-stack host file `compose/<stack>.env` are the Infisical secret-zero, `POSTGRES_PASSWORD`, the local-DNS infra URLs, and non-secret config (§2.7).

To change a host `.env` value:
```bash
ssh oracle
cd ~/restaurant-ops-platform
$EDITOR compose/kds.env          # gitignored; survives deploy-stack.sh git reset
bash scripts/deploy-stack.sh kds         # re-up the stack to pick it up
```

> ⚠️ **Infisical override rule** (§2.7): if a var you set in the host `.env` also lives in Infisical `prod`, the Infisical value wins at boot. Keep the infra URLs out of Infisical (or repoint them there to the local compose DNS).

### 4.4 View logs

| Method | Use when |
|---|---|
| `ssh oracle 'docker logs -f --tail 100 <container>'` | Long tail, grep, structured analysis |
| `ssh oracle 'docker compose -f compose/<stack>.yml logs -f <service>'` | All replicas of a service at once, by compose service name |
| Grafana → Explore → Loki: `{container="..."}` | Historical search, cross-container correlation |

Container names are now predictable plain-compose names — `rop-<stack>-<service>-<n>`, e.g. `rop-kds-kds-api-1`, `rop-kds-postgres-kds-1`. No more Dokploy auto-suffix.
```bash
ssh oracle "docker ps --filter 'label=com.docker.compose.project=rop-kds' --format '{{.Names}}'"
```

### 4.5 Restart / shell into a service

| Action | Command (on the host, from `~/restaurant-ops-platform`) |
|---|---|
| Restart one service | `docker compose -f compose/<stack>.yml restart <service>` |
| Restart whole stack | `docker compose -f compose/<stack>.yml [--env-file compose/<stack>.env] up -d` |
| Re-inject Infisical secrets | Restart the stack (above) — `with-infisical` re-fetches at boot |
| Shell | `docker exec -it <container> sh` |
| Exec one-off | `docker exec <container> <cmd>` (e.g. `psql`, `redis-cli`) |

### 4.6 Migrations

Prisma migrations run automatically on every kds stack deploy — the `migrate` (db-kds) and `migrate-auth` (db-auth, ADR-0015) services have `restart: "no"`, run `prisma migrate deploy`, and gate `kds-api` / `kds-worker` startup via `service_completed_successfully`. Both set `pull_policy: always`, so a release's bundled migrations are applied even on a bare `docker compose up -d`.

To check migration status without redeploying:
```bash
ssh oracle "docker exec rop-kds-kds-api-1 node_modules/.pnpm/node_modules/.bin/prisma migrate status --schema node_modules/@rop/db-kds/prisma/schema.prisma"
```

inventory-api migrations run the same way via its own `migrate` service. analytics-api migrations are raw SQL (`apps/analytics-api/sql/migrations/`) applied at app startup by the service itself — no separate runner. Order of files matters; never re-number or delete them in place.

### 4.7 Manual rollback

There is no automatic rollback — a bad image just cycles on its restart policy. Roll back on the host with plain compose:

```bash
ssh oracle
cd ~/restaurant-ops-platform

# 1. Find a known-good image SHA (GHCR keeps :<sha> tags ~90 days)
git log --oneline main

# 2a. If only the image is bad — pin the previous SHA for that one service
#     without editing main. Override on the host with an extra compose file:
cat > /tmp/kds-pin.yml <<'YAML'
services:
  kds-api:
    image: ghcr.io/example-org/rop-kds-api:<good-sha>
  kds-worker:
    image: ghcr.io/example-org/rop-kds-api:<good-sha>
YAML
docker compose -f compose/kds.yml --env-file compose/kds.env \
  -f /tmp/kds-pin.yml up -d
#     (Or, for a durable pin, change the `image:` tag in compose/kds.yml
#      on a branch, merge, and redeploy — deploy-stack.sh will git-sync it.)

# 2b. If the merged YAML itself is bad — check the host checkout out to the
#     last good commit and re-up (the next CI deploy will reset it to main):
git fetch origin main
git checkout <good-sha> -- compose/kds.yml
docker compose -f compose/kds.yml --env-file compose/kds.env up -d
```

The cleanest durable fix is always: revert on `main`, then `gh workflow run build-images.yml --ref main` so the host re-syncs to a good `origin/main`.

### 4.8 Batch / hold deploys

Because deploy is manual-only, "pausing" is the default — merging to `main` never rolls production on its own. To batch several merged PRs into one deploy, just wait and run a single incremental dispatch when ready; the `last-built` marker means that one dispatch picks up every app changed since the previous deploy:

```bash
gh workflow run build-images.yml --ref main
```

For a build-only smoke test that does not touch production:

```bash
gh workflow run build-images.yml --ref main --field force_all=true --field skip_deploy=true
```

### 4.9 Onboard a second store (multi-location)

Example Kitchen is multi-**location** (one brand, N stores — see [docs/multi-location.md](docs/multi-location.md)), not multi-tenant SaaS. Most of onboarding is now self-serve in Backoffice; one step (analytics sync) is still a manual operator action until its auto-provision lands.

1. **Connect the store's POS.**
   - *Clover:* run the per-merchant OAuth install for the new location. It creates a new `CloverMerchant` row (the generic store-account table) with **no** Location binding yet.
   - *Non-Clover ([ADR-0019](docs/decisions/0019-decouple-store-identity-from-clover.md)):* upsert a store-account row with a synthetic id and keep the provider creds in `KdsProviderConfig`.
2. **Create + bind the store** — Backoffice → Locations (ADMIN). Both steps are self-serve:
   - **Add store** — set the name and the **timezone** (this frames the store's day boundaries; set it correctly).
   - **Connect POS** — pick the unbound store-account from step 1. This sets `CloverMerchant.locationId`, so the store appears in the **Store Switcher** and scopes analytics + inventory. A store with no POS binding deliberately shows "no data" rather than another store's numbers.
3. **Register the analytics sync target — _manual until auto-provision lands_.** `POST { merchant_id, token, store_timezone, active: true }` to analytics-api's `/admin/api/sync-targets` (bearer `ANALYTICS_ADMIN_TOKEN`). The OAuth `token` lives in kds-api's `clover_merchants.access_token`; **never log it**, and use the **same timezone** as step 2 (the two TZ sources must agree). The registry hot-reloads within ~30s — no redeploy. Without this, the store's sales never ingest.
4. **Seed the store's crew** — Backoffice → Crew, **with the new store selected in the Store Switcher**. Each hire is filed under the active store automatically, so their PIN session (and every waste / receive / count they record) auto-scopes to it. Self-serve; no DB step.
5. **Pair each KDS screen** — `POST /api/kds/devices` with the store's `merchantId`. Each screen then resolves its own store from its device token (no `?merchantId=` needed).
6. **Verify** — switch to the new store in the Store Switcher: inventory manages its own stock, the crew roster shows only that store's hires, and once the sync ingests, analytics + the Today/intraday pages show its numbers framed in its own timezone.

**Non-Clover store scope ([ADR-0019](docs/decisions/0019-decouple-store-identity-from-clover.md)).** The store-account row, KDS order ingestion (provider-neutral `KdsProviderEvent` + a per-provider `normalize*Order`), inventory, and crew are POS-agnostic, so a non-Clover store can run **KDS + inventory + crew** today (its store-account needs a placeholder `accessToken` — the Deliverect `"<provider>:webhook"` pattern). Still **Clover-coupled** until that provider's adapters land: the **menu** source, **analytics** ingest, and **online-ordering payment**. So a non-Clover store #2 launches KDS-first; menu / analytics / online ordering follow per-provider.

**Known limitations (until the remaining multi-store work lands):**

- **"All stores"** in the switcher shows the env-default store's numbers, not a consolidated total.
- **Online ordering for store #2 is not live yet.** The kds-api order path is now store-aware — it routes menu / pricing / order to the selected store and **fail-closed-refuses** payment for any store that isn't the configured Clover Ecommerce merchant — but the customer order-web app doesn't yet send a store, and per-store payment config (runtime Clover keys) is pending. Leave store #2 online ordering off until both land.
- **Analytics day-bucketing is per-store-correct** (analytics-api buckets each store's sales in its own timezone; Today + intraday verified). The only Central-framed remnant is the **client-side default date range** on a few analytics pages — cosmetic, operator-adjustable.

---

## 5. Observability

Authoritative: [`.github/OBSERVABILITY.md`](.github/OBSERVABILITY.md). This section is a quick orientation + daily-use cheatsheet.

### 5.1 Stack

App-side error tracking goes to **Sentry SaaS** (`https://sentry.io/organizations/example-org`, org `restaurant-ops-platform`, 5 projects), not a self-hosted endpoint. The self-hosted observability stack covers metrics + logs:

| URL | Tool | Stores | Auth |
|---|---|---|---|
| `https://metrics.example.com` | Grafana | Metrics + log dashboards | `admin` / `GRAFANA_ADMIN_PASSWORD` |
| (internal only) | Prometheus | Time-series metrics | Proxied via Grafana |
| (internal only) | Loki | Container stdout/stderr | Proxied via Grafana |

Deploy:
```bash
ssh oracle
cd ~/restaurant-ops-platform
cp .env.observability.example .env.observability
# Fill in GRAFANA_ADMIN_PASSWORD

COMPOSE_PROJECT_NAME=rop-observability \
  docker compose --env-file .env.observability \
  -f docker-compose.observability.yml up -d --build
```

`docker-compose.observability.yml` runs as its own host compose stack (`COMPOSE_PROJECT_NAME=rop-observability`), separate from the app stacks and not part of the `build-images.yml` deploy matrix — it's deployed and updated by hand on the host.

### 5.2 Where to look when something's wrong

| Symptom | First stop |
|---|---|
| Unexplained 5xx in any app | **Sentry** (sentry.io, org `restaurant-ops-platform`) — should already have the stack trace via Sentry SDK |
| App slow, no errors thrown | **Grafana → Explore → Prometheus** — check `up`, queue depth |
| "What did X log around 14:32?" | **Grafana → Explore → Loki** — `{container="rop-kds-kds-api-1"} \|= "ERROR"` |
| Deploy itself failing | **GitHub Actions** — `build-images.yml` or `slack-notify.yml` alert |
| Business signal red (Clover 401, sync failure rate, heartbeat lag) | `scripts/check-business-health.sh` cron — see §5.4 |

### 5.3 Common Loki queries

Container names follow the plain-compose pattern `rop-<stack>-<service>-<n>`:

```logql
{container=~"rop-kds-kds-api-.*"} |= "ERROR"
{container="rop-analytics-analytics-api-1"} |~ "(?i)clover.*401"
{container=~"rop-.*"} |= "FATAL" | json
sum(rate({container=~"rop-.*"} |= "ERROR" [5m])) by (container)
```

### 5.4 Business health alerts

[`scripts/check-business-health.sh`](scripts/check-business-health.sh) runs on a 15-min cron and emails when:
1. `audit.sync_runs` failure rate > `SYNC_FAILURE_THRESHOLD_PCT` (default 50%) in last `SYNC_FAILURE_WINDOW_MIN` (30 min).
2. `audit.service_heartbeats` lag > `HEARTBEAT_LAG_MAX_MIN` (5 min) for any of 9 worker subsystems.
3. Clover 401 count > `CLOVER_401_THRESHOLD` (1) in last `CLOVER_LOG_WINDOW_MIN` (60 min).

Install:
```bash
crontab -e
*/15 * * * * $HOME/restaurant-ops-platform/scripts/check-business-health.sh >/dev/null 2>&1
```

Suppression: same fingerprint won't re-alert for `SUPPRESS_WINDOW_SEC` (default 1 h). Override with `--force`.

This script exists because **process healthchecks alone are insufficient** — historically Clover 401 ran silently for 24+ h while `/healthz` returned 200.

### 5.5 Disk & retention

Volumes under `rop-observability_*`:
- `prometheus-data` — ~50 MB/day (30-day retention)
- `loki-data` — ~100–500 MB/day

Check: `docker system df -v | grep observability`.
Tune retention: `PROMETHEUS_RETENTION` env var; Loki has its own config.

### 5.6 Sales-driven inventory depletion cron

[`scripts/sync-sales-cron.sh`](scripts/sync-sales-cron.sh) runs on a 15-min cron and triggers `POST /api/inventory/sync-sales`, depleting theoretical on-hand as items sell (ADR-0028). It follows the same host-cron + Infisical pattern as the backup (§8.1): it sources the machine identity from a stack env file, points `with-infisical` at the inventory secrets (env=prod, path=`/`), and runs [`scripts/sync-sales.sh`](scripts/sync-sales.sh), which calls the endpoint **from inside the inventory-api container** (localhost:4100) so it reuses the app's Infisical-injected `ANALYTICS_ADMIN_TOKEN` (to read the analytics sold-items feed) — the inventory DB + analytics feed are host-internal, with no public route.

Install:
```bash
crontab -e
*/15 * * * * $HOME/restaurant-ops-platform/scripts/sync-sales-cron.sh >> $HOME/sync-sales.log 2>&1
```

- **Idempotent + self-healing.** `runDepletionPoll` dedups per Clover line item and only advances the `inventory_depletion_cursor` watermark on success, so a slow or failed run is harmless — the next run retries from the same point.
- **Prerequisites (one-time, done 2026-06-16):** recipe BOMs must exist (else every sold item is unmatched and nothing depletes), a physical count must seed `on_hand` (else it drifts negative from zero), and the `fact_line_items_merchant_created_idx` index (migration `026`) must be present (else the feed query times out — see docs/inventory-bom-bootstrap-handoff.md).
- **Check it's running:** `tail ~/sync-sales.log` (each line shows status + `applied`/`skipped` counts). 503 = analytics feed env unset; 502 = `ANALYTICS_ADMIN_TOKEN` rejected; 500 = feed timeout (check the index).

### 5.7 Open Food Facts auto-fill (scan-to-register)

Backoffice scan-to-register (barcode-onboarding ADR, D3) pre-fills a scanned UPC's name/category/unit from the **free Open Food Facts (OFF) public API** (`world.openfoodfacts.org` — no key, no cost). **Nothing to install or maintain on the host:** `inventory-api` calls the API directly. (The owner approved this egress 2026-06-20 over self-hosting a multi-GB SQLite copy — a scanned UPC is a public product barcode, not sensitive data.)

- **On by default.** `config.ts` defaults `OFF_API_BASE_URL` to `https://world.openfoodfacts.org`; the `compose/inventory.yml` passthrough is empty, so set it only to point at a mirror / mock.
- **Fails open.** A network error, a 4 s timeout, a non-200, or an unknown code all yield a blank review form — never an error that blocks registration.
- **Coverage is partial by design.** OFF covers national-brand food well; store brands (Member's Mark, Great Value) and non-food (cups/straws) often miss — the manager fills the form once and the barcode binds to the item thereafter, so a miss costs one-time typing, not a recurring gap. A miss is not an error.
- **Attribution.** OFF data is ODbL — keep a visible "Powered by Open Food Facts" credit if the looked-up data is ever surfaced to end users.

---

## 6. Troubleshooting

### Topic runbooks (deep dives)

For symptoms that have a full diagnose/recover/escalate path, jump straight to a runbook in [`docs/runbooks/`](docs/runbooks/):

| Symptom | Runbook |
|---|---|
| Clover sync stalled, KDS board not updating, stale analytics, backfill replay | [`docs/runbooks/clover-sync.md`](docs/runbooks/clover-sync.md) |

The sub-sections below cover symptoms that don't warrant a dedicated runbook yet.

### 6.1 Deploy failed / health check red

**Symptom**: the `build-images.yml` deploy step fails, or a stack comes up unhealthy on the host.

1. **Check the failed container's logs first** — `ssh oracle 'docker compose -f compose/<stack>.yml logs --tail 100 <service>'` or `docker logs -f <container>`. 90% of failures are visible in the first 50 lines.
2. **Common causes**:
   - **Missing env / wrong infra URL** — a required value isn't reaching the container. Look for zod parse errors at startup. Check the host `compose/<stack>.env` and the Infisical `prod` scope, and remember the override rule (§2.7): an infra URL also present in Infisical wins over the host file.
   - **`migrate` / `migrate-auth` service failed** — usually a DB connection failure (wrong `DATABASE_URL`, or `postgres-kds` not healthy yet) or a migration conflict. Re-check `DATABASE_URL` and `prisma migrate status`.
   - **Image not yet pushed** — `build-images.yml` is still building. Wait for the build job, then re-run the deploy.
   - **Healthcheck timeout** — Container started but slower than `start_period + interval × retries`. Increase those if you've changed code that takes longer to warm up. For backoffice-web that's typically Next.js JIT compilation.
3. **Quick rollback**: see §4.7.

### 6.2 Container restart loop

`docker ps` shows status `Restarting (1)` or similar.

```bash
ssh oracle
docker logs <container> --tail 100        # what's the crash reason?
docker inspect <container> | jq .State    # exit code, restart count
```

Typical fixes:
- Crash on startup (exit code 1) → env validation failed → see §6.1.
- Crash on signal (exit 137 = OOM kill) → see §6.7.
- Crash in run loop → check for unhandled promise rejections in logs; Sentry should have the trace.

### 6.3 Clover 401 / silent integration failure

> Full diagnose/recover/escalate path including BullMQ dead-letter handling and backfill replay lives in [`docs/runbooks/clover-sync.md`](docs/runbooks/clover-sync.md). This sub-section covers only the token-rotation case.

**Symptom**: KDS board stops updating but `/api/health` returns 200; analytics dashboards show no new sales.

**Diagnosis**:
```bash
ssh oracle
docker logs rop-analytics-analytics-api-1 --since 1h | grep -iE 'clover|401|unauthorized'
```

**Root cause**: Clover access tokens are short-lived for unauthorized merchant apps. They expire periodically and any service that holds the old value 401s on the next API call.

**Fix**:
1. Rotate the token in the Clover dashboard.
2. Update `CLOVER_TOKEN` in the Infisical `prod` scope (one secret, read by both kds and analytics via `with-infisical`). Backoffice doesn't read it directly.
3. Restart the kds + analytics stacks so `with-infisical` re-injects it: `docker compose -f compose/kds.yml --env-file compose/kds.env up -d` (and the same for `analytics`).

There is no in-app rotation UI — by design. The previous `/api/clover/token-mode` endpoints were removed; the env-sourced token lives in Infisical (the KDS steady-state token also lives as a Backoffice-saved encrypted DB row — see §7.1).

### 6.4 Compose validation caught by CI

**Symptom**: the `Validate compose stacks` check (`validate-compose.yml`) fails — `docker compose config failed for compose/<stack>.yml`.

This is a **structural** check: it parses the YAML, resolves the merge, and verifies that every network/volume a service references is defined. It does **not** check env values against any external store (the old Dokploy env-drift validator was deleted with Dokploy). Typical causes:

- **Bad YAML** — indentation, a duplicate key, a malformed `${VAR:-default}`.
- **Undefined network/volume** — a service lists a network/volume in its block that isn't declared at the bottom of the file (e.g. you added a service on `rop-net` but forgot the top-level `networks: rop-net: {external: true}`).

Unset `${VAR}`s only warn — they arrive from the host `.env` / Infisical at deploy time, not from CI. Fix the YAML, push; the check re-runs on the PR.

### 6.5 Traefik 404 / route not picked up

```bash
# Is the router registered?
ssh oracle "curl -s http://127.0.0.1:8080/api/http/routers | jq '.[].name' | grep rop"

# Is the container on rop-net?
ssh oracle "docker inspect <container> | jq '.[0].NetworkSettings.Networks | keys'"

# Are the labels what you expect (incl. traefik.docker.network=rop-net)?
ssh oracle "docker inspect <container> | jq '.[0].Config.Labels' | grep traefik"
```

Most common cause: the routed service is missing the `traefik.docker.network=rop-net` label, so Traefik looks for the backend on its provider-default network (`traefik-servicenet`) instead of the flat `rop-net` bridge the container is actually on. Add the label, push, redeploy.

### 6.6 WebAuthn / passkey failures

WebAuthn requires:
1. HTTPS (cannot use HTTP except `localhost` for dev).
2. `WEBAUTHN_RP_ID` exactly matching the browser hostname (so `kds.example.com`, not `kds.example.com:443`).
3. Browser supports WebAuthn (~all modern browsers + iOS 16+).

If users get "passkey not recognized" after a domain change: the RP ID is bound to the credential at registration time. Old passkeys won't work on the new hostname; users must re-register. There's no migration path — design accordingly when planning domain changes.

### 6.7 Container OOM killed

```bash
docker inspect <container> | jq '.[0].State.OOMKilled'   # true if OOM
```

Oracle ARM has 24 GB. Typical working set after observability stack is ~6–8 GB. If you're seeing OOM, check:
1. **Memory leak in app** — Grafana → Node `process_resident_memory_bytes` over time.
2. **Build cache on host filling up** — `du -sh /home/actions-runner/buildx-cache/*`. Clean: `docker buildx prune`.
3. **Co-tenant ate memory** — `docker stats --no-stream`.

Last resort: add `deploy.resources.limits.memory` to the compose service to fail fast instead of OOM-killing the host.

### 6.8 Daily reset didn't fire

KDS `DAILY_RESET_*` env triggers a nightly clear of stale tickets at `DAILY_RESET_HOUR:DAILY_RESET_MINUTE` in `DAILY_RESET_TIMEZONE`. If it didn't fire:
1. Check `kds-worker` logs around the expected time: `docker logs rop-kds-kds-worker-1 --since 12h | grep -i reset`.
2. Check `DAILY_RESET_ENABLED=true` for the kds stack (Infisical `prod`, or the kds host `.env` / compose default).
3. The reset is checked every `DAILY_RESET_CHECK_INTERVAL_MS` (30 s default). If the worker was down at the scheduled minute, it doesn't run retroactively — file a follow-up manual reset via the backoffice `/admin/reset` page.

### 6.9 kds-api dead-letter queue (DLQ) recovery

A sync/fulfillment job that exhausts its BullMQ retries is written to the Postgres `dead_letter_jobs` table — the durable DLQ ([ADR-0727](docs/decisions/0727-dead-letter-queue-replay-reuses-the-postgres-table-not-a-new-bullmq-queue.md)). The `KdsDeadLetterQueueGrowing` Prometheus alert fires when `kds_dlq_size{job_type} > 10` for 5 min (GH #124). Recovery is operator-driven via three internal-admin endpoints (bearer `KDS_INTERNAL_ADMIN_TOKEN`):

1. **Triage** — list the unresolved rows:
   ```bash
   curl -s -H "Authorization: Bearer $KDS_INTERNAL_ADMIN_TOKEN" \
     "https://kds.example.com/api/admin/dlq?resolved=false" | jq
   ```
   Each row has `jobType`, `reason`, `attempts`, `merchantId`, `createdAt`. Eyeball `reason` for a systemic cause (e.g. a Clover 401 → fix the token first, §6.3).
2. **Replay** a row once the underlying cause is fixed — re-enqueues the original job onto its queue and marks the row resolved (idempotent; safe to repeat):
   ```bash
   curl -s -XPOST -H "Authorization: Bearer $KDS_INTERNAL_ADMIN_TOKEN" \
     "https://kds.example.com/api/admin/dlq/<id>/replay"
   ```
   Only `sync-order` and `push-fulfillment` rows are replayable; a `422` means the type self-reschedules (scheduler jobs) or needs manual handling — use resolve.
3. **Resolve** a row you've handled out-of-band or judged unreplayable (a permanent contract bug), without replaying:
   ```bash
   curl -s -XPOST -H "Authorization: Bearer $KDS_INTERNAL_ADMIN_TOKEN" \
     "https://kds.example.com/api/admin/dlq/<id>/resolve"
   ```

`resolvedAt` drops the row out of `kds_dlq_size`, so the alert clears once the table is drained. Bulk replay is intentionally not exposed (a "replay all" against the live sync queue is a thundering-herd risk) — replay rows individually.

---

## 7. Security & Secrets

### 7.1 Where secrets live

Runtime secrets follow the **three-layer model** of [ADR-0020](docs/decisions/0020-adopt-infisical-for-runtime-secrets.md). This section is the canonical reference `README.md` links to.

- **Layer 1 — Infisical (runtime injection).** Steady-state app secrets live in the `restaurant-ops-platform` Infisical project (`prod` env) and are injected into each container's environment at start by the `with-infisical` entrypoint wrapper ([`scripts/with-infisical.sh`](scripts/with-infisical.sh)) — no `.env` is written to disk, and app code keeps reading `process.env` through its existing zod schemas (`lib/env.ts` / `src/config.ts` are unchanged). Members: `CLOVER_*`, `CLOVER_WEBHOOK_AUTH_CODE`, `INVENTORY_INTERNAL_TOKEN`, `CREW_*`, `ANALYTICS_ADMIN_TOKEN` / `ADMIN_TOKEN`, `REDIS_URL`, `WEB_LOGIN_PASSWORD_HASH`, `GEMINI_API_KEY` (invoice-scan vision — the one AI key in this layer; see the table below), `INTERNAL_AI_TOKEN` (crew↔backoffice scan-proxy bearer).
- **Layer 2 — `app_setting` AES-GCM rows.** Operator-rotatable, hot-reloadable secrets (e.g. `ai.deepseek_api_key`) are stored as encrypted rows in the `app_setting` store (ADR-0016/0017) and re-saved by managers at `/settings/ai` without a redeploy. Infisical does **not** replace this layer — the two are complementary.
- **Layer 3 — host `.env` file + 1Password (bootstrap / break-glass / secret zero).** The irreducible set Infisical cannot inject: the local-DNS infra URLs (`DATABASE_URL`, `REDIS_URL`, `INVENTORY_DATABASE_URL`), `POSTGRES_PASSWORD`, and the Infisical machine credential itself ("secret zero", `INFISICAL_MACHINE_CLIENT_ID` / `INFISICAL_MACHINE_CLIENT_SECRET`) that unlocks Layer 1. These live in the gitignored per-stack host file `compose/<stack>.env` (template: [`.env.prod.example`](.env.prod.example)), backed up in 1Password. Prisma migrate sidecars run before the app and must not depend on an Infisical fetch — that is why the DB URL stays in env. **Override rule** (§2.7): `with-infisical` overrides same-named env at boot, so the infra URLs must live here and **not** in Infisical, or Infisical's (possibly stale) value wins.
- **CI / deploy control-plane** (`ORACLE_SSH_KEY`, `ORACLE_SSH_HOST`, `SENTRY_AUTH_TOKEN`, `SLACK_WEBHOOK_URL`) stays in **GitHub Actions secrets** (mirrored from the 1Password `Example Kitchen DevOps` vault) so a deploy never circularly depends on a successful Infisical fetch.

For local AI-agent and operator commands, the Layer-3 / control-plane secrets still flow from **1Password** via [`docs/agent-secret-workflow.md`](docs/agent-secret-workflow.md); Layer-1 runtime secrets come from Infisical (`infisical login` + `SECRETS_BACKEND=infisical make dev` locally, or a read-only `dev`-scoped Infisical machine identity / MCP for agents and CI):

```bash
op run --env-file=.env.tpl -- claude
op run --env-file=.env.tpl -- codex
op run --env-file=.env.tpl -- scripts/sync-github-secrets-from-agent-env.sh
```

| Secret | Location | Used by |
|---|---|---|
| `CLOVER_TOKEN`, `CLOVER_*` credentials | **Layer 1** — Infisical (`with-infisical`) for the env-sourced creds (bootstrap/fallback + analytics-api); Backoffice-saved encrypted DB row for KDS steady state | kds-api, kds-worker, analytics-api; inventory-api (`CLOVER_MERCHANT_ID` scope only, for the ADR-0028 sold-items feed) |
| `CLOVER_WEBHOOK_AUTH_CODE` | **Layer 1** — Infisical (`with-infisical`) | kds-api webhook verification |
| `INVENTORY_INTERNAL_TOKEN` | **Layer 1** — Infisical (`with-infisical`) | backoffice BFF ↔ inventory-api bearer |
| `CREW_SESSION_SECRET`, `CREW_PIN_PEPPER` (`CREW_*`) | **Layer 1** — Infisical (`with-infisical`) | inventory-api crew PIN login |
| `REDIS_URL` | **Layer 1** — Infisical (`with-infisical`) | kds-api, kds-worker, backoffice |
| `ANALYTICS_ADMIN_TOKEN` / `ADMIN_TOKEN` | **Layer 1** — Infisical, one secret read by all consumers (**same value**) | backoffice ↔ analytics-api bearer auth; inventory-api → analytics-api sold-items feed (ADR-0028) |
| `WEB_LOGIN_PASSWORD_HASH` (optional fallback) | **Layer 1** — Infisical (`with-infisical`) | Argon2id password login |
| `DEEPSEEK_API_KEY` (`ai.deepseek_api_key`) + other `category=secret` rows | **Layer 2** — `app_setting` AES-GCM row (`category=secret`), set/rotated at `/settings/ai`; the `DEEPSEEK_API_KEY` env var is a deprecated transition fallback | backoffice AI chat route (resolver: DB row wins, then env, then 503); future Clover OAuth tokens |
| `GEMINI_API_KEY` (`ai.vision_api_key`) | **Layer 1** — Infisical (`with-infisical`); the env fallback of the vision-key resolver. Unlike `DEEPSEEK_API_KEY` (Layer 2), prod runs invoice-scan vision on this Infisical-injected env var with no `app_setting` row (verified live 2026-06-13). Resolver still prefers an `ai.vision_api_key` DB row if set at `/settings/ai`, then this env, then 503. Use a **dev-scoped** key in the Infisical `dev` env — never the prod key (the `dev` env is read by every dev + the `rop-dev-agent` identity). | backoffice invoice-scan + Gemini vision-fallback / web-search (`apps/backoffice-web/lib/ai/vision-provider.ts`) |
| `INTERNAL_AI_TOKEN` | **Layer 1** — Infisical (crew-web + backoffice — **same value**) | crew-web scan BFF → backoffice `/api/inventory/receipt-parse` bearer (ADR-0538); crew has no AI provider of its own |
| `DATABASE_URL`, `INVENTORY_DATABASE_URL` | **Layer 3** — host `.env` (`compose/<stack>.env`; local compose DNS; keep OUT of Infisical per override rule; 1Password backup) | All apps; inventory-api owns the second URL |
| `REDIS_URL` (infra-URL form) | **Layer 3** — host `.env` (`redis://redis-kds:6379`, local compose DNS) | kds-api, kds-worker, backoffice — see override-rule note below |
| `POSTGRES_PASSWORD` | **Layer 3** — host `.env` (fresh named volume; not network-exposed) | the per-stack `postgres-*` compose service |
| `SESSION_SECRET` (kds + backoffice — distinct values) | **Layer 1** — Infisical (`with-infisical`); 1Password backup | Cookie signing |
| `KDS_INTERNAL_ADMIN_TOKEN` | **Layer 1** — Infisical (kds + backoffice — **same value**) | backoffice ↔ kds-api bearer auth |
| `AI_TOKEN_ENCRYPTION_KEY` | **Layer 1** — Infisical (kds-api only; 1Password break-glass copy) | Master key for at-rest encryption of POS provider tokens in db-kds — `clover_merchants.*Cipher`, `pos_accounts.*Cipher`, and the Deliverect `kds_provider_configs.{apiToken,hmacSecret}Cipher` (PRs #750/#761, Phase 4.5). Read only by kds-api/kds-worker via `src/lib/crypto/encryption.ts`; the backoffice `app_setting` store uses the **separate** `APP_SETTING_ENCRYPTION_KEY` (a leak of one never exposes the other). kds-api fails fast at boot (`assertAiTokenEncryptionKey`) if unset. Never used for the AI assistant. Loss = every encrypted token row unreadable; operator re-auths the POS connection. |
| `APP_SETTING_ENCRYPTION_KEY` | **Layer 1** — Infisical (backoffice only) | Master key for at-rest encryption of `app_setting` rows with `category=secret` (AI provider API keys incl. `ai.deepseek_api_key`, future Clover OAuth tokens). 32-byte hex (`openssl rand -hex 32`). Distinct from `AI_TOKEN_ENCRYPTION_KEY` so a leak of one doesn't compromise the other. Loss = every secret setting row unreadable; operator re-enters via `/settings/ai`. See issue #244. |
| `APP_SETTING_ENCRYPTION_KEY_PREVIOUS` | **Layer 1** — Infisical (backoffice only, transient) | Optional decrypt-only fallback during rotation of `APP_SETTING_ENCRYPTION_KEY`. Drop after the next deploy once every secret row has been re-written under the new primary key. |
| `INFISICAL_MACHINE_CLIENT_ID` / `INFISICAL_MACHINE_CLIENT_SECRET` — **"secret zero"** | **Layer 3** — host `.env` (1Password backup) | The Universal Auth machine identity (`Claude`) `with-infisical` uses to fetch Layer 1 for every consuming service. The legacy static `INFISICAL_TOKEN` was revoked — leave it unset. Project/env(`prod`)/path defaults are baked into `with-infisical.sh`. |
| `ORACLE_SSH_KEY` / `ORACLE_SSH_HOST` | **Control-plane** — 1Password `Example Kitchen DevOps` source; GitHub repo secrets mirror | `build-images.yml` deploy step (SSH → `scripts/deploy-stack.sh`) |
| `SENTRY_AUTH_TOKEN`, `SENTRY_ORG` | **Control-plane** — GitHub repo secrets | `build-images.yml` (Sentry source-map / release upload at image build) |
| `SLACK_WEBHOOK_URL` | **Control-plane** — GitHub repo secrets | `slack-notify.yml` |
| `GRAFANA_ADMIN_PASSWORD` | `~/.env.observability` on Oracle (root-readable) | observability compose |
| Oracle deploy + operator SSH keys | Deploy key in GH secret `ORACLE_SSH_KEY`; operator key in local `~/.ssh/` | CI deploy + emergency SSH |

1Password is the operator vault and break-glass backup, not a production runtime dependency. GitHub Actions reads GitHub repo secrets. On the host, each stack reads **Layer 3** from its `compose/<stack>.env` file, **Layer 1** from Infisical via the `with-infisical` entrypoint (using the secret-zero machine identity held in that `.env`), and **Layer 2** from the application database. The host holds only the one scoped, revocable Infisical credential needed to start services — not a broad 1Password credential.

### 7.2 Rotation procedures

| Secret | Frequency | Procedure |
|---|---|---|
| `SESSION_SECRET` (Layer 1) | After incident only | Rotate in Infisical (`prod`) → restart kds + backoffice so `with-infisical` re-injects → all users re-login |
| `CLOVER_TOKEN` (Layer 1) | When it rotates (per Clover policy) | Update the secret in Infisical (`prod`), then restart the consumers so `with-infisical` re-injects it; see §6.3 for the Clover-side flow |
| `ANALYTICS_ADMIN_TOKEN` / `ADMIN_TOKEN` (Layer 1) | Yearly | **Rotate once in Infisical**, then restart analytics-api + backoffice. The byte-identical compose duplication is gone (ADR-0020) — the shared value is a single Infisical secret, so there is no staggered-window 401 risk anymore. |
| `KDS_INTERNAL_ADMIN_TOKEN` (Layer 1) | Yearly | **Rotate once in Infisical** (kds + backoffice read the same value), then restart both stacks. One Infisical secret, so no staggered-window 401 risk. |
| Infisical "secret zero" — `INFISICAL_MACHINE_CLIENT_ID` / `_SECRET` (Layer 3) | Yearly or after laptop loss | Infisical → Access Control → Machine Identities → rotate the `Claude` identity's client secret, update `INFISICAL_MACHINE_CLIENT_*` in each stack's host `compose/<stack>.env`, restart. Mixed old/new across stacks during the window is harmless (read-only fetch). |
| `ORACLE_SSH_KEY` (control-plane) | Yearly or after laptop loss | Generate a new keypair, add the pubkey to the host's `~/.ssh/authorized_keys`, update the `ORACLE_SSH_KEY` GH repo secret, verify a deploy works, remove the old pubkey |
| `AI_TOKEN_ENCRYPTION_KEY` (Layer 1) | After incident only | **Destructive if rushed** — single-key with no decrypt fallback yet, so a naive swap orphans all at-rest ciphertext (`*Cipher` on `clover_merchants` / `pos_accounts` / `kds_provider_configs`). Follow the flag-day re-encrypt procedure: [`docs/runbooks/rotate-ai-token-encryption-key.md`](docs/runbooks/rotate-ai-token-encryption-key.md). The zero-downtime variant unlocks after P3-1 (`_PREVIOUS` fallback). |
| `APP_SETTING_ENCRYPTION_KEY` (Layer 1) | After incident only | Dual-key transition (issue #244): generate `openssl rand -hex 32`, move the old key to `APP_SETTING_ENCRYPTION_KEY_PREVIOUS` in Infisical, set the new key as `APP_SETTING_ENCRYPTION_KEY`, restart backoffice. Open `/settings/ai` and re-save every `category=secret` row (the writer re-encrypts under the new key). On the next restart, drop `APP_SETTING_ENCRYPTION_KEY_PREVIOUS`. |
| Oracle operator SSH key | Yearly | Add new pubkey to `~/.ssh/authorized_keys` first; verify new key works; remove old |

### 7.3 Branch protection

See [`.github/BRANCH_PROTECTION.md`](.github/BRANCH_PROTECTION.md). Key invariants:
- `main` requires a green PR from a feature branch.
- Status checks `Lint, build, test` + `E2E + migrations` must be green.
- Linear history (no merge commits) — keeps `git log` clean and rollback unambiguous.
- Dismiss stale approvals on new pushes.

The repo owner can admin-bypass for emergencies, but every bypass should ideally be followed by a retro PR that adds whatever test would have caught the issue.

### 7.4 Incident response sketch

1. **Contain**: Don't deploy. Deploy is already manual-only (ADR-0014), so simply not running `build-images.yml` halts any new rollout; if a stack is actively misbehaving, stop it on the host (`docker compose -f compose/<stack>.yml down`).
2. **Diagnose**: Sentry + Grafana Loki + recent git log.
3. **Rollback if needed**: §4.7.
4. **Rotate compromised secrets**: §7.2.
5. **Write a postmortem note in `HANDOFF.md`** (record it under HANDOFF.md "Operational log"; older examples live in docs/archive/HANDOFF-phase-closeouts.md).
6. **Add a test or alert** so the next occurrence trips a tripwire (see §5.4 for the existing pattern).

---

## 8. Disaster Recovery & Backup

### 8.1 Backup mechanism — `scripts/backup-postgres.sh`

Nightly logical backups of the Postgres DBs to Cloudflare R2, with client-side
encryption and a Prometheus dead-man's-switch. The script is the write-side
companion to `check-business-health.sh` and follows the same host-cron
conventions (`--dry-run/--force/--debug`, one log file, `docker exec`).

**Per enabled DB:** `pg_dump -Fc` *inside* the db container (so the dump tool
always matches the server version) → optional `age` client-side encryption
(default ON) → `rclone` upload to R2 → prune objects older than the retention →
write `backup.prom` for node-exporter's textfile collector.

**Behavior is operator-tunable via AppSetting** (ADR-0016 registry, category
`backup`; the script reads these from `postgres-kds` with DB→env→default
precedence, so they take effect with no redeploy):

| Setting key | Default | Meaning |
|---|---|---|
| `backup.enabled` | `true` | Master switch; `false` skips the run (cron stays installed). |
| `backup.databases` | `["kds","analytics","inventory","crm"]` | Which DBs to dump. `analytics` is rebuildable from Clover; the others are write-source. |
| `backup.retention_days` | `30` | Days of dumps kept in R2 before pruning (DeleteObject is free). |
| `backup.encrypt` | `true` | `age`-encrypt before upload; the job *refuses to upload plaintext* if true with no recipient. |

Until the Backoffice settings panel for this category ships, set these via the
settings API, e.g. `PUT /api/settings/backup.retention_days` with `{"value":14}`.

**Credentials live in Infisical** (ADR-0016 §4 — never in AppSetting, which
round-trips through the BFF), at **`prod:/backup`** (project `00000000-…`),
scoped to that path so they inject only into the backup job — not every service
the way `/` would. `scripts/backup-postgres-cron.sh` runs the backup under
`with-infisical` with `INFISICAL_SECRET_PATH=/backup`, so rclone auto-configures
from the injected `RCLONE_CONFIG_R2_*` env with no config file on disk:

| Infisical key (`prod:/backup`) | Meaning |
|---|---|
| `RCLONE_CONFIG_R2_ACCESS_KEY_ID` / `_SECRET_ACCESS_KEY` | R2 S3 credential. For an R2 token: Access Key ID = token ID; Secret = `sha256(token value)`. |
| `RCLONE_CONFIG_R2_ENDPOINT` / `_TYPE` / `_PROVIDER` / `_REGION` / `_ACL` / `_NO_CHECK_BUCKET` | rclone remote definition (`endpoint=https://<account>.r2.cloudflarestorage.com`; `no_check_bucket=true` because a bucket-scoped token can't HeadBucket). |
| `BACKUP_R2_BUCKET` | Target bucket (`rop-backups`). |
| `BACKUP_AGE_RECIPIENT` | `age` **public** key (encrypt-only — safe to store). |

> ⚠️ The `age` **private** key (for restore) lives in **1Password only**, NOT on
> the host — a full host loss otherwise takes the decryption key with it and the
> offsite backups become unrecoverable. (Host copy: `~/.config/rop-backup/age-key.txt`.)

**Setup (done 2026-06-07; recorded for DR rebuilds):**
1. R2 bucket `rop-backups` + an **Object Read & Write** token scoped to it.
   Derive the S3 pair — Access Key ID = token ID (from `…/accounts/<id>/tokens/verify`),
   Secret = `printf %s '<token value>' | sha256sum`. Store both + the rclone config
   above in Infisical: `infisical secrets set RCLONE_CONFIG_R2_ACCESS_KEY_ID=… … --projectId=00000000-… --env=prod --path=/backup`.
2. `age-keygen` once → **private** key into 1Password, **public** key →
   `BACKUP_AGE_RECIPIENT`.
3. Install the Infisical CLI on the host (the cron injects through it):
   `curl -1sLf https://dl.cloudsmith.io/public/infisical/infisical-cli/setup.deb.sh | sudo -E bash && sudo apt-get install -y infisical`.
4. Roll out the textfile collector — **mind the project name** (`-p rop-observability`,
   else compose spins a stray node-exporter on the wrong network):
   `docker compose -p rop-observability -f docker-compose.observability.yml --env-file .env.observability up -d node-exporter`.
5. Install the cron (03:00 UTC nightly) — the wrapper handles Infisical injection:
   ```cron
   0 3 * * * $HOME/restaurant-ops-platform/scripts/backup-postgres-cron.sh >> $HOME/backup-postgres.log 2>&1
   ```
6. Verify: `scripts/backup-postgres-cron.sh --dry-run`, then a real run, then
   confirm objects in R2 and a fresh `backup.prom` under `observability/textfile/`.

**Alerting (Prometheus/Grafana).** The script emits per-DB
`rop_backup_last_success_timestamp_seconds`. Add a Grafana alert:

```promql
# Fires when any enabled DB has had no successful backup in > 26h,
# or its most recent run failed.
(time() - max by (database) (rop_backup_last_success_timestamp_seconds)) > 26 * 3600
  or max by (database) (rop_backup_last_run_success) == 0
```

**Posture:**

| Asset | Backed up? | Where | Restore tested? |
|---|---|---|---|
| `postgres-kds` / `-analytics` / `-inventory` / `-crm` | ✅ **active** — nightly `backup-postgres-cron.sh`; first run verified 2026-06-07 | R2, encrypted `-Fc` dumps | ✅ **inventory drilled 2026-06-13** (pull→decrypt→`pg_restore`→row counts matched live; see HANDOFF.md Operational log) — kds/analytics/crm not yet drilled; re-drill quarterly |
| `redis-kds-data` (sessions only) | ❌ no backup (ephemeral, by design) | n/a | n/a |
| GHCR images | ✅ retained 90d | `ghcr.io/example-org/rop-*` | ✅ via image pin (§4.7) |
| `compose/*.yml` + source | ✅ in git / GitHub | repo | ✅ |
| Runtime secrets | ✅ Infisical `prod` (+ 1Password break-glass) | Infisical | ⚠️ Infisical's own durability |
| Host `.env` / `.env.observability` | ⚠️ host fs only; 1Password holds secret-zero | host + 1Password | ❌ never restored |

### 8.2 Image rollback

Already covered in §4.7. Pin a SHA on the host (or revert on `main` + redeploy). The previous `:main` tag is irretrievable once overwritten, but `:<sha>` tags persist for 90 days in GHCR.

### 8.3 Restore drill (within 7 days of activation, then quarterly)

An untested backup is not a backup. Drill the **encrypted-dump restore path** —
never restore into the live DB. Example for `kds`:

1. Pull the latest dump:
   ```bash
   latest=$(rclone lsf r2:rop-backups/kds/ | sort | tail -1)
   rclone copyto "r2:rop-backups/kds/$latest" /tmp/kds.dump.age
   ```
2. Decrypt with the private key from 1Password:
   `age -d -i ~/age-backup.key -o /tmp/kds.dump /tmp/kds.dump.age`
3. Restore into a throwaway container (`-Fc` dumps use `pg_restore`, not `psql`):
   ```bash
   docker run -d --rm --name yr-restore-test -e POSTGRES_PASSWORD=x postgres:16-alpine
   sleep 5
   docker exec -i yr-restore-test pg_restore -U postgres -d postgres --no-owner < /tmp/kds.dump
   ```
4. Smoke-check row counts on key tables (`kds_tickets`, `clover_merchants`; for
   analytics `mart.fact_order_line_items`).
5. Tear down + record the drill date in `HANDOFF.md`:
   `docker stop yr-restore-test && rm -f /tmp/kds.dump*`.

### 8.4 A stack is down (no control plane to fail)

There is no control plane anymore — stacks are plain `docker compose`, so the failure modes are just Docker's:

1. **Containers keep running independently** — there is no daemon they depend on; if one stack is wedged, the others are unaffected.
2. **Restart a stack**: `ssh oracle 'cd ~/restaurant-ops-platform && docker compose -f compose/<stack>.yml --env-file compose/<stack>.env up -d'`.
3. **Recreate from scratch** (e.g. after a manual `down`): same command — compose recreates containers; named volumes (and their data) persist.
4. **Verify**: `ssh oracle 'docker compose -f compose/<stack>.yml ps'` and the §2.11 smoke-test curls.

Deploys via CI need the Mac Mini runner + SSH reachability; if CI is unavailable, deploy by hand on the host with `scripts/deploy-stack.sh <stack>`.

### 8.5 Full host loss

Worst-case: Oracle terminates the instance.

1. **Provision a new Oracle ARM instance** with the same shape.
2. **Install Docker + clone the repo** to `~/restaurant-ops-platform` (§2.2) and **create the external network** `rop-net` (§2.4).
3. **Restore DB data** from backups into the new named volumes (`pg_dump`/`psql`, or volume restore) once the `postgres-*` services are up.
4. **Recreate the host `.env` files** (`compose/<stack>.env`) from the [`.env.prod.example`](.env.prod.example) template — fill in the Infisical secret-zero (`INFISICAL_MACHINE_CLIENT_ID` / `_SECRET`) from 1Password and the infra URLs. Everything else re-injects from Infisical at boot.
5. **Bring up each stack**: `bash ~/restaurant-ops-platform/scripts/deploy-stack.sh <stack>` for `kds`, `analytics`, `backoffice`, `inventory`, `crew`, `order`, `legal`, `marketing` (crm staged).
6. **Re-issue Cloudflare DNS A-records** to the new IP.
7. **Re-point the deploy secrets**: update `ORACLE_SSH_HOST` (and the host's `authorized_keys` for `ORACLE_SSH_KEY`); **reinstall the self-hosted runner** (§2.9) with a fresh runner token if it lived on the lost box.
8. **Reinstall observability stack** (§5.1) — accept losing historical metrics/errors unless you backed up those volumes too.

**RTO** (recovery time objective) at current backup posture: ~half a day, with significant data loss (whatever's not in the latest backup) for the OLTP and OLAP DBs. Improving §8.1 backup gaps brings this down meaningfully.

---

## 9. Appendix

### 9.1 Port / domain / network reference

| Domain | Compose service | Container port | Auth |
|---|---|---|---|
| `kds.example.com` | kds-api (`/api`, `/ws`, `/admin`) + kds-web (catch-all) | 4000 / 3000 | Cookie session + WebAuthn |
| `analytics.example.com` | analytics-api (`/webhooks/clover`, `/admin`) | 3100 | Bearer (admin endpoints) + Clover signature (webhook) |
| `backoffice.example.com` | backoffice-web | 3001 | Cookie session + WebAuthn |
| `inventory.example.com` | inventory-api | 4100 | Bearer / crew PIN (internal; via BFF) |
| `crew.example.com` | crew-web | 3003 | Crew PIN session |
| `order.example.com` | order-web | 3004 | Public (customer) |
| `legal.example.com` | legal-site | 80 | Public |
| `www.example.com` | marketing-site | 80 | Public |
| `metrics.example.com` | grafana | 3000 | Account |

### 9.2 Environment variable index

See per-stack `.env.example` files:
- Suite-wide: [`.env.example`](.env.example)
- Production host bootstrap (per-stack `.env`): [`.env.prod.example`](.env.prod.example)
- Analytics: [`apps/analytics-api/.env.example`](apps/analytics-api/.env.example)
- Backoffice: [`apps/backoffice-web/.env.example`](apps/backoffice-web/.env.example)
- Observability: [`.env.observability.example`](.env.observability.example)

The canonical list of *runtime-required* vars per stack is the `environment:` block of each [`compose/*.yml`](compose/) — vars without a `${VAR:-default}` default are required (and arrive from Infisical or the host `.env` at deploy time).

### 9.3 Useful commands

```bash
# Inspect a stack's services (plain compose names: rop-<stack>-<service>-<n>)
ssh oracle "docker ps --filter 'label=com.docker.compose.project=rop-kds' --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'"

# Tail logs across all kds services (by compose service name)
ssh oracle "cd ~/restaurant-ops-platform && docker compose -f compose/kds.yml logs -f --tail 50"

# Postgres shell into the kds DB
ssh oracle "docker exec -it rop-kds-postgres-kds-1 psql -U postgres rop_kds"

# Redis ping
ssh oracle "docker exec rop-kds-redis-kds-1 redis-cli ping"

# Deploy / re-up a single stack by hand (git-syncs to origin/main first)
ssh oracle "bash ~/restaurant-ops-platform/scripts/deploy-stack.sh kds"

# Manual one-off business health check (don't email)
ssh oracle "$HOME/restaurant-ops-platform/scripts/check-business-health.sh --dry-run"

# Validate compose stacks locally before pushing (same check as CI)
for f in compose/*.yml; do docker compose -f "$f" config -q && echo "$f ✓"; done
```

### 9.4 Related documents

| Document | Focus |
|---|---|
| [`AGENTS.md`](AGENTS.md) | Repo conventions, Iron Laws, per-app boundaries, "Deploy is user-gated" |
| [`docs/decisions/0005-dokploy-over-coolify.md`](docs/decisions/0005-dokploy-over-coolify.md) | The now-superseded decision to adopt Dokploy (kept for history; see the Dokploy-removal ADR) |
| [`.github/OBSERVABILITY.md`](.github/OBSERVABILITY.md) | Observability stack details |
| [`.github/BRANCH_PROTECTION.md`](.github/BRANCH_PROTECTION.md) | Branch protection setup |
| [`compose/README.md`](compose/README.md) | Compose stack overview |
| [`.env.prod.example`](.env.prod.example) | Per-stack production host `.env` template (secret-zero + infra URLs) |
| [`scripts/deploy-stack.sh`](scripts/deploy-stack.sh) | The host deploy script (git-sync + `docker compose pull && up -d`) |
| [`infrastructure/traefik/README.md`](infrastructure/traefik/README.md) | Traefik dynamic config (Clover webhook fan-out) |
| `HANDOFF.md` | Current handoff: production reality, open threads, operational log (phase history: `docs/archive/HANDOFF-phase-closeouts.md`) |
| `HANDOFF-clover-webhook-fanout.md` | Webhook fan-out deployment notes |
| [`README.md`](README.md) | Quick start (local dev) + integration notes |

---

> Found something wrong or missing? Edit this file directly. The Chinese mirror [`OPERATIONS.zh-CN.md`](OPERATIONS.zh-CN.md) should be updated in the same PR to keep them in sync.
