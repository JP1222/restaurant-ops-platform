# Analytics API Agents

`apps/analytics-api` owns the Clover -> Postgres data pipeline and OLAP query layer. Imported from the standalone restaurant-ops-platform-Intelligence repo with full git history preserved (`git log apps/analytics-api/` traces back to Phase 1 commits).

This is **NOT** Fastify+Prisma like `apps/kds-api`. It is intentionally a different stack tuned for analytics workloads:

- Node native `http` server (not Fastify)
- Raw SQL via `pg` (not Prisma)
- `zod` for config + DTO validation
- `luxon` for timezone-aware time math
- Vitest for tests

Use these checks when relevant:

- `pnpm --filter @rop/analytics-api build`
- `pnpm --filter @rop/analytics-api test`
- `pnpm --filter @rop/analytics-api test:integration`  # real ephemeral Postgres via Testcontainers (Docker); see [docs/TESTING.md](../../docs/TESTING.md)
- `pnpm --filter @rop/analytics-api lint`

Do:

- Prefer querying `mart.sales_daily_mv` and `mart.sales_hourly_mv` over fact tables for any aggregate. They are maintained by `mart-refresh-worker`.
- Run free-form SQL through `src/analytics/safe-query.ts` (sandboxed: SELECT/WITH only, schema allowlist, statement timeout, audit log).
- Compute `local_hour`, `weekday`, `iso_week`, `year_month` at load time in `src/transform/mart-loader.ts` - never recompute on the read path.
- Store all timestamps in UTC; convert to each target's `store_timezone` (NOT a global default — single-store deploys bootstrap one target from env, default America/Chicago) only for analytics windowing.
- This service is **multi-store**: it owns `config.sync_targets` (per-store `merchant_id`, `provider`, `token`, `store_timezone`); one Scheduler iterates active targets and a per-merchant client factory resolves the client per `job.merchantId`. Reads select the store via `?merchant_id=` (absent ⇒ env-default merchant, fine with one store but ambiguous with N — consolidation is the multi-location follow-up). See [ADR-0018](../../docs/decisions/0018-multi-location-architecture.md) + [docs/multi-location.md](../../docs/multi-location.md).
- **Multi-tenant (Phase 1, [ADR-0818](../../docs/decisions/0818-multi-tenant-platform-architecture.md)):** every tenant-owned base table (`raw.*`, the `mart` dims/facts/forecast — *not* the materialized views, `mart.dim_calendar`, `meta.*`, or `audit.*`) and `config.sync_targets` now carry a nullable `tenant_id`, backfilled to the single implicit tenant `tenant-default` (migration `030_tenant_id_seam.sql`). `tenant_id` is the hard trust boundary; `merchant_id`/`location_id` are partition keys *underneath* it. **Nothing reads `tenant_id` yet** and the loader does not write it (new rows carry NULL) — this is pure plumbing. The read-path payoff lands in Phase 2: a signed tenant claim in `tenant-auth.ts` replaces the `?merchant_id=`-behind-shared-token trust, the loader starts stamping `tenant_id`, and the MVs are rebuilt to carry it (see [docs/multi-tenant-migration-roadmap.md](../../docs/multi-tenant-migration-roadmap.md)).
- **Multi-tenant read-path verifier (Phase 2c, ADR-0818):** `src/lib/tenant-auth.ts` `enforceTenantScope` verifies a signed `AnalyticsTenantClaim` (`x-tenant-claim` header, HMAC via `@rop/auth/tenant-claim` + `ANALYTICS_TENANT_SIGNING_KEY`) and checks the requested `merchant_id` belongs to the claim's tenant **using our own `config.sync_targets.tenant_id`** (never trusting the caller's merchant list; a NULL row = the default tenant during the single-tenant window). Gated by `MULTITENANT_MODE` (`off` default / `observe` / `enforce`). It changes only **authorization** (which merchant a caller may name), not the SQL — queries still filter on `merchant_id`; filtering rows by `tenant_id` waits for the loader to stamp it. **Wired into every store-scoped read handler: `handleAdminApi` (dashboard.ts) + `handleAdminMetric` (metric-route.ts) + `handleAdminMetricStats` (metric-stats-route.ts) + `handleAdminMetricDrivers` (metric-drivers-route.ts) + `handleAdminDataTrust` (data-trust-route.ts) + `handleAdminForecastRun` (forecast.ts) + `handleAdminBackfillRequeue` (backfill-requeue.ts).** (`handleAdminMetricsList` is intentionally NOT guarded — metric *definitions* are tenant-global, ADR-0030.) The backoffice claim **minter** now ships (`apps/backoffice-web/lib/analytics-api/{tenant-claim,client}.ts` — it signs the claim from the session when `ANALYTICS_TENANT_SIGNING_KEY` is set), so the round-trip is complete. To flip on: deploy both services, provision the **same** `ANALYTICS_TENANT_SIGNING_KEY` on each, then move `MULTITENANT_MODE` `off → observe` (confirm parity in Loki) `→ enforce`. Until the key is set the minter is dormant and analytics stays in off-mode.
- Add a SQL migration in `sql/migrations/NNN_*.sql` for any schema change. Migrations are forward-only.
- Add new metrics to the governed metric registry ([ADR-0030](../../docs/decisions/0030-semantic-metric-registry-as-ai-grounding.md)): a `sql/migrations/NNN_*.sql` row in `meta.metric_definitions` (see `sql/migrations/010_metric_registry.sql`) plus any supporting view, loaded by `src/analytics/metric-registry.ts` (`loadMetricRegistry` / `resolveMetric`). They are served over `POST /admin/api/metric` and `GET /admin/api/metrics` by `src/http/metric-route.ts` (dispatched from the `/admin/` handler in `src/http/dashboard.ts`), so the future Backoffice BFF and MCP layers can consume them. Do **not** reference `src/analytics/typed-queries.ts` or `src/http/api-v1.ts` — neither has ever existed.

Do not:

- Add Prisma or any ORM. This package writes SQL directly by design.
- Run untrusted SQL outside `safe-query.ts`. Even if the input is "trusted", route through the sandbox so the audit log captures it.
- Cross-import from `apps/kds-api/` or `packages/db-kds/`. Analytics has its own Postgres database; KDS is upstream raw data only.
- Store provider tokens, customer PII, or secrets in `audit.ai_query_log` rows. Validate before logging.
- Compute analytics on the read path. If you find yourself joining 4 tables in a request handler, add a materialized view instead.

## Architecture orientation

- `src/clover/` - Clover REST + webhook ingest
- `src/ingest/` - raw export parsing
- `src/transform/` - normalize raw payloads into `raw.*` tables, then promote to `mart.*` star schema
- `src/refresh/` - incremental MV refresh (`mart-refresh-worker`)
- `src/scheduler/` - job queue + heartbeats + dirty-window orchestration; the live historical backfill is the scheduler-driven `historical_export_backfill` job (`scheduler.ts` enqueues per-window jobs run by `src/jobs/export-reconcile.ts`), with per-window state checkpointed in `audit.sync_windows`
- `src/quality/` - DQ checks against mart tables
- `src/backfill/` - `windows.ts` only: time-window planning math (`fullBackfillWindows` / `sampleWindow`) shared by the scheduler and the ops dashboard. The actual replay engine is the `historical_export_backfill` job above, not a separate runner
- `src/analytics/safe-query.ts` - read-only SQL sandbox (the only sanctioned way to run free-form SQL)
- `src/http/` - `/admin/api/*` JSON endpoints, webhook verification endpoint, and `/admin` redirect to Backoffice `/ops`
- `sql/migrations/` - forward-only SQL migrations
