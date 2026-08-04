# Database Agents (Notifications)

`packages/db-notifications` owns the Prisma schema, migration history, and
database client for the **operator notification** domain (the events surfaced in
the backoffice bell / inbox, per-operator read/snooze/dismiss state, and delivery
preferences). It is a sibling of `packages/db-kds` / `packages/db-inventory` /
`packages/db-crm`, not a replacement: per Iron Law 1 each app owns its own
Postgres database, and the notifications domain picks its own here
(`NOTIFICATIONS_DATABASE_URL`). See [ADR-0801](../../docs/decisions/0801-notifications-api-owns-the-operator-notification-domain.md).

The generated Prisma client is emitted to a package-local path
(`generated/client`, gitignored) and re-exported from `src/index.ts`, so it never
collides with the other domain clients in the shared `node_modules/@prisma/client`
location.

Use these checks when relevant:

- `pnpm --filter @rop/db-notifications generate`
- `pnpm --filter @rop/db-notifications build`
- `pnpm --filter @rop/db-notifications migrate`         # dev migration
- `pnpm --filter @rop/db-notifications migrate:deploy`  # apply baseline in CI/prod

Do:

- **Keep enum values aligned with `@rop/contracts`.** `NotificationSeverity`,
  `NotificationCategory`, and `NotificationMinSeverity` use the exact wire strings
  (`crit`/`warn`/`info`, `sales`/`inv`/…, `all`/`warn`/`crit`) so routes need no
  enum⇄DTO mapping. Changing one without the other breaks the boundary.
- **Treat `Notification` as a producer-written event** and `NotificationState` as
  the per-operator overlay (absent row = unread / not snoozed / not dismissed).
  Key state by the backoffice operator id the BFF supplies — never import db-auth.
  `Notification.dedupeKey` is the producer-ingest idempotency anchor (UNIQUE,
  nullable): a producer passes a stable key (e.g. `inv:86:<itemId>`) so a retry or
  a repeated signal returns the existing row instead of a duplicate; null = an
  always-create notification.
- Store the AI investigation as JSON (`Notification.ai`); validate its shape with
  the contract `AiInvestigationSchema` at the route boundary, not in the column.
- **Treat `NotificationActionAudit` as append-only.** The apply-action endpoint
  INSERTs one row per applied suggested action, deduped by the UNIQUE
  `idempotencyKey` (a repeated confirm collides → "already_applied", never a
  double-apply). It also records `operatorId` + `operatorRole` (the BFF's stamped
  claims). Never UPDATE or DELETE these rows.
- Keep migrations explicit and reviewable; document compatibility + rollback when
  changing existing shapes.

Do not:

- Cross-import this client into another app's service (Iron Law 1, eslint-enforced).
  **Only `apps/notifications-api` consumes it**; every other app (backoffice BFF
  included) reaches it over HTTP.
- Add columns for client-only presentation state — the relative `timeLabel` and
  the `Today/Yesterday/Earlier` group are derived client-side from `createdAt`.
- `DELETE` notifications to clear an operator's view — that is what
  `NotificationState.dismissedAt` is for (per-operator archive).
