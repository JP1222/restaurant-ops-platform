# ADR-0001: pnpm monorepo with four apps

- **Status**: Accepted
- **Date**: 2026-05-09 (Phase 0 closeout)
- **Deciders**: @example-org

## Context

Before Phase 0, the Example Kitchen product was two separate Git repositories:

- `restaurant-ops-platform-KDS.git` — the kitchen display backend + web frontend
- `restaurant-ops-platform-Intelligence.git` — the Clover-to-OLAP analytics pipeline

The two had grown independently and didn't share code despite obvious overlap: both needed Clover client logic, both needed merchant-tenant scoping, both had auth (KDS had passkey/cookie, Intelligence had a bearer-token admin UI). Three concrete pains accumulated:

1. **Drift between hand-written DTOs.** A Clover order shape change required matched edits in both repos and a coordinated deploy. Twice in early 2026 the two diverged silently for weeks.
2. **Two CI pipelines, two deployment workflows, two Dockerfile sets.** Every infrastructure improvement (e.g. multi-stage builds, healthcheck patterns) had to be backported.
3. **Cross-cutting features were impossible to ship atomically.** Phase 1's Backoffice product needed both KDS data (for admin operations) and Intelligence data (for analytics). Even shipping "the new Backoffice" required a 3-repo PR dance.

A new product surface (Backoffice) was about to be built. It would need both upstream APIs. Splitting it into a third repo would have made the dance worse.

## Decision

Migrate to a single **pnpm workspace monorepo** with:

- Four apps under `apps/`:
  - `kds-api` (Fastify backend, Floor authoritative state)
  - `kds-web` (Next.js, Floor frontend)
  - `analytics-api` (Node http, OLAP ingest — replaces old Intelligence)
  - `backoffice-web` (Next.js, admin shell + BFF)
- Three shared packages under `packages/`:
  - `contracts` (Zod schemas + TS types for cross-app DTOs)
  - `db-kds` (Prisma schema + migrations + client for KDS Postgres)
  - `auth` (Passkey + session library, shared by kds-api / kds-web / backoffice-web)
- Native iOS workspace at `ios/`, owned by the same repo (Swift Package Manager, separate build system but shared `packages/contracts` codegen target).

`pnpm` chosen over `npm` workspaces for: (a) disk-efficient `node_modules/.pnpm/`, (b) strict isolation so packages can't accidentally import undeclared deps, (c) `--filter` semantics that make per-app commands ergonomic.

The migration happened in Phase 0 (2026-05-09); the production cutover to a single Docker deployment landed in the Production hardening week (2026-05-16). See the Phase 0 closeout in `docs/archive/HANDOFF-phase-closeouts.md` for the full transition record.

## Consequences

**What this makes easier:**

- **One PR for cross-cutting features.** Phase 2's BFF endpoints in `backoffice-web` calling `analytics-api` with new contracts were a single PR with all three files visible.
- **`packages/contracts` enforces DTO consistency.** A zod schema change in `contracts` immediately surfaces TS errors in every consumer. The "two-repos drifted" problem becomes a build failure.
- **One CI pipeline.** `ci.yml` runs `pnpm lint && pnpm build && pnpm test` over everything. Test counts visible in one place. Branch protection is simpler.
- **Atomic refactors.** Phase 1's auth migration (kds-api + kds-web + backoffice-web all consuming `@rop/auth`) was one PR; in two repos it would have been four PRs with a careful merge order.

**What this makes harder:**

- **Build cache complexity.** A change in `packages/contracts` invalidates all dependent app builds. Dockerfile multi-stage layouts and `pnpm-lock.yaml` coupling matter much more — see PRs #43, #44, #46 for the iterative build-cache tuning that took ~3 days to stabilize.
- **No per-app versioning.** Every commit is "the whole suite version". There's no `kds-api@2.3.1`. We accept this trade — single-merchant deployment doesn't need it.
- **CI matrix shape.** The `build-images.yml` workflow has to detect which apps changed (via `dorny/paths-filter`) and build only those — otherwise every PR rebuilds all 4 apps. See [`OPERATIONS.md` §3.3](../../OPERATIONS.md#33-build-imagesyml--the-deploy-engine).

**New risks:**

- A bad change in `packages/contracts` or `packages/db-kds` can break all 4 apps' builds simultaneously. CI catches this, but reviewers must be more careful at package boundaries.
- The Prisma schema is shared between kds-api / kds-worker / backoffice-web (which reuses auth tables). Schema migrations are coordinated through the `migrate` Compose service rather than per-app — see ADR-0002 (Iron Law #1) for why backoffice doesn't get its own Prisma client.

## Alternatives considered

- **Stay polyrepo, share via published npm packages.** Rejected. Local dev would have required `npm link` / `pnpm link` dances. The DTO drift problem only goes away if a single PR can change schema + producer + consumer atomically — published packages can't do that without a publish step in CI per PR.

- **Single Next.js app combining everything.** Rejected. KDS Floor needs a Fastify backend with WebSocket fanout and BullMQ — Next.js API routes don't fit. Analytics-api needs a 9-worker subsystem architecture — also not a Next.js fit. The right number of apps is 4, not 1.

- **Monorepo with `npm` workspaces** (not `pnpm`). Rejected. `pnpm`'s strict module isolation has caught at least two "accidentally importing transitive dep" bugs that would have been silent under `npm`. `pnpm`'s `--filter` semantics also produce shorter CI scripts.

- **Monorepo with `Nx` or `Turborepo`.** Considered. `pnpm`-only with explicit `--filter` invocations turned out to be sufficient for 4 apps; the metabuild overhead of Nx didn't pay off. Could revisit if we reach 10+ apps, but that's not on the trajectory.

## Related

- [ADR-0002: Five Iron Laws](./0002-five-iron-laws.md) — the rules that keep monorepo drift at bay.
- [ADR-0003: Floor vs Backoffice split](./0003-floor-vs-backoffice-split.md) — why `kds-web` and `backoffice-web` are *separate* apps despite both being Next.js.
