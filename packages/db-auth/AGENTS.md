# Auth DB Agents

`packages/db-auth` owns the Prisma schema, migrations, and client for the
auth tables (`web_admin_accounts`, `web_authn_credentials`,
`tenant_memberships` + the `WebAdminRole` enum). See [ADR-0015](../../docs/decisions/0015-extract-auth-tables-into-db-auth-package.md)
for why these tables were split out of `@rop/db-kds`.

`tenant_memberships` (`TenantMembership`, [ADR-0818](../../docs/decisions/0818-multi-tenant-platform-architecture.md)
Phase 2) is the *tenant* axis of access — which tenant(s) an account belongs to
and its role within each. It stays in this package because it is auth identity
(account ↔ tenant ↔ role), not domain data; `tenantId` is a bare un-FK'd string
(the `Tenant` table lives in db-kds; Iron Law 1). Additive + backfilled to
`tenant-default` today — **nothing reads it yet**; the fail-closed,
membership-validated session rewrite that consumes it is the next Phase-2 step
(see [docs/multi-tenant-migration-roadmap.md](../../docs/multi-tenant-migration-roadmap.md)).

The physical database is the same Postgres that hosts `db-kds`; only the
Prisma package boundary changed. Both packages connect via the same
`DATABASE_URL`. The split exists so `packages/auth` does not depend on
`db-kds`, which makes Iron Law #3 (auth boundary) machine-enforceable.

Use these checks when relevant:

- `pnpm --filter @rop/db-auth generate`
- `pnpm --filter @rop/db-auth build`
- `pnpm --filter @rop/db-auth lint`

Do:

- Keep this schema minimal — only auth identity / credential tables.
- Treat the baseline migration as idempotent. New migrations should be
  forward-only diffs from the baseline state.
- Coordinate any change with `packages/auth` and the documented
  ADR-0015 carve-outs: the kds-api auth surface
  (`apps/kds-api/src/lib/services.ts`,
  `apps/kds-api/src/lib/admin-user-service.ts`,
  `apps/kds-api/src/routes/auth.ts`) and the backoffice BFF auth dir
  (`apps/backoffice-web/lib/auth/**`).

Do not:

- Add tables here that aren't part of the auth identity boundary
  (sessions live in Redis, not Postgres; the AI assistant has its own
  tables in `db-kds` under the ADR-0011 carve-out).
- Import `@rop/db-auth` from anywhere outside `packages/auth/**`
  or the documented ADR-0015 carve-outs (the kds-api auth surface and
  `apps/backoffice-web/lib/auth/**`). The ESLint boundary enforces this:
  the carve-out file lists live in `eslint.config.mjs` and
  `apps/backoffice-web/eslint.config.mjs` (the shared rule builders are
  in `eslint.boundaries.mjs`).
