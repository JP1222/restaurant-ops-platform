# ADR-0013: Realtime assumes cloud reachability — LAN fallback is roadmap, not built

- **Status**: Proposed (roadmap / known limitation)
- **Date**: 2026-05-24
- **Deciders**: @example-org

## Context

A 2026-05 architecture review compared the Floor realtime design against mature KDS products. Example Kitchen's realtime path is sound for *short* disconnects: `kds-api` fans out over WebSocket with a server-side monotonic `seq` (`KdsRealtimeState`), clients reconnect with heartbeat + backfill-after-seq, and an outbox holds actions across brief drops (the same shape as Slack's real-time messaging and Stripe's at-least-once + reconcile model).

It is **not** resilient to a *sustained* WAN or router outage. Every path — Clover webhook → `kds-api` → WebSocket → screen — crosses the public internet. If the restaurant's uplink drops, new tickets never reach the kitchen displays, even though POS and screens are on the same LAN. Mature KDS products (e.g. Toast) survive this with an on-prem **local hub** that relays tickets device-to-device over the LAN while the cloud is unreachable. Square only added a KDS offline mode recently — i.e. this is a known-hard problem, not solved by default.

## Decision

**Record the limitation; do not build the fallback now.**

1. The current realtime architecture **explicitly assumes the cloud is reachable**. This is now stated in `ARCHITECTURE.md` §4 rather than left implicit.
2. A **LAN local-hub fallback** (a kitchen-local relay that caches and re-broadcasts ticket state to screens during WAN outage, then reconciles against `kds-api` on recovery) is the intended future direction and is captured here so the idea isn't lost.
3. It is **out of scope** at the current single-merchant, dev/staging-grade scale (this repo is not the active POS — see `ARCHITECTURE.md` §1). Revisit when Example Kitchen becomes a primary production KDS for a live kitchen.

## Consequences

- Operators and future agents have an honest statement of the failure mode instead of discovering it during an outage.
- When the fallback is built, it will need: a LAN-discoverable relay process, local persistence of recent ticket state, a device→device transport (mDNS + WebSocket/Bonjour-style), and a reconciliation pass that replays the outage window against `kds-api`'s `seq` on reconnect. Promote this ADR to Accepted and add an implementation ADR at that point.

## Alternatives considered

- **Build the LAN hub now.** Significant effort (new process, transport, persistence, reconciliation) for a resilience gain that doesn't pay off until there's a live kitchen depending on it. Deferred.
- **Accept the limitation silently.** Rejected — an undocumented "tickets vanish during an ISP outage" surprise is exactly the kind of load-bearing assumption an ADR should surface.
- **Third-party local-first sync engine** (PowerSync, ElectricSQL) for the read path. Worth evaluating when the fallback is built, but these target offline *writes* / large catalogs; a server-authoritative KDS with short-lived ticket state has a narrower need. Note for future evaluation, not a decision.
