# ADR-0008: Cutover arm64 GHA runner from Oracle to Mac Mini

- **Status**: Accepted (label rename 2026-05-27 — see Update below)
- **Date**: 2026-05-19
- **Deciders**: @example-org

## Update 2026-05-27: runner label rename `macmini` → `mac`

The original decision below labeled the runners `macmini` to hard-lock scheduling away from Oracle. Oracle is gone (decommissioned per this ADR), and we now operate runners on **both** a Mac Mini and one or more MacBooks. There is no operational reason to distinguish them at the workflow level — any macOS arm64 runner can pick up any job.

All `runs-on: [self-hosted, macmini]` lines are rewritten to `runs-on: [self-hosted, mac]`. `scripts/setup-mac-runner.sh` now registers new runners with label `mac` by default. The "Hard lock" rationale below is preserved as historical context; the new lock target is the `mac` label, which excludes any future Linux self-hosted runner just as effectively (Oracle, the only past Linux runner, no longer exists as a runner).

Migration: existing runners on the Mac Mini need the `mac` label added (they can keep `macmini` simultaneously during transition). After the workflows merge, the `macmini`-only labels can be removed.

## Context

[ADR-0006](./0006-self-hosted-arm64-runner.md) put the self-hosted GitHub Actions arm64 runner on the Oracle Ampere A1 production VM. Build times for backoffice-web dropped from 40-60 min (QEMU on hosted x86) to ~5-10 min (native arm64). That decision was sound for the constraints at the time.

Two costs surfaced over the following months:

1. **Single point of failure.** The Oracle box ran production AND CI. A bad build that OOM'd the host could destabilize Dokploy and the running KDS / backoffice / analytics services. The `concurrency:` group bounded the worst case but did not eliminate it.

2. **Cache disk pressure.** `/home/actions-runner/buildx-cache/<app>/` grew unbounded. After ~3 months it was at 24 GB, ~10% of the Oracle root disk. `docker buildx prune` was a manual ~monthly chore.

A Mac Mini M4 (10-core CPU, 24 GB RAM, NVMe) was already on hand and idle. Hosting two GHA runners on it costs nothing extra electrically and gives us full isolation between build and production.

## Decision

Migrate the self-hosted arm64 runner pool from Oracle to Mac Mini:

1. Provision **two** GHA runners on the Mac Mini as user-level macOS LaunchAgents (`actions.runner.example-org-restaurant-ops-platform.mac-mini-{1,2}`). Labels: `[self-hosted, ARM64, macOS, macmini]`.
2. Change `build-images.yml` `runs-on:` from `[self-hosted, arm64]` (which matched both Oracle and Mac Mini) to `[self-hosted, macmini]`. Hard lock — prevents any future re-registration on Oracle from silently taking build jobs.
3. Unregister the three Oracle runners (`oracle-arm64`, `oracle-arm64-2`, `oracle-arm64-3`) and `userdel -r actions-runner` on the Oracle host to reclaim 24 GB.

### macOS-specific quirks fixed during cutover

GHA runners as LaunchAgents on macOS hit a Keychain isolation issue. `docker-credential-osxkeychain` (installed by OrbStack at `/usr/local/bin/`) requires an Aqua security session to write the Keychain; launchd-spawned jobs lack that session and fail `errSecInteractionNotAllowed (-25308)`. Mitigation (runner-host-local, not committed to this repo; bootstrap via [`scripts/setup-mac-runner.sh`](../../scripts/setup-mac-runner.sh)):

- A plain-file credential helper at `~/runner-bin/docker-credential-osxkeychain` shadows the OrbStack binary in the runner PATH.
- The runner PATH is set in three places that all need updating: the LaunchAgent plist `EnvironmentVariables`, the runner workspace `.path` file (read by `runsvc.sh`), and the runner workspace `.env` file (injected into job-step env by `Runner.Listener`).
- The helper returns empty creds + exit 0 for unknown registries so `buildkit` treats the lookup as anonymous (the standard "exit 1 + stderr 'credentials not found'" idiom that docker CLI handles gracefully is treated as fatal by buildkit-in-container).
- The helper's `erase` command is intentionally a no-op. Both runners run as the same OS user (`example`) and share `~/.docker/runner-creds/`. When one job's "Post Log in to GHCR" runs `docker logout` → helper `erase` → file removed, an in-flight `buildx` push on the other runner suddenly has no creds and dies with a 403 "anonymous token". The next `docker login` rewrites the file regardless, so erase has no cleanup value. Discovered 2026-05-20 when backoffice-web (the slowest job) was the only one consistently catching the race.

Documented here for the next operator who has to redo it on a fresh Mac.

### Measured build times (after cutover)

`workflow_dispatch force_all=true` on `main`, run [26140863797](https://github.com/example-org/restaurant-ops-platform/actions/runs/26140863797) (warm buildx cache):

| App | Mac Mini (M4) | Oracle Ampere baseline (ADR-0006) | Speedup |
|---|---|---|---|
| kds-api | 43 s | ~2 min | ~2.8× |
| kds-web | 43 s | ~3 min | ~4.2× |
| analytics-api | 30 s | ~2 min | ~4× |
| backoffice-web | 73 s | 5–10 min | ~4–8× |
| **Wall clock (4 in parallel)** | **~2 min 14 s** | ~10 min | **~4.5×** |

Caveats: warm cache; cold-cache numbers are 2–3× higher per app. The "~4–8×" backoffice-web win comes from native arm64 (no QEMU) and the M4's better single-core perf compared to the Ampere A1's 4 cores.

## Consequences

**Makes easy:**

- Production stays isolated. Build OOM cannot affect KDS / backoffice / analytics.
- Faster builds. M4 + NVMe → 4-app cold-cache build in ~4 min, warm-cache builds in seconds-to-minutes per app.
- More effective parallelism. 2 runners on one machine accept 2 concurrent jobs without the Oracle 4-vCPU contention.
- Buildx cache lives on Mac Mini disk — fast SSD, no Oracle disk pressure.

**Makes hard:**

- Build host is a workstation. If the Mac Mini reboots / sleeps, builds queue until it comes back. LaunchAgents auto-start on login.
- Home internet bandwidth gates GHCR push speed. Layer cache helps; cold cross-region pushes can be slower than Oracle's data-center bandwidth. Acceptable at current image sizes.
- One physical machine. If the Mac Mini dies, all GHA arm64 builds queue indefinitely. Acceptable for a single-merchant project; recovery path is to register a fallback runner elsewhere and revert the `runs-on:` lock.

**Removed costs:**

- Runner token rotation no longer co-located with production.
- Buildx cache pressure on Oracle is gone (24 GB reclaimed).
- `actions-runner` user and its docker-group membership removed from production host — one less local account with write access to the docker socket on a prod box.

## Alternatives considered

- **Pay for GitHub-hosted arm64 runners.** ~$32/month at current build volume. Rejected for the same reason as in ADR-0006: idle hardware on hand.
- **Keep Oracle runner as fallback.** Initially planned. Dropped because the whole point was isolation; an idle-but-registered Oracle runner is one "fallback please" event away from re-introducing the OOM risk. The hard-lock to the `macmini` label is the explicit guard against accidental regression.
- **Run the runner inside a Linux VM on Mac Mini.** OrbStack VM gives Linux-native runner semantics and avoids macOS launchd / keychain quirks. Deferred — the launchd-on-macOS path works once the credential-helper shim is in place, and a VM adds operational surface.

## Related

- [ADR-0006](./0006-self-hosted-arm64-runner.md) — original self-hosted arm64 decision (now superseded).
- [`.github/workflows/build-images.yml`](../../.github/workflows/build-images.yml) — the `runs-on:` value is the binding contract.
