# Observability stack

Grafana (dashboards) + Prometheus (metrics) + Loki (logs) + Promtail (log
shipper) on Oracle, deployed via `docker-compose.observability.yml`. App-side
error tracking goes to **Sentry SaaS** (`sentry.io`, org `restaurant-ops-platform`, 6
projects — one per app) per [ADR-0014](../docs/decisions/0014-sentry-saas-over-glitchtip.md). See
docs/phase-5b-sentry-saas-integration.md
for the SDK integration details. Server DSNs are injected at runtime from
Infisical via the `with-infisical` entrypoint (ADR-0020); **browser DSNs are
baked at build time** from GitHub `*_SENTRY_DSN` secrets and are **live on the
4 Next apps** (kds-web, backoffice-web, crew-web, order-web).

## Surfaces

| URL | What | Login |
|---|---|---|
| https://sentry.io/organizations/example-org | Sentry SaaS — app-side error tracking (6 projects, one per app) | Sentry SSO via GitHub |
| https://metrics.example.com | Grafana — dashboards over Prometheus + Loki | `admin` / `GRAFANA_ADMIN_PASSWORD` from `.env.observability` |

Prometheus and Loki run inside the observability network and are NOT
publicly routed. Query them through Grafana (it proxies to them
internally).

## Querying errors as an agent (MCP read-paths)

Both planes are queryable by an AI agent — **which path depends on the error
class.** Getting this wrong (e.g. trusting an empty Sentry) sends you on a
wrong turn.

| Error class | Source | How an agent queries it |
|---|---|---|
| **Server-side** — handled errors returned as 5xx, timeouts, any structured app log | **Loki** (complete — every container's stdout is shipped) | **Grafana MCP**, datasource uid `loki`: `{service="<app>"}` (label values are the bare app names — `crew-web`, `backoffice-web`, `kds-api`, …); `count_over_time(...)` for rates. No MCP? `ssh oracle` + Grafana Explore. |
| **Browser / client crash** — white screen, JS error on a customer or floor device | **Sentry** (the ONLY source — a crash on someone else's device never reaches the host's stdout, so Loki cannot see it) | **Sentry MCP** — `find_projects` → `search_issues` / `search_events` per app. Browser DSNs are live on kds-web, backoffice-web, crew-web, order-web. |
| **"Slow, but nothing thrown"** — latency, queue depth, liveness | **Prometheus** | **Grafana MCP** (PromQL) or Grafana Explore. |

**Two traps that cause wrong conclusions:**

1. **A Sentry "no issues" is NOT "no errors."** Handled errors (`try/catch` →
   HTTP 5xx + `logger.error`) are logged to Loki but never auto-captured by
   Sentry. Always cross-check an empty Sentry against Loki before concluding
   "no errors."
2. **The error often surfaces in a *different* app's backend than the one
   showing the symptom.** A crew-web invoice-scan failure ("Servicio no
   disponible") is logged in **backoffice** under scope
   `backoffice.api.inventory.receipt-parse` — crew-web's own log is clean.
   Follow the call chain to the service that actually does the work.

MCP access runs against the **public** Grafana (`metrics.example.com`,
scoped service-account token) + the Sentry SaaS API — neither requires exposing
the internal Loki/Prometheus.

## First-time setup

1. **SSH to Oracle and create `.env.observability`** (one-time only):
   ```bash
   ssh oracle
   cd ~/restaurant-ops-platform
   cp .env.observability.example .env.observability
   nano .env.observability
   ```
   Fill in the Grafana admin password. Suggested generator:
   ```bash
   openssl rand -base64 24   # GRAFANA_ADMIN_PASSWORD
   ```

2. **Deploy via SSH on Oracle**:
   ```bash
   ssh oracle
   cd ~/restaurant-ops-platform
   docker compose -f docker-compose.observability.yml --env-file .env.observability up -d
   ```
   First deploy takes 3-5 min (image pull).
   The observability stack is its own standalone `docker-compose` project on
   the Oracle host, separate from the app stacks under `compose/`.

3. **App-side error tracking → Sentry SaaS.** The 6 Sentry projects
   (`kds-api`, `kds-web`, `analytics-api`, `backoffice-web`, `crew-web`,
   `order-web`) live in org `restaurant-ops-platform`; server-side DSNs are injected at
   container boot from Infisical via the `with-infisical` entrypoint (ADR-0020).
   Browser DSNs are baked at build time from GitHub `*_SENTRY_DSN` secrets. See
   docs/phase-5b-sentry-saas-integration.md
   for the SDK wiring + rotation procedure.

4. **Log into Grafana** at https://metrics.example.com
   Prometheus and Loki are auto-provisioned as data sources.
   You'll see the Targets page populated and `up=1` for the scraped targets
   (kds-api, analytics-api, the postgres exporters, redis-kds, node). A target
   sitting at `up=0` for >2m fires the `TargetDown` alert (see Liveness
   alerting).

## Daily ops

### "Something is wrong in production"

For agents, the MCP query paths + the two traps are in [Querying errors as an
agent](#querying-errors-as-an-agent-mcp-read-paths) above. The symptom map:

| Symptom | Where to look |
|---|---|
| Uncaught exception / browser crash | **Sentry** (sentry.io, org `restaurant-ops-platform`) — stack trace + release. Agents: Sentry MCP |
| Handled 5xx / timeout / "why did the scan/job fail" | **Loki** — the handled-error log lives here, NOT Sentry. Agents: Grafana MCP `{service="<app>"}` |
| App slow, no errors thrown | Grafana → Explore → Prometheus → `up`, kdsQueueDepth |
| "What did X log around N:NN" | Grafana → Explore → Loki → `{service="kds-api"}` (or `{container="rop-kds-api-1"}`) |
| Deploy itself failing | `ssh oracle` then `docker compose -f docker-compose.observability.yml logs` |

### Liveness alerting (is anything down?)

Two complementary layers detect a down / crash-looping service — the gap that
let the 2026-06-18 KDS crash-loop run ~13h until an employee found it:

1. **Prometheus `up == 0`** (`observability/prometheus/rules/target-liveness.rules.yml`)
   — `TargetDown` (critical, `for: 2m`) over the scraped app/DB targets (kds-api,
   analytics-api, postgres-kds/analytics/inventory, redis-kds) and
   `InfraMetricsTargetDown` (warning, 5m) over node/prometheus. Surfaces on
   Prometheus `/alerts` + the `ALERTS{}` series in Grafana. There is **no
   Alertmanager**, so this layer does NOT page on its own — it is the
   dashboard/visibility half.
2. **Host cron container-liveness → Slack + email** (`scripts/check-business-health.sh`,
   "Check 0") — the half that **reaches a human**. Runs every 15 min on Oracle;
   `docker inspect`s every `rop-*` container with an auto-restart policy
   and alerts on any that is `Created` / `Exited` / `Restarting` / `unhealthy`.
   This covers what Prometheus does NOT scrape — **kds-worker** (no HTTP port),
   the crm / inventory APIs, and the Next apps — while one-shot migrate sidecars
   (`restart: "no"`) are deliberately excluded so their clean `Exited(0)` never
   pages. The same script reports an unreachable analytics OLAP DB instead of
   silently aborting.

   **Delivery channels:** the script posts to **Slack** when `SLACK_WEBHOOK_URL`
   is set (the suite-wide webhook — same one the Mac-Mini heartbeat + CI notifier
   use; `post_slack()` mirrors the heartbeat payload) **and** emails `ALERT_EMAIL`
   (set `NOTIFY_EMAIL=0` for Slack-only). Both fire when configured; the
   suppression state file is written if either succeeds. Secrets/overrides live
   in the host file `$HOME/.rop-alert.env` (chmod 600, gitignored), sourced
   at the top of the script — put `SLACK_WEBHOOK_URL=...` there. Slack JSON is
   encoded by `python3` (strings via env → injection-safe).

Why two layers: `up == 0` catches a *wedged-but-running* process (port unbound,
connection refused) that `docker inspect` still calls "running"; the container
check catches unscraped services + the exact `Created`/`Restarting` signature
and is wired to notifications (Slack + email).

The *Prometheus-native* rules (`observability/prometheus/rules/*.yml` — kds-dlq,
clover-sync, analytics-sync, backfill, target-liveness) route to the **same Slack
channel via Alertmanager** (`docker-compose.observability.yml`, ADR-0034):
Prometheus's `alerting:` block pushes firing alerts to `alertmanager:9093`, which
fans them out with native dedup / grouping / resolve (`severity="critical"` →
a louder receiver, re-pinged hourly). The Slack webhook is the host secret
`SLACK_WEBHOOK_URL` in `.env.observability`, written to `/tmp/slack_url` at boot
and read via `api_url_file` so it never lands in the committed `alertmanager.yml`.
So liveness now has two independent Slack paths — the host cron (container-state)
and Alertmanager (`up==0` + every metric rule).

### Applying observability changes on the host

The observability stack is **not** built or deployed by `build-images.yml` — it
is hand-deployed on Oracle. After merging any change under `observability/**` or
to `docker-compose.observability.yml`, you must apply it on the host. **Pin the
project name**: the stack runs as `rop-observability`; a bare
`docker compose` (no project name) spins up a *second*, wrongly-named project
instead of updating the live one.

```bash
ssh oracle && cd ~/restaurant-ops-platform && git pull --ff-only
# canonical invocation — project name + env file are mandatory:
alias obs='COMPOSE_PROJECT_NAME=rop-observability docker compose --env-file .env.observability -f docker-compose.observability.yml'
```

**Reload vs recreate is not interchangeable** — pick by what you changed:

- **An alert rule** (`observability/prometheus/rules/*.yml`): `rules/` is a
  *directory* bind-mount, so an edited/added file is already visible inside the
  container — Prometheus just needs to re-read it (`--web.enable-lifecycle` is
  on). A reload is enough; no recreate:
  ```bash
  obs kill -s HUP prometheus     # or POST http://prometheus:9090/-/reload from inside the net
  ```
- **`prometheus.yml` itself, a scrape target, or any compose edit** (mounts,
  image tag): you must **recreate**, not restart. `prometheus.yml` is a
  *single-file* bind-mount — `git pull` replaces its inode while the running
  container stays pinned to the old one, so `restart` / plain `up -d` silently
  keep serving the stale config:
  ```bash
  obs up -d --force-recreate prometheus    # image bump: prepend `obs pull &&`
  ```
- **`alertmanager.yml`** (routing / Slack receivers): also a *single-file*
  bind-mount → **recreate** the alertmanager container (it re-reads its config +
  re-writes `/tmp/slack_url` from `SLACK_WEBHOOK_URL` at boot):
  ```bash
  obs up -d --force-recreate alertmanager
  ```
  First-time bring-up of the alertmanager service (and the `prometheus.yml`
  `alerting:` block that points at it): `obs up -d` creates alertmanager, then
  `obs up -d --force-recreate prometheus` to load the new `alerting:` stanza.
  Requires `SLACK_WEBHOOK_URL` in `.env.observability`.

**Always verify rules actually loaded** — an empty `groups` list is the exact
silent failure that hid for ≥11 days (rule files merged to `main`, but the host
stack never re-deployed, so Prometheus loaded zero alerts):

```bash
obs exec prometheus wget -qO- http://localhost:9090/api/v1/rules \
  | python3 -c 'import sys,json;print([g["name"] for g in json.load(sys.stdin)["data"]["groups"]])'
# expect your rule groups (e.g. kds-dlq, clover-sync, analytics-sync, backfill) — NOT []
```

### Disk usage

The observability stack stores data in named docker volumes:
- `rop-observability_prometheus-data` — ~50MB per day of metrics at
  current scrape rate (30s interval, ~5 targets)
- `rop-observability_loki-data` — ~100-500MB per day depending on
  log volume

To check: `docker system df -v | grep observability`.

To purge old data: configure retention in `prometheus.yml` (currently 30d)
and Loki's own config. Default deploy is conservative; tune up if disk is
plentiful or down if disk is tight.

## Known gaps (deferred to future PRs)

| Gap | Why deferred |
|---|---|
| CPU profiling re-enable | `@sentry/profiling-node` requires `onlyBuiltDependencies` allowlist; follow-up #3 |
| backoffice-web Next.js metrics | Need to add `prom-client` and an instrumentation hook |
| Grafana dashboards (pre-built) | Tune what's interesting after seeing real data; community Node.js dashboards are decent starting point |
| Backups for observability volumes | Decide retention policy first |

## Cost / footprint

All self-hosted on the existing Oracle ARM Free Tier instance. Memory budget:

| Service | RAM |
|---|---|
| Grafana | ~200MB |
| Prometheus | ~300MB (grows with metric cardinality) |
| Loki | ~200MB |
| Promtail | ~100MB |
| **Total** | **~800MB** |

vs your 24GB Oracle box → ~3%.
