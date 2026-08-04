import { existsSync } from "node:fs";
import { config as loadDotenv } from "dotenv";
import { z } from "zod";

loadDotenv({ path: ".env" });
const nodeEnv = process.env.NODE_ENV;
if (nodeEnv && existsSync(`.env.${nodeEnv}`)) {
  loadDotenv({ path: `.env.${nodeEnv}` });
}

const defaultBackofficeBaseUrl =
  nodeEnv === "production" ? "https://backoffice.example.com" : "http://localhost:3001";

const ConfigSchema = z.object({
  nodeEnv: z.string().default("development"),
  databaseUrl: z.string().min(1),
  cloverBaseUrl: z.string().url().default("https://api.clover.com"),
  cloverMerchantId: optionalNonEmptyString(),
  cloverToken: optionalNonEmptyString(),
  cloverWebhookAuthCode: optionalNonEmptyString(),
  adminToken: optionalNonEmptyString(),
  // A dedicated bearer kds-api uses to register a Square store as a sync target
  // (POST /admin/api/sync-targets ONLY). Scoped narrower than adminToken so
  // kds-api can't reach the other /admin routes. Unset → only adminToken works.
  kdsAnalyticsPushToken: optionalNonEmptyString(),
  // Multi-tenant enforcement (ADR-0818 Phase 2c). `off` (default) = today's
  // behavior: the read path trusts `?merchant_id=` behind the shared adminToken.
  // `observe`/`enforce` additionally require a signed AnalyticsTenantClaim
  // (HMAC, `tenantSigningKey`) and check the requested merchant belongs to the
  // claim's tenant (via config.sync_targets.tenant_id). `observe` logs a
  // violation but still serves (dual-read window); `enforce` rejects (401/403).
  multiTenantMode: z.enum(["off", "observe", "enforce"]).default("off"),
  // Shared HMAC secret the backoffice BFF signs the tenant claim with and this
  // service verifies. Unset → claim verification is impossible, so observe just
  // logs "no key" and enforce fails closed. Mirrors the shared-secret model of
  // adminToken / kdsAnalyticsPushToken.
  tenantSigningKey: optionalNonEmptyString(),
  backofficeBaseUrl: z.string().url().default(defaultBackofficeBaseUrl),
  // inventory-api base URL for the plate-cost ingest (ADR-0031). Prod sets
  // INVENTORY_API_BASE_URL; the default is for dev (inventory-api dev = :4100).
  inventoryApiBaseUrl: z.string().url().default("http://localhost:4100"),
  storeTimezone: z.string().min(1).default("America/Chicago"),
  rawExportDir: z.string().min(1).default("./exports/clover"),
  backfillStartDate: z.coerce.date().default(new Date("2018-04-01T00:00:00.000Z")),
  backfillSampleDays: z.coerce.number().int().min(1).max(30).default(7),
  // Clover documents 30 days as the MAX range per export request; default to 28 to
  // keep a safety margin off the (inclusive-vs-exclusive undocumented) boundary.
  backfillWindowDays: z.coerce.number().int().min(1).max(30).default(28),
  healthPort: z.coerce.number().int().min(1).max(65535).default(3100),
  hourlySweepOffsetMinutes: z.coerce.number().int().min(0).max(59).default(5),
  syncOverlapHours: z.coerce.number().int().min(1).max(72).default(6),
  webhookOrderDebounceSeconds: z.coerce.number().int().min(0).max(300).default(15),
  webhookPaymentDebounceSeconds: z.coerce.number().int().min(0).max(300).default(5),
  webhookMiniSweepBacklogThreshold: z.coerce.number().int().min(1).default(100),
  webhookVerificationMaxPerHour: z.coerce.number().int().min(1).default(20),
  webhookInboxBatchSize: z.coerce.number().int().min(1).max(500).default(50),
  webhookInboxPollMs: z.coerce.number().int().min(100).default(1000),
  exportReconcileLookbackDays: z.coerce.number().int().min(1).max(30).default(7),
  exportWindowStartUtc: z.string().regex(/^\d{2}:\d{2}$/).default("10:00"),
  exportWindowEndUtc: z.string().regex(/^\d{2}:\d{2}$/).default("15:00"),
  exportHistoricalBackfillWindowShare: z.coerce.number().min(0).max(1).default(0.4),
  historicalBackfillMaxWindowFailures: z.coerce.number().int().min(1).max(20).default(3),
  historicalBackfillRetryCooldownMinutes: z.coerce.number().int().min(1).default(360),
  // P2 auto-recovery: a blocked window is re-eligible this many minutes after it
  // last blocked, for at most maxAutoUnblockAttempts beyond maxWindowFailures
  // before it is permanently parked for manual intervention.
  historicalBackfillBlockedRetryAfterMinutes: z.coerce.number().int().min(1).default(720),
  historicalBackfillMaxAutoUnblockAttempts: z.coerce.number().int().min(0).max(20).default(3),
  // P5 bounded parallelism: max historical windows in flight at once. The
  // export-runner is sized to at least this (service.ts) so the windows can run
  // concurrently. Conservative default (2) for the single-merchant Clover export
  // concurrency limit; raise carefully.
  historicalBackfillMaxConcurrentWindows: z.coerce.number().int().min(1).max(5).default(2),
  jobMaxAttempts: z.coerce.number().int().min(1).max(20).default(5),
  jobWorkerConcurrency: z.coerce.number().int().min(1).max(10).default(2),
  realtimeWorkerConcurrency: z.coerce.number().int().min(1).max(10).default(2),
  exportWorkerConcurrency: z.coerce.number().int().min(1).max(5).default(1),
  hydrationWorkerConcurrency: z.coerce.number().int().min(1).max(5).default(1),
  repairWorkerConcurrency: z.coerce.number().int().min(1).max(5).default(1),
  dqWorkerConcurrency: z.coerce.number().int().min(1).max(5).default(1),
  jobStaleAfterMinutes: z.coerce.number().int().min(1).default(30),
  martRefreshIntervalSeconds: z.coerce.number().int().min(1).default(30),
  martMvRefreshMinIntervalSeconds: z.coerce.number().int().min(1).default(60),
  // How often to pull count-based actual COGS from inventory-api into
  // mart.dim_actual_cogs (ADR-0573). A Backoffice count syncs immediately;
  // crew-web floor counts have no trigger, so this periodic pull catches them up.
  actualCogsIngestIntervalSeconds: z.coerce.number().int().min(1).default(300),
  // How often the backfill-metrics updater recomputes the rop_backfill_*
  // Prometheus gauges (per sync target). 5 min is plenty: the backfill advances
  // roughly one window/day, and the stall alert thresholds are in hours.
  backfillMetricsRefreshSeconds: z.coerce.number().int().min(1).default(300),
  // P4 external recon: how many never-verified business days to keep in flight per
  // merchant. Bounds the background Clover re-fetch sweep; actual request rate is
  // further throttled by the per-merchant Clover rate limiter. 0 disables it.
  externalReconMaxConcurrentDays: z.coerce.number().int().min(0).max(20).default(4),
  // Once the recon backlog drains, the candidate scan (a full-history spine+UNION
  // over the store's whole calendar) finds nothing yet still runs every ~60s tick.
  // New candidates trickle in at most ~one/day, so back the empty-scan off to this
  // cadence. Only an EMPTY scan is throttled — an active drain keeps full tick speed.
  externalReconScanMinIntervalMinutes: z.coerce.number().int().min(1).default(10),
  // Age bound on the external-recon confirm-closed verdict (PR #758 follow-up). A
  // mart-0 day that the re-fetch also reports as 0 normally confirms a real closure;
  // completeness then de-escalates it from "missing" to "closed". But if the day is
  // OLDER than the POS's payment-retention horizon, the source may have aged the
  // day's payments out — so a zero re-fetch is indistinguishable from a dropped day
  // and CANNOT confirm closure. Past the horizon classifyRecon returns
  // source_unavailable (completeness keeps flagging the day) instead of ok (which
  // would silently drop a real data-loss alarm). The default is effectively
  // unbounded: Clover REST retains a merchant's payments for the account's lifetime
  // (the 90-day limit is a per-request window-WIDTH cap, not a retention depth, and
  // a hard fetch failure throws rather than returning a false zero), so today's
  // single Clover merchant never trips it. A POS that genuinely ages out payment
  // data — notably a Square store #2 once a Square ingest path exists — MUST set
  // this to that POS's real retention (and the value should move to a per-sync-target
  // column once the fleet mixes POS vendors; today's AppConfig is global).
  cloverPaymentsRetentionDays: z.coerce.number().int().min(1).default(365_000),
  // Hour (UTC) at/after which the daily demand-forecast recompute is enqueued
  // (ADR-0032). Default 16:00 UTC runs it just after the export-reconcile window
  // (10:00-15:00 UTC) so the latest reconciled day feeds the model. One run/day,
  // deduped on the calendar date.
  forecastRefreshHourUtc: z.coerce.number().int().min(0).max(23).default(16),
  cloverRestMaxConcurrency: z.coerce.number().int().min(1).max(5).default(4),
  cloverRestRequestsPerSecond: z.coerce.number().int().min(1).max(16).default(8),
  // Square ingest (Phase 4). The per-store token comes from config.sync_targets
  // (not env); this only selects the API host. One store today, so a single
  // per-deploy environment is sufficient (dev=sandbox, prod=production).
  squareEnvironment: z.enum(["sandbox", "production"]).default("production"),
  sqlStatementTimeoutMs: z.coerce.number().int().min(1000).default(30_000),
  aiQueryRowLimit: z.coerce.number().int().min(1).max(5000).default(500)
});

export type AppConfig = z.infer<typeof ConfigSchema>;

export function loadConfig(): AppConfig {
  return ConfigSchema.parse({
    nodeEnv: process.env.NODE_ENV,
    databaseUrl: process.env.ANALYTICS_DATABASE_URL ?? process.env.DATABASE_URL,
    cloverBaseUrl: process.env.CLOVER_BASE_URL,
    cloverMerchantId: process.env.CLOVER_MERCHANT_ID,
    cloverToken: process.env.CLOVER_TOKEN,
    cloverWebhookAuthCode: process.env.CLOVER_WEBHOOK_AUTH_CODE,
    adminToken: process.env.ADMIN_TOKEN,
    kdsAnalyticsPushToken: process.env.KDS_ANALYTICS_PUSH_TOKEN,
    multiTenantMode: process.env.MULTITENANT_MODE,
    tenantSigningKey: process.env.ANALYTICS_TENANT_SIGNING_KEY,
    backofficeBaseUrl: process.env.BACKOFFICE_BASE_URL,
    inventoryApiBaseUrl: process.env.INVENTORY_API_BASE_URL,
    storeTimezone: process.env.STORE_TIMEZONE,
    rawExportDir: process.env.RAW_EXPORT_DIR,
    backfillStartDate: process.env.BACKFILL_START_DATE,
    backfillSampleDays: process.env.BACKFILL_SAMPLE_DAYS,
    backfillWindowDays: process.env.BACKFILL_WINDOW_DAYS,
    healthPort: process.env.HEALTH_PORT,
    hourlySweepOffsetMinutes: process.env.HOURLY_SWEEP_OFFSET_MINUTES,
    syncOverlapHours: process.env.SYNC_OVERLAP_HOURS,
    webhookOrderDebounceSeconds: process.env.WEBHOOK_ORDER_DEBOUNCE_SECONDS,
    webhookPaymentDebounceSeconds: process.env.WEBHOOK_PAYMENT_DEBOUNCE_SECONDS,
    webhookMiniSweepBacklogThreshold: process.env.WEBHOOK_MINI_SWEEP_BACKLOG_THRESHOLD,
    webhookVerificationMaxPerHour: process.env.WEBHOOK_VERIFICATION_MAX_PER_HOUR,
    webhookInboxBatchSize: process.env.WEBHOOK_INBOX_BATCH_SIZE,
    webhookInboxPollMs: process.env.WEBHOOK_INBOX_POLL_MS,
    exportReconcileLookbackDays: process.env.EXPORT_RECONCILE_LOOKBACK_DAYS,
    exportWindowStartUtc: process.env.EXPORT_WINDOW_START_UTC,
    exportWindowEndUtc: process.env.EXPORT_WINDOW_END_UTC,
    exportHistoricalBackfillWindowShare: process.env.EXPORT_HISTORICAL_BACKFILL_WINDOW_SHARE,
    historicalBackfillMaxWindowFailures: process.env.HISTORICAL_BACKFILL_MAX_WINDOW_FAILURES,
    historicalBackfillRetryCooldownMinutes: process.env.HISTORICAL_BACKFILL_RETRY_COOLDOWN_MINUTES,
    historicalBackfillBlockedRetryAfterMinutes: process.env.HISTORICAL_BACKFILL_BLOCKED_RETRY_AFTER_MINUTES,
    historicalBackfillMaxAutoUnblockAttempts: process.env.HISTORICAL_BACKFILL_MAX_AUTO_UNBLOCK_ATTEMPTS,
    historicalBackfillMaxConcurrentWindows: process.env.HISTORICAL_BACKFILL_MAX_CONCURRENT_WINDOWS,
    jobMaxAttempts: process.env.JOB_MAX_ATTEMPTS,
    jobWorkerConcurrency: process.env.JOB_WORKER_CONCURRENCY,
    realtimeWorkerConcurrency: process.env.REALTIME_WORKER_CONCURRENCY,
    exportWorkerConcurrency: process.env.EXPORT_WORKER_CONCURRENCY,
    hydrationWorkerConcurrency: process.env.HYDRATION_WORKER_CONCURRENCY,
    repairWorkerConcurrency: process.env.REPAIR_WORKER_CONCURRENCY,
    dqWorkerConcurrency: process.env.DQ_WORKER_CONCURRENCY,
    jobStaleAfterMinutes: process.env.JOB_STALE_AFTER_MINUTES,
    martRefreshIntervalSeconds: process.env.MART_REFRESH_INTERVAL_SECONDS,
    martMvRefreshMinIntervalSeconds: process.env.MART_MV_REFRESH_MIN_INTERVAL_SECONDS,
    actualCogsIngestIntervalSeconds: process.env.ACTUAL_COGS_INGEST_INTERVAL_SECONDS,
    backfillMetricsRefreshSeconds: process.env.BACKFILL_METRICS_REFRESH_SECONDS,
    externalReconMaxConcurrentDays: process.env.EXTERNAL_RECON_MAX_CONCURRENT_DAYS,
    externalReconScanMinIntervalMinutes: process.env.EXTERNAL_RECON_SCAN_MIN_INTERVAL_MINUTES,
    cloverPaymentsRetentionDays: process.env.CLOVER_PAYMENTS_RETENTION_DAYS,
    forecastRefreshHourUtc: process.env.FORECAST_REFRESH_HOUR_UTC,
    cloverRestMaxConcurrency: process.env.CLOVER_REST_MAX_CONCURRENCY,
    cloverRestRequestsPerSecond: process.env.CLOVER_REST_REQUESTS_PER_SECOND,
    squareEnvironment: process.env.SQUARE_ENVIRONMENT,
    sqlStatementTimeoutMs: process.env.SQL_STATEMENT_TIMEOUT_MS,
    aiQueryRowLimit: process.env.AI_QUERY_ROW_LIMIT
  });
}

export function requireCloverConfig(config: AppConfig) {
  if (!config.cloverMerchantId || !config.cloverToken) {
    throw new Error("CLOVER_MERCHANT_ID and CLOVER_TOKEN are required for Clover backfill.");
  }

  return {
    merchantId: config.cloverMerchantId,
    token: config.cloverToken
  };
}

export function requireCloverServiceConfig(config: AppConfig) {
  const clover = requireCloverConfig(config);
  return {
    ...clover,
    webhookAuthCode: config.cloverWebhookAuthCode ?? null
  };
}

function optionalNonEmptyString() {
  return z.preprocess(
    (value) => value === "" ? undefined : value,
    z.string().min(1).optional()
  );
}
