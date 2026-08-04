# ADR-0527: Collapse all compose stacks onto a single flat app network

- **Status**: Accepted
- **Date**: 2026-06-04
- **Deciders**: @example-org
- **Revises the network model in** [ADR-0522](0522-remove-dokploy-and-swarm.md)

## Context

[ADR-0522](0522-remove-dokploy-and-swarm.md) removed Dokploy + Docker Swarm and
re-expressed each app as a plain `docker compose` stack. Its Phase A network
model used **three** networks:

- `rop-net` — external bridge, cross-stack DNS (replacing the
  `dokploy-network` Swarm overlay).
- `traefik-servicenet` — external bridge, where the legacy host Traefik
  discovers routing labels.
- `internal` — a per-stack bridge for intra-stack + datastore traffic.

Most app containers therefore joined **two or three** of these at once: `kds-api`
was on `internal` + `rop-net` + `traefik-servicenet`; `kds-web` on
`internal` + `traefik-servicenet`.

The Phase B live cutover surfaced an east-west outage. `kds-web` → `kds-api`
(`INTERNAL_API_BASE_URL=http://kds-api:4000`) timed out, while the same call to
`kds-api`'s `internal` IP succeeded. Root cause: **multi-homed DNS ambiguity**.
When two containers share more than one network, Docker's embedded DNS resolves
a peer's service name to an IP on *one* of the shared networks with no stable,
documented rule for which. Here it returned the `traefik-servicenet` IP — a
network the host Traefik owns for ingress and that does not carry east-west
container traffic — so the connection hung. The `kds-api` healthcheck is loopback
(`curl 127.0.0.1:4000`), so the container reported healthy and the break was
invisible until a real cross-container call was made.

This is not specific to `traefik-servicenet`. Any time two communicating
services share ≥2 networks, the resolved IP is ambiguous. The Phase A model made
that the *common* case.

## Decision

**One external bridge carries everything. Every service in every stack is
single-homed on `rop-net`.**

- Drop the per-stack `internal` network entirely.
- Drop all `traefik-servicenet` memberships from our app containers.
- Routed (public) services keep their Traefik labels but pin
  `traefik.docker.network=rop-net`, overriding Traefik's provider-default
  network (`providers.docker.network: traefik-servicenet`).

Traefik is unaffected: it runs in `host` network mode, so it reaches the
`rop-net` bridge via the host routing table exactly as it reached
`traefik-servicenet`. The per-service label is the standard Traefik mechanism for
choosing a backend's network when a container is on a non-default one.

With one network per container, Docker DNS has exactly one IP to return for any
service name — resolution is **provably unambiguous**.

## Consequences

**Makes easy:**

- East-west service-to-service calls are deterministic. The whole class of
  "resolves to the wrong network" bug is gone, not mitigated.
- One mental model: every container, every stack, one bridge. Operators and AI
  agents reason about connectivity trivially.
- Less config: −58/+28 lines across the 9 stacks; each top-level `networks:`
  block is now a single external entry.

**Makes hard / gives up:**

- **No per-stack DB network isolation.** Any container on `rop-net` can
  reach any datastore by name (`postgres-kds:5432`, etc.). This is
  defense-in-depth that mainly matters for multi-tenant or untrusted-neighbour
  hosts. For a single-merchant suite where all stacks are trusted and DBs are
  password-protected, the trade is acceptable — and it matches the prior baseline
  (Dokploy's `dokploy-network` was a single flat overlay). If multi-tenant
  isolation is ever needed, reintroduce per-tier networks carefully (each
  communicating pair must share exactly one).

**Validation gate:**

- `docker compose config` passes for all 9 stacks and there are zero dangling
  network references, but the **Traefik-label routing path is validated live at
  cutover** with `kds` as the canary (public 200 through Traefik) before the
  other 8 stacks follow.

## Alternatives considered

- **Pin DNS priority / network ordering.** Rejected. Docker doesn't expose a
  robust, documented "primary network for DNS" knob for multi-homed containers;
  relying on attachment order is fragile and silently breaks on container
  re-create. Treats the symptom, not the cause.
- **Tiered isolation** (datastores `internal`-only; apps bridge `internal`+app;
  web app-only). Keeps DB isolation and *can* be deterministic, but only if every
  communicating pair shares exactly one network — easy to get wrong across 9
  stacks, and one slip reintroduces the ambiguity. Bulletproof-by-construction
  (single net) beats correct-if-careful for a one-operator system whose stated
  goal is stability.
- **Do nothing / keep three networks.** Rejected — it's the broken state.

## Related

- [ADR-0522](0522-remove-dokploy-and-swarm.md) — Dokploy/Swarm removal; this ADR
  revises its network model.
- [ADR-0020](0020-adopt-infisical-for-runtime-secrets.md) — the `with-infisical`
  entrypoint. A sibling Phase B finding (a stale `REDIS_URL` in Infisical winning
  over the host `.env` at boot) is captured in `HANDOFF.md` §Secrets (override rule).
- `compose/README.md` §Networks — the operator-facing description.
- `docs/archive/HANDOFF-phase-closeouts.md` — phase history (the Phase B resume banner was retired when HANDOFF.md was slimmed, 2026-06-12).
