# ADR-0009: Pipeline optimization follow-ups (not-yet-decided list)

- **Status**: Proposed (not yet decided)
- **Date**: 2026-05-20
- **Deciders**: @example-org

## Context

The Mac Mini cutover (ADR-0008) made the pipeline ~4.5× faster. Doing autonomous end-to-end smoke runs surfaced several lower-impact optimization candidates that aren't worth blocking the dashboard PR on but should not be lost. Listed here so future work has a backlog instead of starting from scratch.

Numbers below are from run [26140863797](https://github.com/example-org/restaurant-ops-platform/actions/runs/26140863797) and adjacent runs on 2026-05-20.

## Candidates

### 1. Per-runner buildx cache locality

**Current**: each runner keeps its own `~/buildx-cache/<app>/` directory. When `mac-mini-1` builds `backoffice-web` then the next change to that app lands on `mac-mini-2`, we cold-rebuild. Worst case: ~73 s × 2 = effective 73 s with 50% probability instead of 5 s warm.

**Options**:

- **Pin app → runner in the matrix.** Add a `runs-on:` per matrix entry so each app sticks. Cuts parallelism (4 apps × 2 runners = parallel only when 2 apps change at once, vs current 2 concurrent). Probably a net loss given most pushes touch 1 app.
- **Shared cache via NFS or SMB between the two runners.** Network filesystem race conditions on buildx cache are gnarly. Decline.
- **Cache layer push to GHCR.** Add `cache-to: type=registry,ref=ghcr.io/.../<app>-buildcache,mode=max`. Both runners pull the same cache; cost is ~10–50 MB extra GHCR push per build. Recommended.

**Decision pending**: cache-to-registry is the cleanest. Defer until we see a real cold-cache pain point.

### 2. Cache-export step failing → fails the whole build

**Current**: `cache-to: type=local,...` runs after push. If the cache write fails (disk full, permission), the step exits non-zero even though the image already shipped to GHCR.

**Fix**: split into two steps; cache-to has `continue-on-error: true`. Or move cache-to into a `post:` step. The fix is mechanical; only do it once we observe a real failure.

### 3. Node 20 deprecation in checkout/buildx/login actions

**Current**: Build log warns `actions/checkout@v4`, `docker/build-push-action@v5`, `docker/login-action@v3`, `docker/setup-buildx-action@v3` run on Node 20 and "may not work as expected" after 2026-06-02. Node 20 fully removed 2026-09-16.

**Fix**: bump to next major (most have a Node 24 compatible release by 2026-Q2). Schedule a sweep before 2026-09-16.

### 4. paths-filter false positives on `pnpm-lock.yaml`

**Current**: every filter list includes `pnpm-lock.yaml`. A single-dep bump for `kds-web` triggers a rebuild of all four apps.

**Fix options**:

- Use lockfile-diff to detect which workspace packages actually changed deps and surface those as filter outputs. Custom Action work.
- Accept the false positives. Cost on Mac Mini: ~2 min wall clock vs ~30 s for a single-app rebuild. Tolerable.

**Recommendation**: defer until lock-file churn outpaces app churn (it doesn't today).

### 5. Add a 3rd Mac Mini runner

**Current**: 2 runners on one machine. 4 apps in matrix → max 2 concurrent. Backoffice-web build still gates the wall-clock total (~75 s alone).

**Cost**: free, same machine. Adds a 3rd actions-runner-3 + plist. Trivial.

**Benefit**: bring the 4-app parallel build from ~2 min 14 s to ~1 min 30 s on cold cache. Marginal.

**Recommendation**: do it if the queue contention becomes visible. Today it isn't.

### 6. Dokploy webhook does NOT fire on `workflow_dispatch`

**Current**: build-images.yml's redeploy step gates on `github.event_name == 'push' && github.ref == 'refs/heads/main'`. Re-running a failed deploy via UI re-runs the build but does NOT trigger Dokploy.

**Fix**: extend the gate to `(github.event_name == 'push' || github.event_name == 'workflow_dispatch') && github.ref == 'refs/heads/main'`.

**Recommendation**: ship this. Low risk, high "ops convenience" return. Not done in PR #68 to keep scope contained.

### 7. Per-app build duration sparkline on the dashboard

**Current**: the new Pipeline dashboard shows the latest run's per-job duration. Trend over time is invisible.

**Fix**: add a small recharts sparkline next to each app row showing the last 10 build durations. GH Actions API gives us this for free.

**Recommendation**: post-MVP enhancement.

### 8. Harden auth on the existing `/api/ops/*` endpoints

**Current**: The existing `/api/ops/{overview,jobs,webhooks,database}` routes do not check session — they rely on Traefik + the `(authed)` page group to keep traffic out. The new `/api/ops/pipeline/*` routes added with the dashboard call `requireSession()` explicitly; the older ones don't, and they expose sync-health metrics, job logs, and database storage info.

**Fix**: a one-line `requireSession(request)` at the top of each. Risk: trivial. Reason it isn't bundled here: the dashboard PR was already touching 18 files; punted to keep blast radius small.

**Recommendation**: do this in a tiny follow-up PR labelled `chore(sec)`.

### 9. Add buildx cache hit-ratio surfacing

**Current**: cache hits / misses are buried in the buildkit logs.

**Fix**: a build step that greps buildkit output for `CACHED` step count and emits it as a job summary metric the dashboard can show. Tells the operator when cache cold-starts are happening.

**Recommendation**: post-MVP.

## Related

- [ADR-0008](./0008-cutover-arm64-runner-to-mac-mini.md) — cutover that made this faster pipeline possible
- `build-images.yml` — single source of truth for runner & cache
