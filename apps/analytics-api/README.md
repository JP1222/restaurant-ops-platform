# Analytics API

Restaurant intelligence and AI-ready analytics for Example Kitchen Clover data.

This is the `analytics-api` app within the Example Kitchen monorepo — imported from the standalone `restaurant-ops-platform-Intelligence` repo with full git history preserved (`git log apps/analytics-api/`). KDS (`apps/kds-api`) owns realtime kitchen execution; this app owns historical Clover backfill, analytics marts, report-ready metrics, and AI query tooling.

## Architecture

```text
Clover POS webhooks
  -> audit.webhook_inbox
  -> sync job queue
  -> raw Clover payloads
  -> audit.dirty_windows
  -> mart refresh worker
  -> mart/meta/audit for Web UI

Hourly REST sweep
  -> recent overlap window
  -> raw upsert
  -> dirty window refresh

Daily Export reconcile / historical backfill
  -> bulk files
  -> raw upsert
  -> reconciliation / repair
  -> dirty window refresh
```

Database schemas:

- `raw`: original Clover payloads and export audit rows.
- `staging`: reserved for intermediate cleanup tables.
- `mart`: AI/reporting-friendly star schema.
- `audit`: webhook inbox, jobs, dirty windows, reconciliation, data quality, query logs.
- `meta`: metric definitions and table documentation for AI.

## Setup

```bash
pnpm install
infisical login        # one-time, first-time contributors only
infisical run -- pnpm dev
```

Layer-1 secrets (`CLOVER_*`, `ADMIN_TOKEN`) are injected by `infisical run` at runtime (see [ADR-0020](../../docs/decisions/0020-adopt-infisical-for-runtime-secrets.md)) — never committed. Bootstrap secrets (`DATABASE_URL`, `SESSION_SECRET`, encryption keys) live in an uncommitted local env file. Put real Clover credentials only in Infisical or local/server env files. Never commit them.

## Commands

```bash
pnpm build
pnpm dev       # start the automation service with tsx
pnpm start     # start built service from dist/
pnpm test
pnpm lint
```

There are no manual business backfill commands in production. The service runs migrations on startup, schedules hourly REST sweeps, processes Clover webhooks, reconciles Export data in the Clover window, advances historical backfill automatically, and refreshes mart tables through `audit.dirty_windows`.

See [Data Model](docs/data-model.md), [Operations](docs/operations.md), and Delivery Handoff for warehouse design, example AI queries, production setup, and the current handoff status.

## Production Shape

Production runs as the `analytics` compose stack ([`compose/analytics.yml`](../../compose/analytics.yml)) on the Oracle host, fronted at `analytics.example.com`. Images are pre-built by the user-gated `build-images.yml` workflow and pulled from GHCR (`ghcr.io/example-org/rop-analytics-api:main`) — the host does not build them. The stack runs its own `postgres:16-alpine` (database `rop_analytics`, named volume `postgres-analytics-data`) plus a `clover-exports` volume, all single-homed on the flat `rop-net` bridge ([ADR-0527](../../docs/decisions/0527-collapse-to-single-app-network.md)). See [OPERATIONS.md](../../OPERATIONS.md) for the deploy pipeline and [docs/operations.md](docs/operations.md) for analytics-specific ops.

Configure Clover POS webhooks in the Clover Developer Dashboard at `https://webhooks.example.com/clover`. Traefik mirrors that POST to both analytics-api (canonical path `/webhooks/clover`) and kds-api; see `HANDOFF-clover-webhook-fanout.md` for the full runbook. The legacy direct path `https://analytics.example.com/webhooks/clover` is preserved as a rollback channel. The service stores verification codes in `audit.webhook_verifications`; read recent codes via `https://analytics.example.com/admin/webhook-verifications` with a Bearer `ADMIN_TOKEN` (or `docker exec` into the container — port 3100 is not host-published).
