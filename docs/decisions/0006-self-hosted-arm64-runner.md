# ADR-0006: Self-hosted arm64 GHA runner on Oracle

- **Status**: Superseded by [ADR-0008](./0008-cutover-arm64-runner-to-mac-mini.md) (2026-05-19)
- **Date**: 2026-05-17 (PR #41 merged)
- **Deciders**: @example-org

## Context

GitHub's free-tier hosted runners are x86_64. Example Kitchen's production runs on Oracle Ampere A1 (ARM). The Docker images need to be `linux/arm64`. Pre-PR-41, `build-images.yml` cross-compiled to arm64 via QEMU emulation on the hosted x86 runner:

```yaml
- uses: docker/setup-qemu-action@v3
- uses: docker/setup-buildx-action@v3
- uses: docker/build-push-action@v5
  with:
    platforms: linux/arm64
```

Build times under QEMU on `ubuntu-latest`:

| App | QEMU build | Why so slow |
|---|---|---|
| kds-api | ~12 min | Prisma client + native modules (argon2, bcrypt) |
| kds-web | ~8 min | Next.js bundle + image opt + native sharp |
| analytics-api | ~6 min | Smaller surface, fewer native deps |
| **backoffice-web** | **40–60 min** | Next.js 16 + Tailwind v4 + shadcn/ui + `@node-rs/argon2` + Prisma engine all rebuilding under emulation |

backoffice-web's 40–60 minute build dominated the CI cycle. PR feedback loops were measured in hours. Worse, it was deceptively fast on local Mac (Apple Silicon = native arm64) — author iteration was fast, then PR push waited 40+ minutes for the same code to rebuild.

Three options on the table:
1. **Optimize Dockerfile / cache** for QEMU. We did this iteratively (PRs #43, #44, #46 — Turbopack, multi-stage cache, layer ordering). Got backoffice-web from 60 min down to ~40 min. Hit a floor where further wins required micro-fixes with diminishing returns.
2. **Pay for GitHub-hosted arm64 runners.** Available on paid plans. Out of budget for a single-merchant project.
3. **Self-hosted arm64 runner on Oracle.** Native arm64 = no QEMU = build at full speed.

## Decision

Provision a **self-hosted GitHub Actions runner on the Oracle production host**, labeled `[self-hosted, arm64, oracle]`. Switch `build-images.yml`'s `build` job to `runs-on: [self-hosted, arm64, oracle]`. Drop the `docker/setup-qemu-action@v3` step.

Implementation captured in `infrastructure/dokploy/FUTURE_IMPROVEMENTS.md` §1 (file removed with Dokploy, 2026-06-04) and shipped in PR #41 (`ci(build): switch arm64 builds to self-hosted Oracle runner`).

Additional touches:
- **Build cache lives on Oracle local disk** (`/home/actions-runner/buildx-cache/<app>/`) rather than GHA's cache service. Avoids the 10 GB per-repo cap and the network round-trip to GitHub for cache push/pull. Persists across runs because `svc.sh` teardown doesn't `rm` it.
- **`cancel-in-progress: false`** in the workflow's `concurrency:` block. The Oracle box has 4 vCPU / 24 GB RAM; running concurrent builds of the same app would thrash. Better to queue.

## Consequences

**Makes easy:**

- **backoffice-web builds in ~5–10 min** (was 40–60). The slowest CI step is no longer the bottleneck. PR cycle time dropped from "hour" to "single coffee".
- **Other apps similarly faster.** kds-api ~2 min, kds-web ~3 min, analytics-api ~2 min. The `build-images.yml` end-to-end (all 4 apps in parallel) is under 10 min worst case.
- **Local build cache is huge.** Layer cache hits on subsequent builds are near-instant. A typo fix that re-runs the same Dockerfile finishes in ~30s.
- **No QEMU rebuilds of native modules.** `@node-rs/argon2`, `sharp`, Prisma engine all compile natively. Previously these were the long tail of slow steps.

**Makes hard:**

- **Single point of failure.** The Oracle box hosts both production AND CI. A bad build that OOMs can destabilize production. We mitigate with `concurrency:` (one build per ref) and by not running builds during high-traffic windows (kitchen rush isn't on this box but the principle stands).
- **Runner token rotation.** GitHub runner tokens expire (every 60 days for org-level, configurable). If the token expires unnoticed, builds queue indefinitely. No alerting today — relies on someone noticing. Captured in FUTURE_IMPROVEMENTS as a risk.
- **Cache disk grows unbounded.** `/home/actions-runner/buildx-cache/<app>/` grows with each unique build context. We `docker buildx prune` manually when disk usage gets uncomfortable. Could automate, haven't.
- **Forks can't run CI.** Self-hosted runners by default only run jobs from the repo owner's branches (good — security). Dependabot PRs work because they're from the same repo. External-fork PRs would not get CI runs without manual intervention. We accept this since the project isn't OSS-accepting-PRs.

**New risks:**

- **Runner host = prod host.** If a build OOMs the host, production goes down. Memory budget after observability stack: ~14–16 GB free. Four parallel builds at ~2–3 GB each = 8–12 GB peak. Fits, but it's not infinite headroom. The `concurrency:` group serializes runs of `build-images.yml` per ref, which bounds the peak.
- **Disk fill on cache.** Less acute than memory but real.
- **A compromised runner = compromised prod.** Anyone with merge rights to `main` can run arbitrary code on the production host via the workflow. Mitigated by branch protection (admin-only merge after CI green) — see [`.github/BRANCH_PROTECTION.md`](../../.github/BRANCH_PROTECTION.md).

## Alternatives considered

- **Pay for GitHub-hosted arm64 runners.** Costs ~$0.16/min for the larger arm64 SKUs. At ~10 min × ~20 builds/week = ~200 min/week = ~$32/month. Defensible at this scale but felt unwarranted when we have an idle ARM box already running production. Reconsider if Oracle-box capacity becomes a constraint or if we'd rather pay for predictable isolation.

- **Separate ARM CI host (small dedicated box).** Would eliminate the "single point of failure" concern. Costs ~$5–15/month for a small ARM VM elsewhere. Deferred — felt premature for a single-merchant project. The risk profile is acceptable for now.

- **Keep QEMU + accept the 40-min builds.** Rejected at the cost of developer iteration. The build time was a daily-felt friction; the migration paid back in <1 week.

- **Cross-compile via Bazel / build-isolated arm64 chroot.** Considered briefly. Too much infrastructure for the size of the project; not on the trajectory of any other tooling we use.

- **GitHub-hosted x86 for tests + self-hosted ARM only for image builds.** This is approximately what we settled on: `ci.yml` (lint, build, test) runs on `ubuntu-latest`; `build-images.yml` runs on `[self-hosted, arm64, oracle]`. The split mirrors the workloads — tests don't care about arch, image builds do.

## Related

- [ADR-0005: Dokploy v0.29 chosen over Coolify v4](./0005-dokploy-over-coolify.md) — context for why the build target is arm64 (Oracle Ampere) at all.
- [`OPERATIONS.md` §2.10](../../OPERATIONS.md#210-provision-the-self-hosted-arm64-runner) — operator-facing setup instructions.
- `infrastructure/dokploy/FUTURE_IMPROVEMENTS.md` §1 (file removed with Dokploy, 2026-06-04) — design notes pre-implementation.
