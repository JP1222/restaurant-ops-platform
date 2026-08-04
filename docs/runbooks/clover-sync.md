# Runbook: Clover sync failure + manual backfill replay

> Audience: on-call operator. Read top-to-bottom under stress.
> Last reviewed: 2026-05-27 · Companion to [OPERATIONS.md §6 Troubleshooting](../../OPERATIONS.md#6-troubleshooting).

Clover ingest fans out to **two pipelines**:

| Pipeline | Stores | Workers |
|---|---|---|
| `apps/kds-api` + `kds-worker` (×2) | Realtime KDS state. BullMQ on Redis. | `KdsQueueClient` queues: `sync`, `fulfillment`, `scheduler` |
| `apps/analytics-api` | OLAP mart. Postgres-backed job queue. | `audit.sync_jobs` consumed by `realtime-runner`, `export-runner`, `hydration-runner`, `repair-runner`, `dq-runner` |

Traefik mirrors each Clover webhook to **both** apps ([`infrastructure/traefik/dynamic/clover-webhook-fanout.yml`](../../infrastructure/traefik/dynamic/clover-webhook-fanout.yml)), so an upstream outage usually lights up both.

---

## 1. Symptoms

You're probably here for one of:

- Backoffice **Ops → Sync Health** tab is red, or `historical_failed_count > 0`.
- KDS board (`kds.example.com`) stops updating but `/api/health` returns `200`.
- Analytics dashboards report stale `last_hourly_sweep_at`.
- Business-health email from `scripts/check-business-health.sh` mentions `sync_runs_high_failure_rate`, `stale_heartbeats`, or `clover_401`.
- Sentry error spike for `analytics-api` or `kds-api` with `clover` in the breadcrumb.

If only one app is symptomatic, scope diagnosis to that side first.

---

## 2. Diagnosis

### 2.1 Postgres — `audit.sync_runs` (analytics-api side)

Partitioned table; one row per `JobRunner` execution. Use as the timeline:

```sql
-- Failure rate over the last hour, by job type.
SELECT job_type,
       COUNT(*) FILTER (WHERE status = 'failed') AS failed,
       COUNT(*) AS total,
       ROUND(100.0 * COUNT(*) FILTER (WHERE status = 'failed') / NULLIF(COUNT(*), 0), 1) AS pct_failed
FROM audit.sync_runs
WHERE created_at > NOW() - INTERVAL '1 hour'
GROUP BY job_type ORDER BY pct_failed DESC NULLS LAST;

-- Most recent failure messages.
SELECT created_at, job_type, merchant_id, elapsed_ms, LEFT(error_message, 300) AS error
FROM audit.sync_runs WHERE status = 'failed'
ORDER BY created_at DESC LIMIT 20;

-- Stuck pending? (runner dead, or DB lock starved.)
SELECT status, job_type, COUNT(*) FROM audit.sync_jobs
WHERE status IN ('pending', 'running')
GROUP BY status, job_type ORDER BY status, COUNT(*) DESC;

-- One-shot full dump:
pnpm --filter @rop/analytics-api ops:status
-- = psql "$DATABASE_URL" -f apps/analytics-api/scripts/ops-status.sql
```

The `audit.sync_health` **view** gives a per-merchant rollup (`last_hourly_sweep_at`, `failed_job_count`, `historical_backfill_progress_pct`, `historical_failed_count`) — that's what Backoffice Ops reads.

### 2.2 KDS side — BullMQ + dead-letter

No `sync_runs` here. Inspect:

```bash
# Persistent dead-letter rows (enqueue failures — e.g. Redis down on fan-out).
psql "$DATABASE_URL_KDS" -c "
  SELECT id, job_type, reason, attempts, created_at
  FROM dead_letter_jobs WHERE resolved_at IS NULL
  ORDER BY created_at DESC LIMIT 20;
"

# Live queue depth via Backoffice-facing admin endpoint:
curl -fs https://kds.example.com/api/admin/system-status \
  -H "Authorization: Bearer $KDS_INTERNAL_ADMIN_TOKEN" \
  | jq '{deadLettersTotal, queueDepths, queueOldestWaitMs}'
```

`dead_letter_jobs` only covers *enqueue* failures. BullMQ's own `failed` set on Redis holds per-job retry-exhaustion — there is no Postgres mirror today. The durable persistent DLQ from issue #124 is **future work**.

### 2.3 Loki / Grafana logs

Open `https://metrics.example.com` → **Explore** → datasource `Loki`:

```logql
{container=~"rop-analytics-api-.*"} |= "ERROR"
{container=~"rop-.*"} |~ "(?i)clover.*(401|403|5\\d\\d)"
{container=~"rop-kds-worker-.*"} |= "ERROR"
sum(rate({container=~"rop-.*"} |= "ERROR" [5m])) by (container)
```

### 2.4 Token sanity (do this first)

A surprising fraction of "sync failures" are an expired Clover token. Run §3.1 before digging further.

---

## 3. Common causes

| Cause | Tell-tale | Jump to |
|---|---|---|
| `CLOVER_TOKEN` expired or rotated by merchant | `clover.*401` Loki spike on both apps; `sync_runs.error_message` ~ `401`/`unauthorized` | §4.1 |
| Clover API outage / 5xx | `clover.*5\d\d`; failures across multiple `job_type`s; check [status.clover.com](https://status.clover.com) | §4.2 |
| BullMQ stuck (Redis down/partitioned) | `kds-api` /healthz still 200 but no fulfillment; `dead_letter_jobs` climbs | §4.3 |
| DB connection lost | `error_message` ~ `ECONNREFUSED`, `terminating connection`, `too many connections` | §4.3 |
| analytics-api runner crashed | `audit.service_heartbeats` lag > 5 min for one component | §4.3 |
| Network partition Oracle ↔ Clover | Intermittent 5xx; `curl https://api.clover.com` from host succeeds sometimes | §4.2 |
| Backfill window stuck `failed`/`blocked` | `audit.sync_windows.status = 'blocked'`; won't retry until `retry_after` | §4.4 |

---

## 4. Recovery

### 4.1 Token issue (most common)

Full procedure: [OPERATIONS.md §6.3](../../OPERATIONS.md#63-clover-401--silent-integration-failure). Summary:

1. Rotate token in the Clover dashboard.
2. Update `CLOVER_TOKEN` **once in Infisical** (`prod`) — it's the shared key for
   both the `kds` and `analytics` stacks (ADR-0020).
3. Redeploy both stacks so the `with-infisical` entrypoint re-injects it:
   `ssh oracle` then `bash ~/restaurant-ops-platform/scripts/deploy-stack.sh kds` and
   `bash ~/restaurant-ops-platform/scripts/deploy-stack.sh analytics`.

Within ~2 min (next `hourly_rest_sweep` tick) `audit.sync_runs` should show `status='completed'` again. No in-app rotation UI by design.

### 4.2 Clover upstream outage

Wait it out.

- Confirm upstream: `curl -fsI https://api.clover.com/v3/merchants/$CLOVER_MERCHANT_ID -H "Authorization: Bearer $CLOVER_TOKEN"` from the Oracle host.
- Webhooks still buffer in `audit.webhook_inbox` ([`webhook-inbox-worker.ts`](../../apps/analytics-api/src/scheduler/webhook-inbox-worker.ts)).
- On recovery, the runners drain on their own; watch `audit.sync_jobs WHERE status='pending'` shrink.
- If the backlog hasn't moved in 1h, restart the worker — §4.3.

### 4.3 Failed sync job / stuck runner

**Single-order replay (KDS side)** — for a Clover order that didn't make it to the board:

```bash
curl -X POST \
  -H "Authorization: Bearer $KDS_INTERNAL_ADMIN_TOKEN" \
  "https://kds.example.com/api/internal/sync/orders/<CLOVER_ORDER_ID>?merchantId=<merchant>"
# See apps/kds-api/src/routes/internal.ts — enqueues a `manual` BullMQ job.
```

**Restart a dead analytics runner**:

```bash
psql "$DATABASE_URL_ANALYTICS" -c "
  SELECT component, last_seen_at, NOW() - last_seen_at AS lag
  FROM audit.service_heartbeats ORDER BY lag DESC;
"
# All runners live in one process — restart the container.
ssh oracle "docker restart rop-analytics-api-1"
```

The scheduler picks pending `audit.sync_jobs` rows back up automatically. Locked rows that go stale get reclaimed — TODO: confirm the exact reclaim window with the kds-api team. If a job is genuinely stuck `running` and won't release:

```sql
-- Last-resort manual reset. Only if the runner is provably dead.
UPDATE audit.sync_jobs
SET status='pending', locked_at=NULL, locked_by=NULL, run_after=NOW()
WHERE id = '<uuid>';
```

**Failed jobs that exhausted `max_attempts`** stay `status='failed'`; they do not retry. To replay one:

```sql
UPDATE audit.sync_jobs
SET status='pending', attempt_count=0, run_after=NOW(), last_error=NULL
WHERE id = '<uuid>' AND status='failed';
```

**KDS `dead_letter_jobs`** currently have **no replay UI/CLI**. Re-enqueue by hand from the payload, or wait for the durable DLQ tooling from issue #124. Mark resolved:

```sql
UPDATE dead_letter_jobs SET resolved_at = NOW() WHERE id = '<id>';
```

### 4.4 Backfill replay for a date range

Backfill is **autonomous**: the scheduler emits `historical_export_backfill` jobs that walk `audit.sync_windows` rows, processing up to `HISTORICAL_BACKFILL_MAX_CONCURRENT_WINDOWS` (default 2) windows in parallel inside the daily Clover export window. A single failed/blocked window no longer stalls the rest of the grid — the scheduler skips parked windows and continues, and a blocked window auto-recovers after a backoff (`HISTORICAL_BACKFILL_BLOCKED_RETRY_AFTER_MINUTES`, default 12 h) up to a ceiling (`HISTORICAL_BACKFILL_MAX_AUTO_UNBLOCK_ATTEMPTS` beyond `HISTORICAL_BACKFILL_MAX_WINDOW_FAILURES`) before it parks for manual intervention.

**Preferred — Backoffice Ops → Backfill:** click **Retry failed + blocked** to reset every failed/blocked window to pending, or **Unblock parked** for blocked-only. This calls `POST /admin/api/backfill/requeue` and is the sanctioned operator path — no psql needed. Completed windows are never touched.

**Break-glass (psql) — only if the app is unreachable.** Equivalent to the button above:

```sql
-- Reset failed/blocked windows so the scheduler picks them up.
UPDATE audit.sync_windows
SET status='pending', failure_count=0, retry_after=NULL,
    blocked_at=NULL, last_error=NULL, job_id=NULL
WHERE window_type='historical_export_backfill'
  AND merchant_id='<merchant>'
  AND window_start >= '<YYYY-MM-DD>'
  AND window_end <= '<YYYY-MM-DD>'
  AND status IN ('failed', 'blocked');
```

Within one scheduler tick (~30 s, during the export window) the `export-runner` starts consuming. Watch in Backoffice **Ops → Backfill** or:

```sql
SELECT status, COUNT(*) FROM audit.sync_windows
WHERE merchant_id='<merchant>' AND window_type='historical_export_backfill'
GROUP BY status;
```

For a **dirty window** refresh (re-derive mart, no re-fetch from Clover):

```sql
INSERT INTO audit.dirty_windows
  (merchant_id, business_date_start, business_date_end, utc_start, utc_end, reason)
VALUES ('<merchant>', '2026-05-01', '2026-05-01',
        '2026-05-01T05:00:00Z', '2026-05-02T05:00:00Z',  -- America/Chicago boundaries
        'manual replay — operator');
```

`mart-refresh-worker` picks it up next tick.

There is no `pnpm` script to kick a backfill from outside the runtime, and you should not add one. The scheduler-driven `historical_export_backfill` job is the **only** backfill implementation (ADR-0642). The former `runBackfill()` one-shot runner (`apps/analytics-api/src/backfill/runner.ts`) and its orphan `audit.backfill_runs` / `backfill_windows` tables have been **removed** — that engine bypassed the export-window gating and the single-active-window guard and was invisible to Backoffice Ops and `ops:status`, so a parallel backfill through it was never safe. The Ops → Backfill control (or the break-glass SQL above) is the only sanctioned way to force a re-run.

---

## 5. Escalation

If §4 leaves the pipeline red after 15 min, or `dead_letter_jobs` references customer-visible orders:

1. Page the **kds-api on-call** (currently the repo owner — no rotation yet; TODO formalize). Slack `#rop-ops` + email.
2. Pause auto-deploy on the affected stack so a half-fixed state doesn't roll forward: [OPERATIONS.md §4.8](../../OPERATIONS.md#48-pause-auto-deploy).
3. File an incident note in `HANDOFF.md` — time range, failing query/log lines, recovery action taken.
4. After resolution, add a tripwire to `scripts/check-business-health.sh` (or a Loki alert) so the next occurrence pages instead of being noticed by a human.
