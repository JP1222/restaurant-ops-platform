# ADR-0801: notifications-api owns the operator notification domain

- **Status**: Proposed
- **Date**: 2026-06-19
- **Deciders**: @example-org

## Context

The backoffice notification system (bell dropdown, `/inbox`, and category-based
preferences) shipped in PR #798 against a **client-only `zustand` store seeded
with sample data**. That was deliberate — the design handoff listed the backend
as out of scope — but it leaves five things unbuilt, each of which needs a
server:

1. **Event store** — real notifications instead of a hard-coded array.
2. **Per-operator interaction state** — `read` / `snoozedUntil` / `dismissedAt`,
   durable and shared across that operator's devices.
3. **Preferences persistence** — per-category channels, min-severity, and quiet
   hours, **server-enforced** (quiet hours and min-severity must hold even when
   the UI isn't open; critical always bypasses quiet hours).
4. **Suggested-action backend** — the one-click operational fixes (e.g. "hide
   salmon on the customer display") MUTATE live state, so they need an
   idempotent, manager-gated, audit-logged endpoint — never a client flag.
5. **Realtime** — the bell badge and lists must update without a manual reload.

The constraints in play are the suite Iron Laws: each app owns its Postgres
(#1), cross-app DTOs flow through `packages/contracts` (#2), Floor and Backoffice
stay separate products (#4), and read/OLAP sources never become write sources
(#5). The AI investigation also touches the **lethal-trifecta** rule: it carries
model-authored text + an optional component, and the action block is a mutation
— so where it is generated and how it is rendered matters.

There is no existing notification/events service to extend — only the settings
placeholder PR #798 replaced.

## Decision

Stand up a **new `notifications-api`** (Fastify + its own `packages/db-notifications`
Prisma client), following the established single-domain-service pattern of
`crm-api` and `inventory-api`. `apps/backoffice-web` reaches it **only through BFF
route handlers** under `app/api/notifications/*`; browser code never calls it
directly (same rule as analytics/kds today).

- **Contract-first.** The cross-app DTOs land in `packages/contracts`
  (`notifications.ts`) **in this PR**, before either the service or the BFF
  exists, so both can be built in parallel against one agreed shape. This is a
  reasoned exception to the ADR-0025 "a DTO lives local until it crosses a
  boundary" default — here *both* sides are net-new, so there is no existing
  local home to promote from, and locking the wire shape first is the cheaper
  path. The wire DTO carries `createdAt`; the relative `timeLabel` and the
  `Today/Yesterday/Earlier` group stay **client-derived** (they depend on the
  viewer's clock), reusing the existing `lib/notifications/derive`.
- **Producers write in; analytics never does.** Notifications are written to
  `notifications-api` by their originating services (inventory 86/par, device
  health, integration retries) or a thin rules layer — **not** by `analytics-api`
  reaching across databases (Iron Law #5). analytics stays read-only OLAP.
- **Realtime is polling-first.** TanStack Query `refetchInterval` on the list +
  unread count. A WebSocket push is a later optimization that reuses the
  *pattern*, not kds-api's Floor event bus (Iron Law #4).
- **Suggested actions are gated server-side.** The confirm endpoint is idempotent
  on `idempotencyKey`, permission-gated to managers, and audit-logged. The UI's
  two-step confirm is UX, not the security boundary.
- **Lethal-trifecta posture.** The investigation text/blocks are generated and
  stored server-side; the action block is the *only* mutation and is
  human-confirmed + permission-gated. Notification render must keep the
  rendered-output remote-resource channel closed (no auto-loaded markdown images
  / prefetched links), as already done for the backoffice AI response surface.

## Consequences

- **New surface to wire**: a `notifications-api` app, a `db-notifications`
  package (schema + migrations + client), a compose service, a `dorny/paths-filter`
  entry, an `AGENTS.md`, and a deploy image. `ARCHITECTURE.md` gains the new
  models (doc-drift gate).
- **Operator identity**: per-operator state keys off the backoffice session; the
  BFF passes the authenticated operator id to notifications-api (an internal
  service token, like the other BFF→service calls).
- **Frontend migration is small and staged**: when the BFF lands, the existing
  `lib/notifications/sample-data` is swapped for a TanStack Query hook, and the
  local view-model maps from the contract DTO (deriving `group`/`timeLabel`).
  The components and store API stay; only the data source changes.
- **Phasing** (each its own PR; this ADR + contracts are the first):
  1. Contracts + ADR (this PR).
  2. `db-notifications` schema (notifications, per-operator state, prefs, action
     audit) + `notifications-api` read path + prefs, behind an internal token.
  3. Backoffice BFF + swap the store's source to TanStack Query (polling).
  4. Suggested-action endpoint (idempotent + manager gate + audit).
  5. First real producer (e.g. inventory par/86 → notification) + WS push.
- **Deploy stays user-gated** — none of the above ships until the manual
  `build-images.yml` is triggered.

## Alternatives considered

- **Extend `kds-api`.** It already has WebSocket fanout, Redis, and BullMQ.
  Rejected: kds-api is a **Floor** product (Iron Law #4); backoffice operator
  alerts don't belong on the kitchen service, and coupling them would blur the
  Floor/Backoffice split the suite works hard to keep.
- **`analytics-api` emits notifications.** It already computes the anomalies
  (refund spikes, margin slips). Rejected: analytics is **read-only OLAP** (Iron
  Law #5) — it can be a *signal source* a producer reads, but it must not write
  a notification store.
- **Store in `db-kds` via a backoffice carve-out** (the `app_setting` / `lib/settings`
  bounded-exception pattern). Rejected for the event store: notifications are a
  first-class **write domain** with their own lifecycle, not config rows;
  forcing them into the AI-tables exception would bloat that carve-out past its
  intent (ADR-0011/0016). Preferences alone could fit a carve-out, but splitting
  prefs from the notifications they govern across two owners is worse than one
  clean domain.
- **Keep it client-only.** Rejected: no persistence, no cross-device sync, no
  realtime, and — fatally — quiet hours / min-severity can't be *enforced* and
  suggested actions can't be *audited* from the browser.
- **Adopt a notification SaaS** (Knock / Courier / Novu). The transport (inbox +
  read-state + channel routing) is a commodity these do well. Rejected on the
  data boundary and domain ownership: they want operator + ops data in a
  third-party cloud, and the load-bearing logic here — severity rules, and
  suggested actions wired to *our* inventory/analytics — is ours to keep
  in-house. Borrow the pattern (per-user state, channel prefs, quiet hours), not
  the hosted grip.
