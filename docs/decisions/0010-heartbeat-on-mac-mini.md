# ADR-0010: Heartbeat monitoring on Mac Mini (replacing GH Actions cron)

- **Status**: Accepted
- **Date**: 2026-05-20
- **Deciders**: @example-org

> **Update 2026-05-28:** Ops alert transport migrated **Discord → Slack** (team
> standardized on Slack). The heartbeat *architecture* below is unchanged — only
> the webhook URL, the env/secret (`DISCORD_WEBHOOK_URL` → `SLACK_WEBHOOK_URL`),
> and the message payload moved. Inline references are updated in place; per the
> ADR convention this ADR is amended, not deleted.

## Context

The previous heartbeat monitor was a `.github/workflows/container-health.yml` GitHub Actions cron scheduled every 5 minutes (added 2026-05-20 to close the 22-hour blind spot from the postgres-analytics outage). Two days of operating it surfaced three problems:

1. **GH free-tier cron drift.** Actual fire times observed: 08:17, 11:22, 14:02 UTC — i.e. ~2–3 hours apart, not 5 minutes. GitHub explicitly states scheduled workflows on lower-priority repos may be delayed up to an hour, and for a heartbeat alarm that's a non-starter.
2. **Burned the GH Actions budget.** At 30 s per run × 12 runs/h × 24 h × 30 d the worst case is ~4,320 minutes/month against a 2,000-minute free quota — enough to exhaust the budget by itself, which is exactly what happened. The cascading consequence was that when budget ran out, *all* CI also stopped, including the budget-exhaustion blocker. The monitoring infrastructure was coupled to the same budget as the thing it monitored — a textbook anti-pattern.
3. **Insufficient coverage.** The workflow only probed three public HTTPS endpoints. Of the four real failures on 2026-05-20 (analytics-api DNS, kds-worker-1 OOM, kds-worker-2 Redis MISCONF, brief disk-full), only the analytics-api crash would even have been visible from outside — and the cron didn't fire in time to catch it.

## Decision

Move the heartbeat to a launchd job on the Mac Mini that's already running the GHA arm64 build runners (see [ADR-0008](./0008-cutover-arm64-runner-to-mac-mini.md)). Concretely:

- `scripts/heartbeat/heartbeat.py` — single Python file, no external deps beyond stdlib + `curl` + `ssh`.
  - **L1**: HTTPS probes of `backoffice.example.com`, `kds.example.com`, `analytics.example.com/admin`. 2xx/3xx = healthy.
  - **L2**: SSH to Oracle, parse `docker ps -a`, verify the expected services (backoffice-web / kds-api / kds-web / kds-worker×2 / analytics-api) each have the required count of containers in the `Up` state.
- `scripts/heartbeat/com.example.heartbeat.plist.template` — launchd LaunchAgent fires every 60 s under the user `example`.
- `scripts/heartbeat/setup-heartbeat.sh` — idempotent installer; renders the plist, drops the Slack webhook URL into `~/rop-heartbeat/.env` (chmod 600), `launchctl load`s the agent.
- State persists in `~/rop-heartbeat/state.json`. Slack is posted only on `healthy ↔ unhealthy` transitions (plus a one-time "discovered already unhealthy" alert on first run), not every minute of failure — eliminates spam.

Mac Mini was chosen over Oracle (the prod host) because the monitor and the prod services should not share a fate. Mac Mini was chosen over a free SaaS (UptimeRobot / Healthchecks.io) on operator preference — the existing trust in the Mac Mini hardware + reluctance to introduce another vendor outweighed the residential-ISP false-positive risk (single-merchant scale, alarms can be ignored manually if home WiFi flakes).

## Consequences

**Makes easy:**

- **Reliable cadence.** launchd `StartInterval: 60` is millisecond-precise. No GH scheduler drift.
- **Zero GH Actions minutes.** The biggest line item is gone; CI budget rebuilds for actual CI.
- **Both layers, one tool.** L1 (public HTTP) and L2 (container state) live in the same probe pass with shared state and shared transition logic.
- **No additional infrastructure.** The Mac Mini is already running 2 GHA runners and was already trusted.

**Makes hard:**

- **Mac Mini outage = monitor outage.** If the Mac Mini sleeps, reboots, or loses power, the heartbeat goes quiet. Mitigation: `pmset` already configured to suppress sleep ([ADR-0008](./0008-cutover-arm64-runner-to-mac-mini.md)). Operator has accepted the residual risk (a true watchdog was evaluated and declined — see Alternatives considered).
- **Residential ISP shares fate with the monitor.** If the Mac Mini's network goes down, public HTTPS probes will fail-closed and Slack will alarm even though prod is fine. The L2 SSH probes will also fail. Mitigation: operator acknowledges this and accepts occasional false alarms on home network flake.
- **SSH dependency.** L2 probes need outbound SSH to Oracle. If 1Password's ssh-agent is locked or the runner key rotates, L2 silently degrades to "unknown". Mitigation: launchd env explicitly lists `IdentityFile` paths via `~/.ssh/config`; the runner key is committed to the path setup in `scripts/setup-mac-runner.sh`.

**Removed costs:**

- `.github/workflows/container-health.yml` deleted; this PR is the removal.
- The ~$35/month-worst-case GH Actions metering exposure is gone.

## Layered alerting model going forward

| Layer | Where | What | Status |
|---|---|---|---|
| L1 — public liveness | Mac Mini, `heartbeat.py` | "can users reach these URLs?" | **shipped here** |
| L2 — container state | Mac Mini → Oracle SSH | "are the containers up?" | **shipped here** |
| L3 — data flow / business correctness | Oracle, `ops_heartbeats` + `ops_jobs` tables (already written by analytics-api) | "is new data still being ingested?" | exists; needs alarm wiring |
| L4 — dead-man's switch | external | "is the Mac Mini itself dead?" | **Declined 2026-05-21** — see Alternatives considered |

L3 doesn't need new infra — analytics-api already maintains `ops_heartbeats`. A follow-up either teaches analytics-api itself to post to Slack when its own checks go stale, or extends `heartbeat.py` to also SSH+psql the freshness query. Tracked in ADR-0009.

## Alternatives considered

- **Run on Oracle.** Cleanest for L2/L3 (loopback / docker socket), but Oracle being both the monitor and the monitored is the failure mode that triggered all this. Rejected.
- **UptimeRobot / Healthchecks.io free tier as L4 dead-man's switch.** Truly independent (different cloud, different ISP, different power grid), zero maintenance. **Declined 2026-05-21** on operator preference — period/grace/integration config burden plus reluctance to introduce another vendor outweighs the residual Mac-Mini-could-die risk at single-merchant scale. Alarms can be ignored manually if home Wi-Fi flakes. If L4 ever becomes needed (e.g. moving from single-merchant to multi-store, or after a real Mac-Mini-died incident), revisit using one of:
  - **GitHub Actions scheduled workflow** — pings the heartbeat agent on Mac Mini (or queries Slack for the most-recent heartbeat post) and alerts on staleness. Free tier minutes are no longer the constraint they were when we removed `container-health.yml` (we have a $4 hard cap; a 1-minute weekly check is trivial).
  - **Cloudflare Workers cron** — same idea, runs on Cloudflare's infrastructure (already in the DNS path for `*.example.com`), no extra vendor relationship needed. Free tier covers up to 100k requests/day.

  Both are lower-config than Healthchecks.io because they don't need a separately-configured grace/period/integration model — just "ping URL X, if response stale, alert".
- **A daemon container on Oracle.** Same fate-sharing problem as cron-on-Oracle. Adds operational surface (another container to manage) with no benefit over cron. Rejected.
- **Keep `container-health.yml` but reduce cron frequency.** Doesn't fix the GH cron drift problem, doesn't fix the budget coupling. Rejected.

## Related

- [ADR-0008](./0008-cutover-arm64-runner-to-mac-mini.md) — Mac Mini runner cutover (the hardware substrate this leverages)
- [ADR-0009](./0009-pipeline-optimization-followups.md) — backlog where L3 follow-up is tracked (L4 was declined; see Alternatives above)
- [`scripts/heartbeat/`](../../scripts/heartbeat/) — implementation
