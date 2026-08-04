# ADR-0026: Integration tests via Testcontainers (split unit vs integration)

- **Status:** Accepted
- **Date:** 2026-05-30
- **Related:** ADR-0008 (self-hosted mac runners — the RYUK carve-out below), ADR-0015 (db-kds + db-auth share one Postgres — the migrate ordering this reproduces), `docs/LOCAL-DEV-GUIDE.md` ("Writing an integration test")

## Context

After the Phase 1 local-dev overhaul (PR #292) every one of the ~117 Vitest files was still an **in-memory mock** — Prisma hand-mocked with `vi.fn()`, analytics' `pg.Pool` faked inline, web `fetch` spied. The *only* integration slot was a permanent `describe.skip` in `packages/auth/tests/server/prisma-integration.test.ts`. Nothing exercised a real database, so schema/app drift could only be caught by the bash `migration-smoke` CI job — which runs `prisma migrate status`, not real app code. Three distinct migration mechanics (db-kds + db-auth sharing one Postgres per ADR-0015; db-inventory; analytics' home-grown raw-SQL runner) had zero runtime coverage.

We framed the goal as **"tests ≠ stack"**: a test should bring up whatever it needs and tear it down, never assume a pre-started `make dev` stack or a shared dev database it could pollute.

## Decision

Adopt **Testcontainers** (`@testcontainers/postgresql`, `@testcontainers/redis`) for integration tests, and **split the unit and integration lanes**:

| Lane | Command | What it is | Docker? |
|---|---|---|---|
| Unit | `pnpm test` (`turbo run test`) | mocked, fast inner loop — unchanged | no |
| Integration | `pnpm test:integration` (`turbo run test:integration`) | real ephemeral Postgres/Redis per suite | yes |

Both run in CI; only the integration lane needs Docker. Keeping them separate preserves a fast, Docker-free inner loop (the test pyramid — many cheap unit tests, fewer real-DB tests).

### Shape
- Generic container helpers live in repo-root `test/containers/` (`startPostgres`, `startRedis`, `deployPrismaMigrations`, `runPackageScript`, `truncateAll`/`prismaSqlRunner`, `assertDockerAvailable`).
- Each app/package owns `tests/integration/fixture.ts` (app-specific composition) + `*.integration.test.ts`, plus a `vitest.integration.config.ts`. The default `vitest.config.ts` excludes `tests/integration/**` so the unit lane never touches Docker.
- **Fixture-in-`beforeAll`, not `globalSetup`** (a refinement of the blueprint): each test file owns one container via `beforeAll`/`afterAll`. Simpler and more robust than `globalSetup`+`provide/inject` — no worker-serialization, no shared-DB truncation races, and it sidesteps the apps' eager-module-load env coupling entirely. `globalSetup` + DB-per-worker is the documented scaling path if a single app grows many integration files.
- **Hermetic.** Tests inject the container URL through existing seams (`createPrismaClient(url)`, `buildApp(services)`, `createPool(config)`, `runMigrations(pool)`); secrets are test-local constants. No ambient env is read, so CI needs zero secret wiring for this step.
- **`prisma migrate deploy`, not `db push`** — reproduces the real, versioned migration path (including db-kds-then-db-auth against one URL, exactly as `migration-smoke` and prod do).

### Proof set
Four apps / five suites cover all three migration mechanics + both integration shapes:
- `apps/inventory-api` — route-level via `buildApp` + `app.inject` (db-inventory Prisma, real seed).
- `apps/analytics-api` — the raw-SQL runner + idempotency + write/read.
- `packages/auth` — replaces the `describe.skip`: account + argon2 password + passkey persistence (Bytes/JSON/FK-cascade).
- `apps/kds-api` — two suites: the ADR-0015 shared-DB mechanic (db-kds + db-auth in one Postgres) + the Redis helper, and a full-app suite that boots `createServices` → `buildApp` over real PG+Redis and asserts `/api/ready` (which pings both).

### CI
A single step in the existing `ci` job (self-hosted mac, Docker present): `pnpm test:integration` with `TESTCONTAINERS_RYUK_DISABLED=true`. Ryuk (Testcontainers' reaper sidecar) can't reach the Docker daemon from the self-hosted runner context (ADR-0008), so it's disabled; each fixture's `afterAll` does explicit teardown instead. No GitHub-hosted runner is added, so the runner policy is unaffected.

## Consequences

- **Positive:** real schema + app code is exercised on every PR; the skipped placeholder is now a real test; all three migration mechanics are covered; tests are self-contained (no `make dev` prerequisite, no shared-DB pollution); the warm suite runs in ~9s.
- **Cost:** integration tests require Docker (by design, opt-in). First run pulls `postgres:16-alpine` / `redis:7-alpine` (one-time, ~30-60s); warm runs are seconds. The dominant per-suite cost for the Prisma apps is the `pnpm exec prisma migrate deploy` **subprocess spawn** (~3-5s), not the container — the documented optimization path is a migrated **template DB** (`PostgreSqlContainer.snapshot()`/`restoreSnapshot()`) or a longer-lived migrated container once suite count grows.
- **kds-api full-app coverage (landed):** beyond the client/service shared-DB + Redis suite, a full `createServices` → `buildApp` HTTP suite boots the real app over live PG+Redis and asserts `/api/ready` (which pings both). Clean teardown relies on `app.close()`'s onClose hook — `RealtimeHub.start` only `psubscribe`s (no timers), so there's no BullMQ / pub-sub leak to hang the runner.
