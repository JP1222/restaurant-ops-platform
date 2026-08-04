# Operations — analytics-api

> **Scope.** App-specific operations for the `analytics` stack. The suite-wide deploy
> mechanics — the CI/build pipeline, `scripts/deploy-stack.sh`, the Infisical secret
> model, and the flat network — are canonical in [`OPERATIONS.md`](../../../OPERATIONS.md)
> (§1–§4, §7). This file only covers what is specific to analytics-api: its own Postgres,
> the Clover webhook setup, first-run probes, historical backfill, and reconciliation.

> **Deploy model.** analytics-api ships as the `analytics` compose stack
> ([`compose/analytics.yml`](../../../compose/analytics.yml)). The host
> **does not build it**: `scripts/deploy-stack.sh analytics` git-syncs the `~/restaurant-ops-platform`
> checkout to `origin/main`, then `docker compose … pull`s the pre-built
> `ghcr.io/example-org/rop-analytics-api:main` image from GHCR and `up -d`s it. Runtime
> secrets are injected at container boot from Infisical
> ([ADR-0020](../../../docs/decisions/0020-adopt-infisical-for-runtime-secrets.md)), and
> every container is single-homed on the flat external bridge `rop-net`
> ([ADR-0527](../../../docs/decisions/0527-collapse-to-single-app-network.md)). The old
> standalone `docker-compose.production.yml` host-build path under
> `/home/ubuntu/restaurant-ops-platform-Intelligence` (with its `.env.production` and the
> `traefik-servicenet` attachment) is **retired** — it predates the suite monorepo.

## Local Development

```bash
cp .env.example .env
pnpm install
pnpm dev
pnpm test
```

## Production database

analytics-api owns its own Postgres — never the KDS database (Iron Law #1/#5). It is a
plain compose service inside the `analytics` stack:

| | |
|---|---|
| Service / container | `postgres-analytics` / `rop-analytics-postgres-analytics-1` |
| Image | `postgres:16-alpine` |
| Database | `rop_analytics` |
| Named volume | `postgres-analytics-data` |
| Reachability | over `rop-net` by service name (`postgres-analytics:5432`) — **no host port** |

The application creates and migrates the `raw`, `staging`, `mart`, `audit`, and `meta`
schemas automatically when the service starts. Migrations are forward-only raw SQL
(`sql/migrations/NNN_*.sql`) run by the app itself — there is **no separate migrate
container** (unlike the Prisma stacks) — and are guarded by a PostgreSQL advisory lock so
multiple instances do not run migrations at the same time. Because the datastore publishes
no host port, it cannot collide with any other stack's Postgres.

## Secrets & environment

Runtime secrets come from the Infisical `prod` scope via the `with-infisical` entrypoint
([ADR-0020](../../../docs/decisions/0020-adopt-infisical-for-runtime-secrets.md)): the
Layer-1 Clover credentials (`CLOVER_TOKEN`, `CLOVER_MERCHANT_ID`, `CLOVER_WEBHOOK_AUTH_CODE`),
the `ADMIN_TOKEN` that gates the Backoffice → analytics-api BFF, `DATABASE_URL`, and the
Sentry DSN. There is **no `.env.production`** anymore.

The only host-side file is the gitignored `compose/analytics.env`, which carries
just the irreducible bootstrap, **not** application secrets:

- Infisical secret-zero — `INFISICAL_MACHINE_CLIENT_ID` / `INFISICAL_MACHINE_CLIENT_SECRET`.
- The local datastore credential — `POSTGRES_PASSWORD` (fresh volume; not network-exposed).
- The local-DNS `DATABASE_URL` — `postgresql://postgres:…@postgres-analytics:5432/rop_analytics`.

The committed template is [`.env.prod.example`](../../../.env.prod.example). The full
secret model is [`OPERATIONS.md` §2.7 / §7](../../../OPERATIONS.md#27-per-stack-host-env-files).

> ⚠️ **Infisical override rule.** A var set in the host `.env` that *also* exists in
> Infisical `prod` is overridden by the Infisical value at boot. Keep the local-DNS
> `DATABASE_URL` out of Infisical (or repoint it there to `postgres-analytics:5432`),
> otherwise a stale value wins and the container can't reach its database.

The canonical set of variables the container actually receives is the `environment:` block
of [`compose/analytics.yml`](../../../compose/analytics.yml); the app's
behavioural tuning knobs (worker concurrency, debounce windows, the Export window, the
historical-backfill share) are read from the same env with zod-validated defaults in
`src/config`. Two values worth calling out because they are referenced below:

- `RAW_EXPORT_DIR=/var/lib/rop-intelligence/clover-exports` — the in-container Clover
  Export staging dir, backed by the `clover-exports` named volume. This keeps the legacy
  `rop-intelligence` segment **on purpose**: it is a container-internal mount path
  baked into the image and the compose file, not a host path.
- `EXPORT_HISTORICAL_BACKFILL_WINDOW_SHARE=0` — pauses historical backfill (see
  [Historical Backfill](#historical-backfill)).

## Deploy

analytics-api deploys through the suite flow ([`OPERATIONS.md` §4.1](../../../OPERATIONS.md#41-deploy-new-code))
— a manual `build-images.yml` dispatch builds the image and SSHes to the host to run the
deploy script. To bring the stack up by hand on the host (no CI):

```bash
bash ~/restaurant-ops-platform/scripts/deploy-stack.sh analytics
# git-syncs ~/restaurant-ops-platform to origin/main, then: docker compose -f compose/analytics.yml \
#   [--env-file compose/analytics.env] pull && up -d --remove-orphans
```

Public surfaces (host Traefik, `rop-net`):

- **Primary webhook** — `https://webhooks.example.com/clover`, which Traefik mirrors
  (fan-out) to both kds-api and analytics-api. See
  `HANDOFF-clover-webhook-fanout.md`.
- **Legacy/admin host** — `https://analytics.example.com`, routed by the stack's
  Traefik labels to `/webhooks/clover` (legacy direct path, rollback channel — no fan-out,
  so kds-api will not receive events) and `/admin` (the admin endpoints).

Before configuring Clover, confirm DNS points at the Oracle host:

```bash
dig +short webhooks.example.com
dig +short analytics.example.com   # rollback DNS (should also resolve)
```

## Service Runtime

The running container is `rop-analytics-analytics-api-1`. Logs and shells, on the
host from `~/restaurant-ops-platform`:

```bash
docker compose -f compose/analytics.yml logs -f analytics-api
ssh oracle 'docker logs -f --tail 100 rop-analytics-analytics-api-1'   # equivalent
```

The http server listens on `3100` **inside** the container only (no host port). Probe its
health by exec-ing into the container:

```bash
docker exec rop-analytics-analytics-api-1 curl -fs http://127.0.0.1:3100/healthz
docker exec rop-analytics-analytics-api-1 curl -fs http://127.0.0.1:3100/readyz
```

The service runs without manual business commands:

- `POST /webhooks/clover` receives Clover POS webhooks.
- `GET /healthz` reports process liveness.
- `GET /readyz` checks DB connectivity, all service component heartbeats, and hourly sync freshness.
- `GET /admin/webhook-verifications` returns recent Clover verification codes when called with `Authorization: Bearer ADMIN_TOKEN` (reachable through Traefik at `https://analytics.example.com/admin/webhook-verifications`).

## Configure Clover Webhook

Configure the webhook URL manually in the Clover Developer Dashboard:

```text
https://webhooks.example.com/clover
```

(Legacy: `https://analytics.example.com/webhooks/clover` still works as a direct path to this service, but it bypasses the fan-out — kds-api will not receive events. Use only for rollback.)

Clover sends a one-time `verificationCode` payload. Read it from the admin endpoint or service logs, paste it back into the Clover Developer Dashboard, then subscribe to the Orders, Payments, and Employees event types.

```bash
curl -H "Authorization: Bearer $ADMIN_TOKEN" \
  https://analytics.example.com/admin/webhook-verifications
# or, on the host without going through Traefik:
docker exec rop-analytics-analytics-api-1 \
  curl -fs -H "Authorization: Bearer $ADMIN_TOKEN" http://127.0.0.1:3100/admin/webhook-verifications
```

After verification, set the Clover Auth Code as `CLOVER_WEBHOOK_AUTH_CODE` in the Infisical `prod` scope, then restart the stack so `with-infisical` re-injects it. POS app webhooks use the `X-Clover-Auth` header; Hosted Checkout HMAC signing is not used for this service.

```bash
docker compose -f compose/analytics.yml restart analytics-api
# (or re-run deploy-stack.sh analytics to re-pull + re-inject in one step)
```

## First Production Sample Run

After deployment, verify the pipeline without running manual business CLI commands:

```sql
SELECT * FROM audit.sync_health;
SELECT status, count(*) FROM audit.dirty_windows GROUP BY status;
SELECT * FROM audit.reconciliation_results ORDER BY created_at DESC LIMIT 7;
SELECT component, last_seen_at FROM audit.service_heartbeats ORDER BY component;
```

During the Clover Export window (`10:00-15:00 UTC`, currently `05:00-10:00 CT`), verify that the scheduler enqueues reconcile work:

```sql
SELECT job_type, status, run_after, created_at
FROM audit.sync_jobs
WHERE job_type = 'export_reconcile'
ORDER BY created_at DESC
LIMIT 5;
```

Webhook smoke test (primary path — exercises Traefik fan-out + both backends):

```bash
curl -X POST https://webhooks.example.com/clover \
  -H "Content-Type: application/json" \
  -H "X-Clover-Auth: $CLOVER_WEBHOOK_AUTH_CODE" \
  -d '{"merchants":{"'"$CLOVER_MERCHANT_ID"'":[{"objectId":"O:test-order","type":"UPDATE","ts":1777204800000}]}}'
```

Verify both backends received it: check `audit.webhook_inbox` (analytics-api) and `CloverWebhookEvent` (kds-api) for matching `test-order` rows.

Legacy direct path (analytics-api only, no fan-out):

```bash
curl -X POST https://analytics.example.com/webhooks/clover \
  -H "Content-Type: application/json" \
  -H "X-Clover-Auth: $CLOVER_WEBHOOK_AUTH_CODE" \
  -d '{"merchants":{"'"$CLOVER_MERCHANT_ID"'":[{"objectId":"O:test-order","type":"UPDATE","ts":1777204800000}]}}'
```

Then check that the inbox row appears and the inbox worker converts it into a job:

```sql
SELECT merchant_id, object_type, object_id, status, received_at
FROM audit.webhook_inbox
ORDER BY received_at DESC
LIMIT 5;

SELECT job_type, status, payload, created_at
FROM audit.sync_jobs
WHERE job_type LIKE 'webhook_fetch_%'
ORDER BY created_at DESC
LIMIT 5;
```

## Historical Backfill

Historical backfill is intentionally paused when:

```env
EXPORT_HISTORICAL_BACKFILL_WINDOW_SHARE=0
```

To start the full historical pull later, first take a database backup, then set (in the
Infisical `prod` scope, and restart the stack):

```env
BACKFILL_START_DATE=2018-04-01
BACKFILL_WINDOW_DAYS=30
EXPORT_HISTORICAL_BACKFILL_WINDOW_SHARE=0.4
```

The scheduler keeps at most one `historical_export_backfill` job pending or running at a time. Export order rows are written first, then `order_detail_hydration` jobs fetch full REST order details so skinny Export payloads do not overwrite richer webhook/REST payloads.

Historical windows are tracked in `audit.sync_windows`. Completed and warning windows are skipped permanently. Failed historical windows are retried after `HISTORICAL_BACKFILL_RETRY_COOLDOWN_MINUTES`; after `HISTORICAL_BACKFILL_MAX_WINDOW_FAILURES` consecutive failures, or after a non-retryable auth/permission/schema-style error, the window becomes `blocked` and the scheduler stops advancing history until an operator resolves it.

If Clover returns repeated 429/5xx responses, dirty windows pile up, or detail hydration failures become noisy, pause history by setting `EXPORT_HISTORICAL_BACKFILL_WINDOW_SHARE=0` and restarting the stack. Real-time webhook and hourly REST sweep can keep running.

`raw.clover_orders.detail_score` is a payload completeness hint. Higher scores mean the payload contains more order detail such as line items, modifiers, Special alternate names, and order type. Export rows may update metadata, but they should not replace a richer payload.

## Reconciliation Checks

The service imports recent Export data in the Clover Export API window, writes `imported` when files are imported, and then schedules a `reconciliation_check`. The check compares raw/export-loaded data to mart facts by business date. `passed` means the compared metrics matched; `failed` means a delta was recorded and a deduped `repair_window` was queued.

- order count
- payment total
- refund total
- net sales
- tax
- tips
- cash vs credit card

Use `audit.reconciliation_results.details` for the raw vs mart metric snapshot and `audit.sync_windows` for the window-level stage ledger.

Historical backfill advances only when `EXPORT_HISTORICAL_BACKFILL_WINDOW_SHARE` is greater than `0`, in the later portion of the Export API window, after daily reconcile and repair work have priority.

## Ops Checks

`pnpm ops:status` (in this package) is a read-only snapshot: it runs
[`scripts/ops-status.sql`](../scripts/ops-status.sql) against `$DATABASE_URL` and prints
service health, historical backfill window counts, recent failed jobs, dirty window
backlog, and open data quality checks. Run it from a checkout with `DATABASE_URL` pointed at
the analytics database, or run the SQL directly inside the datastore container:

```bash
docker exec -i rop-analytics-postgres-analytics-1 \
  psql -U postgres -d rop_analytics < apps/analytics-api/scripts/ops-status.sql
```

For deploy failures and rollback, follow the suite runbook
([`OPERATIONS.md` §6.1 / §4.7](../../../OPERATIONS.md#61-deploy-failed--health-check-red)).
Never patch a production container in place — every change flows through `origin/main` and a
`build-images.yml` deploy, so production never drifts from the repository.
