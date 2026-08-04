# Testing

Practical reference for testing the restaurant-ops-platform suite — what the test types are, how to run them, how to write each, and what CI checks.

- **Why** it's shaped this way → [ADR-0026](decisions/0026-integration-tests-via-testcontainers.md) (unit/integration split) · [ADR-0008](decisions/0008-cutover-arm64-runner-to-mac-mini.md) (CI runners).
- **Teaching / first principles** → [LOCAL-DEV-GUIDE.md §3](LOCAL-DEV-GUIDE.md) ("separate run-the-stack from run-the-tests").
- **E2E auth specifics** → [web-ui-testing-auth.md](web-ui-testing-auth.md).

## The three test types

| Type | Command | What it is | Needs Docker? | Lives in |
| --- | --- | --- | --- | --- |
| **Unit** | `pnpm test` | Mocked, fast, per-package. The everyday inner loop. | No | `<pkg>/tests/**/*.test.ts` |
| **Integration** | `pnpm test:integration` | Real ephemeral Postgres/Redis per suite (Testcontainers). | **Yes** | `<app>/tests/integration/*.integration.test.ts` |
| **E2E** | `pnpm test:e2e` | Playwright against the built web apps. | No (built apps) | `apps/<app>/e2e/*.spec.ts` |

The two principles behind this: **tests provision their own dependencies** (no `make dev` stack, no shared DB to pollute), and the **unit loop stays Docker-free** so the inner loop is fast.

## Running tests

```bash
# Unit — mocked, fast, no Docker
pnpm test                                                   # all packages (= turbo run test); also: make test
pnpm exec turbo run test --filter=@rop/kds-api       # one package (turbo builds its deps first)

# Integration — real ephemeral Postgres/Redis (Docker must be running)
pnpm test:integration                                       # all integration suites; also: make test-integration
pnpm --filter @rop/inventory-api test:integration    # one app's integration suite

# E2E — Playwright (builds the web app first)
pnpm test:e2e                                               # kds-web + backoffice-web + crew-web; also: make e2e
pnpm --filter @rop/kds-web test:e2e                  # one web app

# The pre-merge gate
pnpm lint && pnpm build && pnpm test && pnpm docs:check     # always
pnpm test:integration                                       # when you touched a backend / DB / migration path
pnpm test:e2e                                               # when you touched a UI flow
```

`make doctor` checks the local environment (Docker, ports, built libs).

## Conventions (where things live)

- **Unit** tests sit in `<pkg>/tests/**/*.test.ts`. The default `vitest.config.ts` **excludes** `tests/integration/**`.
- **Integration** tests sit in `<app>/tests/integration/`, each app with three files: `fixture.ts` (composition), `*.integration.test.ts`, and `vitest.integration.config.ts`. The `test:integration` package script runs `vitest run --config vitest.integration.config.ts`.
- **Shared container helpers** live in repo-root [`test/containers/`](../test/containers): `startPostgres` / `startRedis` / `deployPrismaMigrations` / `runPackageScript` / `truncateAll` + `prismaSqlRunner` / `assertDockerAvailable`.
- **E2E** specs sit in `apps/<app>/e2e/*.spec.ts`.

## Writing a test

### Unit
Mock the data seam — the apps inject `services` (config + Prisma/pool) into route registration, so a test passes `vi.fn()` fakes and never touches a DB. Example: [`apps/kds-api/tests/admin-routes.test.ts`](../apps/kds-api/tests/admin-routes.test.ts).

### Integration
The fixture owns the container lifecycle; the test injects the container URL through the app's real seams (`createPrismaClient(url)`, `buildApp(services)`, `createPool(config)`) and hits routes with `app.inject()`. Pattern: `beforeAll` → start + migrate (+ seed); `afterAll` → stop; `beforeEach` → `truncate`. Hermetic — no ambient env, secrets are test constants. Worked example: [`apps/inventory-api/tests/integration/`](../apps/inventory-api/tests/integration); fuller walkthrough in [LOCAL-DEV-GUIDE.md §3 "What shipped here"](LOCAL-DEV-GUIDE.md).

```ts
// fixture.ts (sketch)
const pg = await startPostgres();
await deployPrismaMigrations("db-inventory", pg.url);
const prisma = createPrismaClient(pg.url);
const app = await buildApp({ config: testConfig(pg.url), prisma });   // inject the URL
// stop: await app.close(); await pg.stop();
```

### E2E
Playwright with a setup project that logs in once and reuses `storageState`. See [web-ui-testing-auth.md](web-ui-testing-auth.md) and [`apps/backoffice-web/e2e/auth.spec.ts`](../apps/backoffice-web/e2e/auth.spec.ts).

## What CI runs

On every PR, the `ci` job (self-hosted mac, Docker available) runs:

```
pnpm lint → pnpm build → pnpm test → pnpm test:integration → pnpm docs:check
```

Integration runs with `TESTCONTAINERS_RYUK_DISABLED=true` (the reaper sidecar can't reach the daemon on the self-hosted runners; each fixture's `afterAll` tears down explicitly). Two more jobs are path-gated: **migration-smoke** (when Prisma schemas/migrations change) and **e2e** (when a web app changes). See [`.github/workflows/ci.yml`](../.github/workflows/ci.yml).

## Current integration coverage

6 suites across 4 apps (all three migration mechanics + a full app boot + a money-path invariant):

- **inventory-api** — route-level via `buildApp` + `app.inject` over real db-inventory (real seed).
- **analytics-api** — the raw-SQL migration runner + idempotency + write/read.
- **packages/auth** — account + argon2 password + passkey persistence (Bytes/JSON/FK-cascade).
- **kds-api** — three suites: the shared db-kds + db-auth Postgres ([ADR-0015](decisions/0015-extract-auth-tables-into-db-auth-package.md)) + Redis; the full app asserting `/api/ready` (which pings both backing services); and **Clover webhook idempotency** — a re-delivered webhook must collapse to a single `clover_webhook_events` row **and** a single `kds_provider_events` row (both `fingerprint @unique` + `createMany(skipDuplicates)`), while two genuinely-distinct orders must both persist. This is the canonical example of an invariant only a real unique index can prove — a mocked Prisma cannot.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `Docker is not reachable …` on `test:integration` | Start Docker Desktop / OrbStack. Only integration tests need it; `pnpm test` does not. `make doctor` confirms. |
| `ERR_MODULE_NOT_FOUND: @rop/…/dist/index.js` | Build the workspace libs first: `pnpm exec turbo run build --filter='./packages/*'`. (Turbo's `test` tasks do this via `^build`; a bare `vitest`/`pnpm --filter X test` on a cold tree does not.) |
| First `test:integration` run is slow (~30-60s) | One-time image pull (`postgres:16-alpine`, `redis:7-alpine`). Warm runs are seconds. The per-suite cost after that is mostly the `prisma migrate deploy` subprocess. |
| "Do I need a `.env` to run tests?" | No. Integration tests generate their own container URLs and use test-constant secrets — they read no ambient env. |
