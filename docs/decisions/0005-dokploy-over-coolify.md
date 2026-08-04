# ADR-0005: Dokploy v0.29 chosen over Coolify v4

- **Status**: Superseded by [ADR-0522](0522-remove-dokploy-and-swarm.md)
- **Date**: 2026-05-18 (migration complete)
- **Deciders**: @example-org

## Context

The Example Kitchen suite needed a PaaS-like control plane on the Oracle ARM box that could:

- Manage Docker Compose stacks (4 apps in 3 stacks).
- Manage managed resources (Postgres × 2, Redis × 1).
- Provide a UI for non-CLI operators (the user's teammate, per project memory).
- Be drivable from CI (for env var sync, webhook redeploy).
- Run on ARM (Oracle Ampere A1).

Three sequential states preceded this decision:

1. **Pre-2026-05-16: pure docker-compose + SSH.** GitHub Actions workflow SSHed into Oracle, ran `git pull && docker compose -f docker-compose*.yml up -d --build`. Fragile. Builds happened on the production host (resource contention with running containers). No UI for the non-CLI teammate.

2. **Brief Coolify v4 deployment.** Coolify offered a clean UI and supported compose imports. Was operated for ~2 weeks. Two pain points emerged:
   - **Memory footprint**: Coolify's control plane (web + worker + DB + container engine wrapper) consumed ~1.5 GB RAM at idle on a 24 GB box. Acceptable in absolute terms but disproportionate for the value delivered.
   - **Opaque app model**: Coolify wrapped compose with its own "Application" abstraction. Edits to compose files round-tripped through their UI editor (lossy formatting), and the API was REST-style without a consistent typed schema.
   - **Healthcheck quirk**: Coolify required `curl` in the runtime image to satisfy its healthcheck, even when the app exposed `/healthz` directly. Slim base images had to ship curl. See [memory: `coolify_healthcheck_curl.md`](https://github.com/example-org/restaurant-ops-platform/blob/main/.claude/notes/coolify_healthcheck.md).

3. **Migration evaluation, Phase 5 / Phase 6 (2026-05-16 → 2026-05-18).** Compared three options: stay on Coolify, migrate to Dokploy, or revert to pure docker-compose + SSH with a thinner UI add-on.

## Decision

Migrate to **Dokploy v0.29.4** as the production control plane. Completed 2026-05-18.

Concrete deployment shape:
- One Dokploy instance at `dokploy.example.com`.
- Three Compose stacks (`kds`, `analytics`, `backoffice`) imported from `compose-dokploy/*.yml` via raw paste.
- Managed resources (`postgres-kds`, `postgres-analytics`, `redis-kds`) provisioned through Dokploy UI.
- Dokploy's bundled Traefik **disabled** (`docker service rm dokploy-traefik`) — we use the pre-existing legacy host Traefik instead.
- Swarm overlay pool overridden to `172.25.0.0/16` because Oracle's VPC uses `10.0.0.0/8` (the default Docker overlay pool, which would have collided).
- CI integration via tRPC: `sync-compose-to-dokploy.yml` uploads YAML changes, `build-images.yml` fires `compose.deploy` webhooks, `validate-compose-env.py` reads compose env state via API (see ADR-0007).

## Consequences

**Makes easy:**

- **Lower idle footprint.** ~500 MB control plane vs ~1.5 GB. The 1 GB recovered fits the observability stack (~1.5 GB) with room to spare on a 24 GB box.
- **tRPC API driveable from CI.** Every operation has a typed endpoint. `compose.update`, `compose.deploy`, `compose.saveEnvironment`, `compose.one` are stable and discoverable. The `sync-compose-to-dokploy.yml` and `build-images.yml` Dokploy webhook integration were ~30 minutes of work each.
- **Clean compose import.** YAML is stored verbatim in Dokploy's DB; no UI editor rewriting. Edit `compose-dokploy/*.yml` in the repo, push, sync workflow uploads it.
- **First-class managed Postgres / Redis resources.** Spin up, connect, view credentials — all UI. Backup-to-S3 hooks built in (we haven't enabled them yet — see FUTURE_IMPROVEMENTS §3).
- **Non-CLI teammate path exists.** Operations like "deploy", "view logs", "restart container", "edit env var" are all UI buttons.

**Makes hard:**

- **Install quirks are real.** The `172.25.0.0/16` swarm pool override is a tripwire. The `docker service rm dokploy-traefik` step is required and undocumented in Dokploy's main docs. Both are captured in [`OPERATIONS.md` §2.2](../../OPERATIONS.md#22-install-dokploy) so the next install doesn't relearn them.
- **Dokploy auto-suffixes compose project names.** Container names become `rop-kds-vebjpo-kds-api-1` instead of plain `rop-kds-api-1`. Any script that hard-codes a container name has to use label-based discovery instead. Documented in [`OPERATIONS.md` §4.4](../../OPERATIONS.md#44-view-logs).
- **Compose env edits don't auto-deploy.** Dokploy treats env changes as deploy-time inputs but doesn't trigger a redeploy on edit. CI workflows have to fire a separate `compose.deploy` call. We treat this as a feature (avoid surprise restarts) but it's a sharp edge for first-time users.
- **The `validate-compose-env.py` class of bug.** Dokploy stores env in its own DB; compose YAML in the repo references `${VAR}`. Drift between the two is a real production failure mode — see ADR-0007.

**New risks:**

- **Single control plane.** If Dokploy goes down, env edits and deploys are blocked. Containers keep running (they're plain Docker), but until Dokploy is back, the only fix is direct host `docker compose` operations. The DR scenario is documented in [`OPERATIONS.md` §8.4](../../OPERATIONS.md#84-dokploy-control-plane-down).
- **Dokploy version lock-in for tRPC schema.** We pin v0.29.4 because the tRPC route shape can change between minor versions. Upgrades need to be tested against `sync-compose-to-dokploy.yml` and `validate-compose-env.py` together.

## Alternatives considered

- **Stay on Coolify v4.** Rejected. The 1.5 GB idle RAM was acceptable but the opaque app model + REST-y API made CI integration awkward. The future where we wanted typed `compose.update` calls didn't fit Coolify.

- **Revert to pure docker-compose + SSH.** Rejected. Builds-on-prod was fragile; the non-CLI teammate had no path to operate the system. The SSH pipeline ran for ~2 weeks (PR #41-era) and accumulated five hot-patches before this migration.

- **Kubernetes (k3s on Oracle).** Considered. Rejected as massive overkill for one operator, three compose stacks, two databases. Kubernetes' value at this scale is negative — the operational complexity dwarfs the benefit.

- **Portainer.** Considered. UI-focused but no first-class compose-from-git workflow, no managed resources, no typed API. Better than Coolify in some ways but the Dokploy tRPC API was the deciding factor.

- **CapRover.** Considered briefly. Docker-Compose support is bolted-on; the primary model is "one app per build". Doesn't fit our 3-stack shape cleanly.

## Migration notes

The migration spanned three weekends, captured in:
- `docs/archive/HANDOFF-deployment-2026-05-16.md` — pre-Coolify state and the SSH-deploy era.
- `.github/DOKPLOY_RUNBOOK.md` (removed with Dokploy, 2026-06-04) — post-migration operational reference.
- Memory notes: [`dokploy_setup.md`](https://github.com/example-org/restaurant-ops-platform/blob/main/.claude/notes/dokploy_setup.md), [`traefik_cloudflare_setup.md`](https://github.com/example-org/restaurant-ops-platform/blob/main/.claude/notes/traefik_cloudflare_setup.md).

Key migration learnings (preserved here because they don't naturally belong in any other doc):

1. **Swarm overlay pool conflict** is the single most surprising install gotcha. Easy to miss because Docker doesn't error — it just produces a broken network silently.
2. **Disable `dokploy-traefik`** matters even if you don't notice it competing — it claims port 80/443 if started, breaking the legacy Traefik silently.
3. **`autoDeploy=false`** is useful pre-cutover to verify the stack without exposing it. The webhook returns HTTP 400 in this state; `build-images.yml` treats that as success.

## Related

- [`OPERATIONS.md`](../../OPERATIONS.md) §§2–4 — operational details.
- [ADR-0007: validate-compose-env.py guardrail](./0007-validate-compose-env-script.md) — addresses the env-drift risk that came with Dokploy's separated env store.
- `infrastructure/dokploy/FUTURE_IMPROVEMENTS.md` (removed with Dokploy, 2026-06-04) — backups, observability migration, token sync.
