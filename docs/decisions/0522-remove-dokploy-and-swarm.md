# ADR-0522: Remove Dokploy and Docker Swarm for plain docker compose

- **Status**: Accepted
- **Date**: 2026-06-04
- **Deciders**: @example-org
- **Supersedes**: [ADR-0005](0005-dokploy-over-coolify.md) (Dokploy as control plane) and [ADR-0007](0007-validate-compose-env-script.md) (the Dokploy env-drift validator). Keeps [ADR-0014](0014-manual-deploy-trigger.md) (manual-deploy gate) and [ADR-0020](0020-adopt-infisical-for-runtime-secrets.md) (Infisical) — this changes the deploy *mechanism*, not those policies.

> **⚠️ Network model revised (2026-06-04).** The three-network design described
> below (per-stack `internal` + `traefik-servicenet` + `rop-net`) caused a
> multi-homed DNS ambiguity that broke east-west traffic in Phase B; it was
> collapsed to a single flat `rop-net` by [ADR-0527](0527-collapse-to-single-app-network.md).
> The "`docker swarm leave`" step in the Decision below is likewise **retracted** —
> the Oracle host shares its Swarm with other projects, so Dokploy is retired by
> removing its own stacks only.

## Context

[ADR-0005](0005-dokploy-over-coolify.md) adopted Dokploy v0.29 as a PaaS control plane on the Oracle host, primarily to give a **non-CLI teammate a UI** for deploys/logs/env and to drive deploys from CI via a typed tRPC API. Two things since erode that rationale:

1. **There is no non-CLI operator.** The single owner operates entirely through AI agents over SSH and `gh workflow run` — the Dokploy UI is never opened. ADR-0005's load-bearing justification ("non-CLI teammate path exists") no longer applies.
2. **Infisical now owns runtime secrets** ([ADR-0020](0020-adopt-infisical-for-runtime-secrets.md), live in prod via the `with-infisical` entrypoint + machine identity, PR #521). Dokploy's per-service env store — the thing [ADR-0007](0007-validate-compose-env-script.md) existed to keep from drifting — is no longer the source of truth.

What remains is cost without the original benefit: a ~500 MB control plane; a single point of failure for deploys/env edits; a second source of truth for compose YAML (Dokploy's DB vs the repo); Swarm-overlay install quirks (the `172.25.0.0/16` pool override); version lock-in to v0.29.4; container-name auto-suffixing that breaks label-free scripting; and the `validate-compose-env.py` drift bug-class. ADR-0005's "builds on prod" objection to plain compose is also gone — builds run on the Mac Mini runner since [ADR-0008](0008-cutover-arm64-runner-to-mac-mini.md). The system is not yet fully in production, so the datastores carry no data worth migrating — the cheapest possible moment to switch.

## Decision

**Remove Dokploy and Docker Swarm. Run each app as a plain `docker compose` stack on the host, deployed over SSH.**

- **Compose** — `compose-dokploy/*.yml` become self-contained `docker compose` stacks: the `dokploy-network` Swarm overlay is replaced by a shared external bridge `rop-net` for cross-stack DNS; the formerly-Dokploy-managed datastores (`postgres-kds`, `redis-kds`, `postgres-analytics`, `postgres-inventory`; staged `postgres-crm`) become plain services with named volumes; each file gets a `name:` so it is an isolated project. Traefik routing is untouched — it was always the legacy host Traefik discovering labels on the external `traefik-servicenet` bridge, independent of Dokploy.
- **Env** — secrets come from Infisical at container boot (`with-infisical`); a thin, gitignored per-stack host `.env` (see [`.env.prod.example`](../../.env.prod.example)) carries only the Infisical machine-identity secret-zero plus infra URLs pointed at the local compose DNS.
- **Deploy** — `build-images.yml` still builds on the Mac Mini and pushes to GHCR, then SSHes to the host and runs [`scripts/deploy-stack.sh`](../../scripts/deploy-stack.sh) `<stack>` (`git`-sync → `docker compose pull && up -d`) instead of POSTing a Dokploy webhook. Manual-only dispatch is unchanged ([ADR-0014](0014-manual-deploy-trigger.md)).
- **Guardrail** — the Dokploy-env-drift validator ([ADR-0007](0007-validate-compose-env-script.md)) is retired; `validate-compose.yml` now runs a Dokploy-free `docker compose config` check (catches bad YAML / undefined network refs).

This lands in two phases: **Phase A** (this PR) is the repo-side change and is inert until **Phase B** — the gated live cutover on the Oracle host (provision the host checkout + SSH key + per-stack `.env`, bring stacks up on plain compose, verify all hosts via Traefik, then remove Dokploy's own stacks — **not** `docker swarm leave`, since the host shares its Swarm with other projects ([ADR-0527](0527-collapse-to-single-app-network.md))).

## Consequences

**Makes easy:**
- One source of truth: the compose file on disk *is* the runtime definition. No sync-to-Dokploy step, no second env store.
- Agent-native operations: predictable container names (`rop-<stack>-<svc>-N`), `docker compose logs/exec/up` over SSH, no tRPC API + composeId secrets to thread.
- ~500 MB reclaimed on the host; one fewer control plane and SPOF; no Swarm install quirks; no version lock-in.

**Makes hard / accepts:**
- No deploy/log/env web UI. Acceptable — nobody used it; the backoffice Ops page still dispatches and tracks the deploy via GitHub Actions.
- Deploys depend on the host being reachable over SSH and able to `git fetch` + pull GHCR (provisioned in Phase B).
- A required runtime secret going missing now fails the app closed at boot, rather than being caught pre-deploy by the env-drift validator; the `docker compose config` check covers structural breakage only.

**New risks:**
- The host SSH key (`ORACLE_SSH_KEY`) and the Infisical machine identity become the load-bearing credentials, replacing the Dokploy API key + webhook URLs. Scope the SSH key to the deploy user.

## Alternatives considered

- **Keep Dokploy.** Rejected: its primary justification (non-CLI UI) is dead and Infisical took over its env role, leaving cost without benefit. It still works, so this is not urgent — but the env layer is already being reworked, making now the cheap moment.
- **Keep Swarm, drop only the Dokploy control plane (`docker stack deploy`).** Rejected: single-node Swarm buys nothing here and is less agent-friendly than plain compose (overlay DNS, `deploy:` semantics, weaker local parity).
- **Switch secrets to SOPS+age at the same time** (the 2026 best-fit for a solo self-hosted profile). Rejected for now: Infisical is already live in prod and sound; changing the secrets layer and the deploy platform in one move doubles the risk. Revisit independently.
