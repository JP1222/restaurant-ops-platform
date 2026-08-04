# ADR-0036: PR-time Docker image build coverage for all deployed apps

- **Status**: Accepted, then **reverted 2026-06-05** (see note below)
- **Date**: 2026-06-04
- **Deciders**: @example-org
- **Amends**: [0014-manual-deploy-trigger.md](0014-manual-deploy-trigger.md) (its "Dockerfile breakage surfaces at the next deploy dispatch, which is acceptable" stance). **Extends**: issue #216 (the `inventory-api` per-PR build pilot). **Related**: [0009](0009-pipeline-optimization-followups.md), [0026](0026-integration-tests-via-testcontainers.md), [0008](0008-cutover-arm64-runner-to-mac-mini.md), [0014-manual-deploy-trigger.md](0014-manual-deploy-trigger.md).

> **Update 2026-06-05 — reverted.** The per-PR `docker-build` matrix added by this ADR was removed from `ci.yml`. In practice the PR-time image builds added runner contention and wait on the 2-runner self-hosted pool, and for a single-owner repo that deploys manually and infrequently, ADR-0014's original stance — "a Dockerfile break surfaces at the next deploy dispatch, which is acceptable" — proved the better trade-off: `build-images.yml` fails loudly and Slack-alerts at deploy, and a `skip_deploy=true` dispatch gives an on-demand build-only check when wanted. Net: images build only at deploy again. This ADR is retained as the record of the experiment and its reasoning; its amendment to ADR-0014 is effectively undone.

## Context

The CI/CD pipeline was audited 2026-06-04 (deep research + adversarial verification) and hardened in the same session:

- the repo-wide **red CI was fixed** — Ryuk was never actually disabled because Turbo's `envMode: strict` silently stripped `TESTCONTAINERS_RYUK_DISABLED`; fixed by `turbo.json` `test:integration.passThroughEnv` (#484);
- **e2e fail-fast** (`needs: ci`) + **leaked-Testcontainers reaping** landed (#493);
- the runner topology went to **two parallel self-hosted Macs** (mac-mini-1 always-on; macbook-pro-1 a lid-open best-effort lane, normal sleep, wake-kick via `sleepwatcher`);
- backend **`typecheck` scripts** were added (#505).

With the big speed levers already captured — two runners, Turbo content-addressed cache on persistent `$HOME`, `dorny/paths-filter` job gating, `cancel-in-progress` on PRs — the audit's verified conclusion is that **the remaining high-value work is "shift-left" coverage, not raw speed**. One gap stands out:

**Only 1 of 10 deployed apps has its Docker image build validated at PR time.**

- `build-images.yml` (the manual, user-gated deploy lane — [ADR-0014](0014-manual-deploy-trigger.md)) builds **10** app images: `kds-api`, `kds-web`, `analytics-api`, `backoffice-web`, `crew-web`, `order-web`, `crm-api`, `inventory-api`, `legal-site`, `marketing-site`.
- `ci.yml` validates the Dockerfile of **only `inventory-api`** (the `docker-build-inventory-api` job, added for issue #216 as a non-blocking pilot).
- A Dockerfile or runtime-dependency break in **any of the other 9 apps** is therefore invisible until an operator manually dispatches a deploy — precisely the "surfaces at the next deploy dispatch" cost that [ADR-0014](0014-manual-deploy-trigger.md) accepted *when there was no per-PR image build at all*. Issue #216 already walked that back for one app and judged PR-time validation worth the runner time. This ADR generalizes that judgment.

The audit also surfaced two smaller optimizations and several **non-decisions** worth recording so they are not re-litigated by a future agent.

## Decision

### 1. (Primary) Extend PR-time image-build validation to every deployed app

Replace the single `docker-build-inventory-api` job in `ci.yml` with a **dynamic, path-gated matrix** `docker-build` job that:

- Computes which deployed apps changed via `dorny/paths-filter` — each app keys on its own `apps/<app>/**`, its `Dockerfile`, and the shared packages that Dockerfile `COPY`s (e.g. `packages/contracts`, `packages/db-*`). On `push: main` / `workflow_dispatch`, build all (those events are infrequent; safety margin).
- For each changed app builds **the same image `build-images.yml` ships** — `context: .`, `target: runtime`, `platforms: linux/arm64`, `push: false`, `load: false`, `provenance: false`, BuildKit local cache at `~/buildx-cache-ci/<app>` (a **separate dir** from the deploy lane's `~/buildx-cache/<app>` so a CI build can never corrupt the deploy cache).
- Respects the **two-buildkit-builds-in-one-VM OOM invariant**: `strategy.max-parallel: 2` (the same global cap `build-images.yml` uses), valid **only** under the 1-runner-per-machine topology — two concurrent legs are then guaranteed to land on two different hosts' Docker VMs. `fail-fast: false` so one app's break doesn't cancel the others.
- Prunes the buildx cache after each leg (`if: always()`) with the **whole-wipe-over-threshold** pattern only — never an mtime/age partial-delete, which orphans still-referenced blobs in the content-addressed `type=local` store (documented failure that killed an 8-app deploy, see `build-images.yml`).
- Starts **non-blocking** (`continue-on-error: true`) for ~1 week — the same soak gate issue #216 used for `inventory-api` — then is promoted to a **required check** (drop `continue-on-error`, add to branch-protection required checks).

The legacy single-app job and any `inventory-api`-specific wiring are folded into the matrix (one source of truth).

### 2. (Secondary) Evaluate Next.js Turbopack for the web-app builds

The 4 Next.js apps (`kds-web`, `backoffice-web`, `crew-web`, `order-web`) build with plain `next build` (webpack). Trial `next build --turbopack` (GA in Next 16). Adopt **per-app, only if** the produced build is correct (smoke the running app) and measurably faster. Fully reversible (drop the flag). This is the only lever that meaningfully speeds the *build* — the Fastify/Node backends are already fast `tsc`.

### 3. (Deferred, do NOT implement now) `turbo run … --affected` for integration tests

`test:integration` is `cache: false`, so it re-runs for **all** packages on every PR. `--affected` (requires `actions/checkout` `fetch-depth: 0`) would skip unaffected packages. Recorded as a future option only: the saving is small, and a full-history clone adds load on the disk-pressure-prone runners. Revisit only if integration-test wall-clock becomes a measured bottleneck.

## Explicitly NOT doing (so it is not re-proposed)

- **`actions/cache` for the pnpm store / `node_modules`** — net-negative on persistent self-hosted runners whose `$HOME` is already warm: it adds archive I/O for zero benefit and breaks pnpm's isolated-linker symlinks.
- **Turbo Remote Cache** — marginal even with two runners; the per-machine local caches are warm and there is no ephemeral-runner cold-start to solve. Not worth the cache-server / `TURBO_TOKEN` operational surface (and uploading build artifacts off-box is a needless supply-chain consideration for a single-merchant private repo).
- **CodeQL / paid security scanning** — conflicts with the deliberate no-GitHub-hosted-billing posture ([ADR-0008](0008-cutover-arm64-runner-to-mac-mini.md)); security is covered by the periodic read-only audit workflows instead.
- **Splitting the `ci` job into more parallel jobs** — on ≤2 runners this adds per-job checkout+install overhead and serializes anyway (audit-verified).

## Consequences

- A broken Dockerfile or missing runtime file in any deployed app reds the PR that introduced it, not a later deploy — the goal.
- A PR that touches an app's image inputs costs an extra ~1–2 min buildx build; path-gating means the ~99% of PRs that touch no image input skip it entirely.
- Slightly more buildx cache under `~/buildx-cache-ci/` on the runners — bounded by the per-app whole-wipe threshold, and on mac-mini-1 it lives on `/Volumes/disk` via the existing symlink (off the boot volume).
- The deploy lane (`build-images.yml`) is unchanged; its `~/buildx-cache/<app>` dir is never touched by CI.
- After the ~1-week soak, promotion to a required check means a red image build blocks merge — intended.

## Alternatives considered

- **Keep deploy-time-only validation ([ADR-0014](0014-manual-deploy-trigger.md) status quo)** — rejected: with 10 deployed apps and frequent AI-assisted self-merges, "find out at deploy" is too late, and issue #216 already judged PR-time worth it for one app.
- **One combined "build all changed images" shell step instead of a matrix** — rejected: loses per-app parallelism across the two runners and per-app cache isolation; the matrix mirrors `build-images.yml`, the proven shape.
- **Build every image on every PR regardless of paths** — rejected: wastes runner time on the ~99% of PRs that change no image input; path-gating is the established runner-economy pattern.
