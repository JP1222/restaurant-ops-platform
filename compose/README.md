# compose/

Production Compose stacks — one self-contained `docker compose` stack per app, run
on the Oracle host (no Dokploy, no Swarm — see the Dokploy-removal ADR). The
directory name is historical.

| File | Compose project (`name:`) | Host |
| --- | --- | --- |
| `kds.yml` | `rop-kds` | `kds.example.com` |
| `analytics.yml` | `rop-analytics` | `analytics.example.com` |
| `backoffice.yml` | `rop-backoffice` | `backoffice.example.com` |
| `inventory.yml` | `rop-inventory` | _internal-only_ ² |
| `legal.yml` | `rop-legal` | `legal.example.com` |
| `marketing.yml` | `rop-marketing` | `www.example.com` |
| `crew.yml` | `rop-crew` | `crew.example.com` |
| `order.yml` | `rop-order` | `order.example.com` |
| `crm.yml` | `rop-crm` | `crm.example.com` ¹ |

¹ `crm.yml` is **STAGED — not yet deployed**. The loyalty/CRM worker spine is live on `main`, but going live is user-gated (provision its host `.env` + `postgres-crm` volume, seed the reward rungs, then deploy). The file documents the target topology.

² `inventory-api` has **no Traefik route** — it's reached only over the `rop-net` bridge (`http://inventory-api:4100`) by crew-web + backoffice-web. `inventory.example.com` resolves only via the zone's `*.example.com` wildcard (there is **no per-host record** to delete — the wildcard serves every suite subdomain, so it stays), but Traefik has no router for that host, so a request 404s instead of reaching inventory-api. The absent Traefik route IS the surface closure; no DNS change is needed.

Pulls pre-built images from `ghcr.io/example-org/rop-*:main` (built by `.github/workflows/build-images.yml`). No `build:` blocks — the host pulls + runs.

## Deploy

`build-images.yml` builds on the Mac Mini runner, pushes to GHCR, then SSHes to the host and runs [`scripts/deploy-stack.sh`](../scripts/deploy-stack.sh) `<stack>` (git-sync → `docker compose -f compose/<stack>.yml [--env-file compose/<stack>.env] pull && up -d`). By hand on the host: `bash ~/restaurant-ops-platform/scripts/deploy-stack.sh <stack>`. Manual-only dispatch is unchanged ([ADR-0014](../docs/decisions/0014-manual-deploy-trigger.md)).

`docker compose -f compose/<stack>.yml config` validates a stack — this is what `validate-compose.yml` runs in CI.

## Networks

One external bridge, `rop-net` (created once with `docker network create rop-net`), carries **all** traffic — every service in every stack is single-homed on it:

- **East-west / cross-stack + intra-stack DNS** by service name (backoffice → `kds-api`/`postgres-kds`/`redis-kds`/`analytics-api`/`inventory-api`; kds-web → `kds-api`; inventory → `analytics-api`; crew → `inventory-api`; crm-worker → `redis-kds`). Replaced the old `dokploy-network` Swarm overlay.
- **Ingress** — the legacy host Traefik (host network mode) discovers each routed service here via a per-service `traefik.docker.network=rop-net` label, overriding Traefik's provider-default network, and reaches the bridge from the host routing table.

There is deliberately **no per-stack `internal` net and no `traefik-servicenet` membership** for app containers: multi-homing a container on ≥2 shared bridges makes Docker DNS return an ambiguous IP for a peer's name (the Phase-B east-west timeout), whereas single-homing every service on `rop-net` makes name→IP resolution unambiguous. See [ADR-0527](../docs/decisions/0527-collapse-to-single-app-network.md).

## Datastores

Plain compose services with named volumes + healthchecks, no published ports (reached only over the compose networks): `kds.yml` owns `postgres-kds` + `redis-kds`; `analytics.yml` owns `postgres-analytics`; `inventory.yml` owns `postgres-inventory`; `crm.yml` owns `postgres-crm`. `backoffice` has no DB of its own — it consumes the kds stack's `postgres-kds` (shared auth store) + `redis-kds` over `rop-net`, so backoffice's `DATABASE_URL`/`REDIS_URL` must match kds's.

## Env vars

Secrets are injected at container boot by the `with-infisical` entrypoint from Infisical ([ADR-0020](../docs/decisions/0020-adopt-infisical-for-runtime-secrets.md), machine identity). The host carries only a thin, gitignored per-stack env file `compose/<stack>.env` (template: [`.env.prod.example`](../.env.prod.example)) holding the Infisical machine-identity secret-zero (`INFISICAL_MACHINE_CLIENT_ID` / `_SECRET`) plus the infra URLs pointed at the local compose DNS (`postgres-kds:5432`, `redis-kds:6379`, …). Per the Infisical override rule, those infra URLs must NOT also live in Infisical (or the Infisical value wins at boot). The full per-stack list lives in `.env.prod.example`.

Cross-project hostnames (e.g. `INTERNAL_ANALYTICS_API_URL=http://analytics-api:3100`) resolve via `rop-net` bridge DNS — the name is the Compose service name in the target stack.

## Migrations

`kds.yml` has two migrate sidecars with `restart: "no"` that each run `prisma migrate deploy` once per `up`: `migrate` (`@rop/db-kds`) and `migrate-auth` (`@rop/db-auth`, [ADR-0015](../docs/decisions/0015-extract-auth-tables-into-db-auth-package.md)). Both write to the same Postgres via `DATABASE_URL`; `kds-api`/`kds-worker` `depends_on: service_completed_successfully` for both. `inventory.yml` and `crm.yml` carry their own `migrate` sidecar. The migrate image is the app image — the `prisma` CLI is a runtime dependency.

## Local development

Use [`docker-compose.dev.yml`](../docker-compose.dev.yml) (Postgres + Redis only; apps run via `pnpm dev` on the host) for the day-to-day loop. The observability stack ships separately as [`docker-compose.observability.yml`](../docker-compose.observability.yml).

The `compose/*.yml` files reference the external `rop-net` network and prebuilt GHCR images, so they target the production host, not a dev machine.
