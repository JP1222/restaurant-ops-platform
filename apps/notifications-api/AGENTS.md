# Notifications API Agents

`apps/notifications-api` is the Fastify backend for the **operator notification**
domain — the events surfaced in the backoffice bell / inbox, per-operator
read/snooze/dismiss state, and delivery preferences. It owns its own Postgres via
`packages/db-notifications` (Iron Law 1; [ADR-0801](../../docs/decisions/0801-notifications-api-owns-the-operator-notification-domain.md)).
Port 4400.

**Status — Phase 5a (producer ingest) done; deploy artifacts staged.** Built:
the list endpoint (global notifications overlaid with operator state), mark-read /
dismiss / snooze / read-all / archive-read, get/update preferences (Phase 2), the
backoffice BFF + frontend data-source swap (Phase 3), the manager-gated, idempotent,
audit-logged **apply-action endpoint** `POST /api/notifications/:id/actions/apply`
(Phase 4), and the **producer ingest endpoint** `POST /api/notifications/ingest`
(Phase 5a) — bearer-guarded (no operator; a server-to-server producer call),
contract-validated, idempotent on `dedupeKey` (a retry / repeated signal returns
the existing row, never a dup). The cross-app DTOs live in `@rop/contracts`
([#801](https://github.com/example-org/restaurant-ops-platform/pull/801)). **Producers** now write
(Phase 5b/5c — inventory-api emits 86 up/down + low-stock on waste / count /
sales-depletion). The **realtime SSE stream** `GET /api/notifications/stream` is also
built: ingest publishes each newly-created notification to an in-process bus
(`lib/event-bus.ts`, single-process — see its Redis-when-scaled-out caveat) and the
stream pushes it to every connected operator as an `event: notification` frame; the
remaining piece is the backoffice swap from the 30s poll to that stream. Route logic
is unit-tested with a mocked Prisma (the SSE happy-path — a long-lived hijacked
stream — rests on a real-env check, like the BFF round-trip). The apply endpoint
validates the request against the notification's own stored action (actionId +
idempotencyKey must match); ingest dedupes on `dedupeKey` — neither can be driven
into a bad state.

**Deploy is user-gated** (artifacts STAGED, not provisioned): the `Dockerfile`,
the `build-images.yml` matrix entry, and `compose/notifications.yml` (one image,
one HTTP service — no worker, internal-only over `rop-net`) now exist and
mirror crm-api, but nothing is deployed. Remaining go-live steps (the owner's):
provision the `postgres-notifications` volume + the host `compose/notifications.env`
(`NOTIFICATIONS_DATABASE_URL`), set a `NOTIFICATIONS_INTERNAL_TOKEN` shared with
backoffice, flip the backoffice BFF on by setting `INTERNAL_NOTIFICATIONS_API_URL`
+ that token in `compose/backoffice.env`, then trigger `build-images.yml`. Until
the backoffice URL is set the bell stays on its sample seed (BFF returns 503).
(db-notifications is already in the CI migration smoke-test.)

Use these checks when relevant:

- `pnpm --filter @rop/notifications-api build`
- `pnpm --filter @rop/notifications-api typecheck`
- `pnpm --filter @rop/notifications-api lint`
- `pnpm --filter @rop/notifications-api test`

## Hard rules

1. **Only this app imports `@rop/db-notifications`** (Iron Law 1,
   eslint-enforced). Every other app — the backoffice BFF included — reaches this
   service over HTTP. Never import db-auth / db-kds / argon2.
2. **Cross-app DTOs come from `@rop/contracts`** (Iron Law 2). Validate
   request bodies with the contract schemas (`SnoozeRequestSchema`,
   `UpdatePrefsRequestSchema`); shape responses to `NotificationListResponse` /
   `NotificationPrefs`. No hand-written boundary DTOs.
3. **Bearer-guarded, operator-scoped.** Every `/api/notifications` route requires
   the BFF's `NOTIFICATIONS_INTERNAL_TOKEN` and fails closed in production. The
   operator identity arrives in the `x-operator-id` header (the BFF stamps it from
   its session) — this app never resolves operators itself. The manager gate on
   the apply-action endpoint likewise trusts `x-operator-role` (the BFF stamps the
   session role; `OWNER`/`MANAGER`/legacy `ADMIN` pass). The authoritative RBAC
   `can()` check belongs in the BFF; this server-side gate is the coarse backstop
   + the value the audit row records.
4. **Server enforces preferences.** Quiet hours and min-severity are honored
   server-side; critical alerts always reach in-app regardless. The two-step
   confirm for suggested actions (Phase 4) is UX — the real gate (idempotency,
   manager permission, audit) is server-side.
5. **Structured logs only** (Fastify/pino). Never log bearer tokens or full
   request bodies. `print`/`console.log` are out.
6. No TypeScript `any` — `unknown` + narrow. Stored AI JSON is re-validated with
   `AiInvestigationSchema` at the read boundary, never cast blindly.

## Layout

- `src/config.ts` — zod-validated env (`NOTIFICATIONS_*`).
- `src/lib/services.ts` — the one db-notifications client constructor.
- `src/lib/operator.ts` — `x-operator-id` extraction.
- `src/domain/` — defaults (category metadata + default prefs) and the DB↔DTO map.
- `src/routes/` — health, notifications (list + state), prefs.
