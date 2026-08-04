# ADR-0015: Extract auth tables into packages/db-auth

- **Status**: Accepted
- **Date**: 2026-05-26
- **Deciders**: @example-org

## Context

Iron Law #3 (auth boundary) keeps password / passkey / session logic in
`packages/auth`. Iron Law #1 (DB boundary) keeps each app's database client
behind its own package. Combining them implies that `packages/auth` should own
the auth schema, not import it from another app's DB package.

Today the auth tables (`WebAdminAccount`, `WebAuthnCredential`, enum
`WebAdminRole`) live in `packages/db-kds/prisma/schema.prisma`. As a result:

- `packages/auth/src/server/*` imports `@rop/db-kds` for the Prisma
  client and the model types.
- `apps/backoffice-web/lib/auth/service.ts` constructs the auth Prisma client
  via `@rop/db-kds`, inside the [ADR-0011](0011-ai-tables-bounded-exception.md)
  `lib/auth/**` ESLint carve-out.
- The remaining `lib/ai/**` carve-out in ADR-0011 is the genuine documented
  exception (AI tables co-located in the KDS Postgres). The `lib/auth/**`
  carve-out is only there because the auth tables haven't been split into
  their own Prisma package yet.
- Any future consumer that wants only `packages/auth`'s argon2 / session
  primitives transitively pulls in `db-kds`, which is what forced PR #92 to
  add a `tsconfig.crew.json` + `build:crew` workaround so a crew-only
  backend could build without `db-kds` in its Docker context.

Iron Law #3 is therefore partially honor-system: the centralized auth
*library* is enforced (only `packages/auth` may import `@node-rs/argon2`),
but the *data ownership* line still runs through KDS's database package.

## Decision

Create `packages/db-auth/` owning only the auth tables. Both `kds-api` and
`backoffice-web` keep pointing their auth Prisma client at the same
`DATABASE_URL` they use today (the shared KDS Postgres). The split is
between *Prisma packages*, not *Postgres instances*; the physical rows do
not move.

1. `packages/db-auth/prisma/schema.prisma` contains `WebAdminAccount`,
   `WebAuthnCredential`, and `WebAdminRole` — no other models. Same default
   `public` schema as today.
2. `packages/db-kds/prisma/schema.prisma` drops those three definitions.
   The existing `20260422_web_auth_passkeys` migration folder STAYS in
   db-kds — removing it would break `prisma migrate deploy` on existing
   environments (mismatch with the `_prisma_migrations` row). No
   destructive `DROP TABLE` migration is added; the tables stay physically
   in Postgres, claimed by db-auth's Prisma schema going forward.
3. `packages/auth/src/server/*` and tests import from `@rop/db-auth`.
   `packages/auth` no longer depends on `@rop/db-kds`.
4. `apps/backoffice-web/lib/auth/service.ts` constructs the auth Prisma
   client through `@rop/db-auth`. The remaining db-kds use is the
   AI path under `lib/ai/**`, retained under the narrower ADR-0011
   carve-out.
5. `apps/kds-api/src/lib/services.ts` instantiates a second Prisma client
   (`db-auth`) and hands it to `createWebAuthService`. The KDS prisma
   client stays for tickets / merchants / sync. Sessions are low-throughput;
   the extra connection pool is acceptable at single-merchant scale.
6. `eslint.config.mjs` (root) and the per-app eslint configs narrow the
   backoffice `db-kds` carve-out down to `lib/ai/**` only. ADR-0011 is
   amended accordingly.
7. A new boundary lint rule: `@rop/db-auth` is importable only from
   `packages/auth/**`, the kds-api auth surface (`src/lib/services.ts`,
   `src/lib/admin-user-service.ts`, `src/routes/auth.ts`), and
   `apps/backoffice-web/lib/auth/**`. Anywhere else fails the build. This
   is what makes Iron Law #3 machine-enforced end-to-end.
8. `scripts/check-doc-drift.sh` learns about db-auth's schema (drops the
   two auth models from db-kds's `known_models`, gains a corresponding
   list for db-auth; adds `packages/db-auth/AGENTS.md` to the AGENTS
   coverage check).
9. `ARCHITECTURE.md` adds a db-auth row to §2.2; §5.1's "same tables in
   `postgres-kds`" wording updates to call out the db-auth Prisma package
   as the schema owner.

## Migration approach

**Chosen approach: idempotent baseline migration in db-auth.**

db-auth's `prisma/migrations/<TS>_initial/migration.sql` is a hand-crafted
SQL script using `CREATE TABLE IF NOT EXISTS`, guarded `CREATE TYPE`, and
guarded `ADD CONSTRAINT`. It runs cleanly in both deployment shapes:

- **Existing environments** (production, staging, every developer with a
  long-lived Postgres) — the auth tables and enum already exist from
  db-kds's `20260422_web_auth_passkeys` migration. The baseline's `IF NOT
  EXISTS` guards make every statement a no-op. After Prisma records the
  baseline as applied (in db-auth's row of `_prisma_migrations`), db-auth
  owns the tables going forward.
- **Fresh clones** (CI ephemeral Postgres, new developer machines) — the
  tables don't exist yet. The baseline creates them. The (also-baselined)
  `20260422_web_auth_passkeys` row in db-kds's migration folder is no
  longer needed since db-kds's schema doesn't claim those tables — but
  the folder must remain in place so `prisma migrate deploy --schema=
  db-kds/...` doesn't trip on a missing entry already recorded in any
  pre-existing `_prisma_migrations`.

The single shared `_prisma_migrations` table is fine because db-kds and
db-auth's baselines reference disjoint migration names. Both packages
have their own `prisma/migrations/` directory and Prisma scopes its
folder/row comparison per `--schema` invocation.

### Why not multi-schema (Postgres `auth` schema)?

The architecturally cleanest separation would put db-auth's tables in a
Postgres `auth` schema with `multiSchema`. It was considered and rejected
for this ADR:

- Requires a one-time `ALTER TABLE ... SET SCHEMA auth` + `ALTER TYPE ...
  SET SCHEMA auth` on prod, which needs a no-writes window during
  cutover.
- Splits `_prisma_migrations` only if db-auth's connection sets
  `?schema=auth`, which means env-var divergence or a wrapper that
  rewrites the connection string.
- Doesn't measurably help the eventual multi-merchant DB-per-tenant
  split — that work is `pg_dump` + restore either way.

The package boundary (this ADR) delivers >95% of the value. The
schema-namespace separation can layer on top later if needed without
re-touching app code; it would just be an additional migration in
db-auth.

## Production rollout

`compose-dokploy/kds.yml` gains a second migrate sidecar `migrate-auth`:

```yaml
migrate-auth:
  image: ghcr.io/example-org/rop-kds-api:main
  pull_policy: always
  restart: "no"
  environment:
    DATABASE_URL: ${DATABASE_URL}
  command:
    - node_modules/.pnpm/node_modules/.bin/prisma
    - migrate
    - deploy
    - --schema
    - node_modules/@rop/db-auth/prisma/schema.prisma
```

`kds-api` and `kds-worker` add `depends_on: { migrate-auth: { condition:
service_completed_successfully } }` alongside the existing dependency on
the db-kds `migrate` sidecar. Order: both migrate sidecars run, both
must complete, then app containers start.

The same kds-api image is reused (it already has `prisma` available and
ships db-auth's compiled schema as a workspace dependency), so no
second image build is required.

`compose-dokploy/backoffice.yml` does NOT gain a migrate sidecar.
backoffice continues to rely on kds-api's sidecars running first, as it
does today for db-kds.

## Consequences

- ADR-0011's `lib/auth/**` carve-out retires. The remaining AI carve-out
  is the only documented exception, narrowed accordingly.
- `packages/auth` no longer transitively depends on `@rop/db-kds`.
  PR #92's `tsconfig.crew.json` + `build:crew` workaround becomes
  unnecessary; when that PR rebases onto this change, the workaround
  should be removed.
- Apps that touch auth carry two Prisma clients against the same
  Postgres (KDS pool + auth pool). At single-merchant scale (~10 idle
  conns per pool) this is negligible. Flag if it becomes a hot-path
  concern.
- Iron Law #3 becomes fully machine-enforced: only `packages/auth`,
  `apps/kds-api/src/lib/services.ts`, and `apps/backoffice-web/lib/auth/**`
  may touch `@rop/db-auth`; only `packages/auth` may import
  `@node-rs/argon2`. Both rules live in `eslint.config.mjs` /
  `eslint.boundaries.mjs`.
- db-kds's `20260422_web_auth_passkeys` migration folder is retained as
  historical truth. db-kds's Prisma client no longer surfaces the auth
  model types.

## Alternatives considered

- **Status quo.** Keep the auth tables in db-kds and keep the lint
  carve-out. Rejected — Iron Law #3 remains partially honor-system, and
  every consumer of `packages/auth` keeps an unnecessary transitive
  dependency on `db-kds`.
- **Move auth to a physically separate Postgres.** Cleanest long-term
  shape (essential for multi-merchant), but disproportionate at
  single-merchant scale: new DB provisioning, second pool per app, env
  wiring, real data migration. Deferred. This ADR's package split makes
  the future DB split a Prisma config change, not a structural refactor.
- **Multi-schema (Postgres `auth` schema).** See "Why not multi-schema"
  above. Rejected for now; can layer on later without re-touching app
  code.
- **Move only types into a `db-shared-types` package, keep schema in
  db-kds.** Solves the awkward import line but not the architectural
  ownership question. Rejected — the issue is that *db-kds* claims the
  schema, not that the *type* import is awkward.

## Future work (out of scope here)

- AI tables (Phase 7) — analogous split into `db-ai` (or co-locate in a
  future `db-backoffice`). Separate ADR.
- Multi-merchant: move `postgres-auth` to its own instance. This ADR is
  the prerequisite.
- If `auth` tables ever grow access-pattern-distinct enough to warrant
  schema namespacing, layer the multi-schema migration on top — db-auth
  is the right home for that work.
