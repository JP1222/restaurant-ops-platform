import { z } from "zod";

const EnvBooleanSchema = z.preprocess((value) => {
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) {
      return true;
    }
    if (["0", "false", "no", "off", ""].includes(normalized)) {
      return false;
    }
  }
  return value;
}, z.boolean());

// Normalize empty-string env values to `undefined` BEFORE field validation.
//
// docker-compose's `${VAR:-}` syntax (used throughout compose/kds.yml
// for optional fields like WEB_LOGIN_USERNAME, WEB_LOGIN_PASSWORD_HASH,
// DELIVERECT_WEBHOOK_SECRET, etc.) expands to "" when the host env is unset.
// Many fields below are declared as `.string().min(N).optional()` — zod's
// `.optional()` accepts `undefined`, NOT `""`, so an empty-string from compose
// crashes loadConfig() with "Too small" and kds-api fails to boot.
//
// Same pattern is applied in apps/backoffice-web/lib/env.ts (PR #72) for the
// same reason. analytics-api uses a per-field helper instead — same effect.
const ConfigSchema = z.preprocess(
  (raw) =>
    Object.fromEntries(
      Object.entries((raw as Record<string, unknown>) ?? {}).map(([k, v]) => [
        k,
        v === "" ? undefined : v,
      ])
    ),
  z.object({
  nodeEnv: z.enum(["development", "test", "production"]).default("development"),
  apiPort: z.coerce.number().int().min(1).max(65535).default(4000),
  appBaseUrl: z.string().url().default("http://localhost:3000"),
  // Where the kds-web Floor app is reachable — the base for device-pairing links
  // (ADR-0818 Phase-2b: `${kdsWebBaseUrl}/pair?code=…`). Optional; falls back to
  // appBaseUrl (kds-web IS the app this server fronts).
  kdsWebBaseUrl: z.string().url().optional(),
  // TTL of a one-time device-pairing claim code (seconds). Short by design — long
  // enough to walk a code to a back-kitchen tablet, short enough to limit a leaked
  // link. The durable device token it mints has NO expiry (revoke-only).
  pairClaimTtlSeconds: z.coerce.number().int().min(60).max(3600).default(600),
  sessionSecret: z.string().min(8).default("replace-me"),
  databaseUrl: z.string().min(1),
  redisUrl: z.string().min(1),
  webLoginUsername: z.string().min(1).optional(),
  webLoginPasswordHash: z.string().min(1).optional(),
  webLoginDisplayName: z.string().min(1).default("Kitchen Admin"),
  webauthnRpId: z.string().min(1).optional(),
  webauthnRpName: z.string().min(1).default("Example Kitchen KDS"),
  webSessionTtlHours: z.coerce.number().int().min(1).max(24 * 30).default(12),
  // Bearer token that lets Backoffice (and other internal services) call
  // /api/admin/* without a browser session. Unset = bearer auth refused.
  kdsInternalAdminToken: z.string().min(16).optional(),
  // Where Backoffice is reachable; the kds-api /admin redirect (Phase 4
  // closeout) points operators here.
  backofficeBaseUrl: z.string().url().default("http://localhost:3001"),
  cloverBaseUrl: z.string().url().default("https://api.clover.com"),
  cloverRegion: z.string().default("US"),
  deliverectApiUrl: z.string().url().default("https://api.deliverect.com"),
  deliverectStagingApiUrl: z.string().url().default("https://api.staging.deliverect.com"),
  cloverMerchantId: z.string().optional(),
  cloverToken: z.string().optional(),
  cloverAppId: z.string().optional(),
  cloverAppSecret: z.string().optional(),
  cloverWebhookAuthCode: z.string().optional(),
  // GH #154: how old the most recent Clover sync may be before /api/ready
  // surfaces it as stale. Diagnostic only — it never flips the readiness gate
  // (a stalled sync is operator-actionable, not a reason to roll back a deploy).
  cloverSyncMaxAgeMinutes: z.coerce.number().int().min(1).default(90),
  // Clover Ecommerce (online card payments, ADR-0027) — a DISTINCT host family
  // and auth model from the v3 OAuth client above: charges hit scl.clover.com
  // with the merchant's ECOMMERCE *private* key as a static Bearer, not the
  // per-merchant OAuth token. Host is config-driven (prod default below;
  // sandbox = https://scl-sandbox.dev.clover.com). The public key is browser-
  // side (card tokenization in the hosted iframe); kept here so kds-api can
  // hand it to order-web.
  cloverEcommApiBaseUrl: z.string().url().default("https://scl.clover.com"),
  cloverEcommPublicKey: z.string().optional(),
  cloverEcommPrivateKey: z.string().optional(),
  // Square POS onboarding (store #2; docs/square-onboarding.md). The SDK host is
  // driven by `squareEnvironment` (Sandbox/Production), so no base-URL field is
  // needed. `squareAccessToken` is the dev/sandbox PAT consumed ONLY by
  // bootstrapSquareAccountFromEnv (a no-op when unset); in prod the token comes
  // from the operator connect flow, never from env.
  squareEnvironment: z.enum(["sandbox", "production"]).default("sandbox"),
  squareAccessToken: z.string().optional(),
  // After a Square store connects, kds-api registers it as an analytics sync
  // target (Phase 4 PR-F). Both optional → the push is a no-op when unset (local
  // dev without analytics, or before the secret is provisioned). The URL reuses
  // the existing INTERNAL_ANALYTICS_API_URL; the token is the scoped push bearer.
  analyticsInternalUrl: z.string().optional(),
  kdsAnalyticsPushToken: z.string().optional(),
  deliverectWebhookSecret: z.string().optional(),
  deliverectWebhookSignatureHeader: z.string().default("x-server-authorization-hmac-sha256"),
  reconcileIntervalMs: z.coerce.number().int().min(10_000).default(45_000),
  workerIntervalMs: z.coerce.number().int().min(500).default(1_000),
  kdsWorkerConcurrency: z.coerce.number().int().min(1).max(64).default(8),
  kdsFulfillmentWorkerConcurrency: z.coerce.number().int().min(1).max(64).default(4),
  kdsCloverBucketRealtime: z.string().regex(/^\d+:\d+$/).default("10:10"),
  kdsCloverBucketRecon: z.string().regex(/^\d+:\d+$/).default("6:6"),
  kdsCloverBucketGlobal: z.string().regex(/^\d+:\d+$/).default("12:12"),
  kdsRealtimeBackfillLimit: z.coerce.number().int().min(1).max(1000).default(250),
  dailyResetEnabled: EnvBooleanSchema.default(false),
  dailyResetHour: z.coerce.number().int().min(0).max(23).default(21),
  dailyResetMinute: z.coerce.number().int().min(0).max(59).default(0),
  dailyResetTimezone: z.string().min(1).default("UTC"),
  dailyResetCheckIntervalMs: z.coerce.number().int().min(10_000).default(30_000),
  // Multi-tenant enforcement mode (ADR-0818, Phase 2c). Gates the fail-closed,
  // tenant-validated merchant resolution in kds-auth.ts. Default `off` = today's
  // behavior byte-for-byte (no tenant check, no extra query). `observe` = a
  // dual-read parity window: compute the tenant-scoped resolution and log when it
  // diverges from the legacy one, but still RETURN the legacy result (zero
  // behavior change, observability only). `enforce` = return the tenant-scoped
  // result and fail closed (null → 400/403) on a cross-tenant / unknown merchant.
  // Flip off → observe → enforce only after verifying parity in Loki.
  multiTenantMode: z.enum(["off", "observe", "enforce"]).default("off")
  })
);

// Exported for tests in tests/config.test.ts.
export { ConfigSchema };

export type AppConfig = ReturnType<typeof loadConfig>;

export function loadConfig() {
  return ConfigSchema.parse({
    nodeEnv: process.env.NODE_ENV,
    apiPort: process.env.API_PORT,
    appBaseUrl: process.env.APP_BASE_URL,
    kdsWebBaseUrl: process.env.KDS_WEB_BASE_URL,
    pairClaimTtlSeconds: process.env.PAIR_CLAIM_TTL_SECONDS,
    sessionSecret: process.env.SESSION_SECRET,
    databaseUrl: process.env.DATABASE_URL,
    redisUrl: process.env.REDIS_URL,
    webLoginUsername: process.env.WEB_LOGIN_USERNAME,
    webLoginPasswordHash: process.env.WEB_LOGIN_PASSWORD_HASH,
    webLoginDisplayName: process.env.WEB_LOGIN_DISPLAY_NAME,
    webauthnRpId: process.env.WEBAUTHN_RP_ID,
    webauthnRpName: process.env.WEBAUTHN_RP_NAME,
    webSessionTtlHours: process.env.WEB_SESSION_TTL_HOURS,
    kdsInternalAdminToken: process.env.KDS_INTERNAL_ADMIN_TOKEN,
    backofficeBaseUrl: process.env.BACKOFFICE_BASE_URL,
    cloverBaseUrl: process.env.CLOVER_BASE_URL,
    cloverRegion: process.env.CLOVER_REGION,
    deliverectApiUrl: process.env.DELIVERECT_API_URL,
    deliverectStagingApiUrl: process.env.DELIVERECT_STAGING_API_URL,
    cloverMerchantId: process.env.CLOVER_MERCHANT_ID,
    cloverToken: process.env.CLOVER_TOKEN,
    cloverAppId: process.env.CLOVER_APP_ID,
    cloverAppSecret: process.env.CLOVER_APP_SECRET,
    cloverWebhookAuthCode: process.env.CLOVER_WEBHOOK_AUTH_CODE,
    cloverSyncMaxAgeMinutes: process.env.CLOVER_SYNC_MAX_AGE_MINUTES,
    cloverEcommApiBaseUrl: process.env.CLOVER_ECOMM_API_BASE_URL,
    cloverEcommPublicKey: process.env.CLOVER_ECOMM_PUBLIC_KEY,
    cloverEcommPrivateKey: process.env.CLOVER_ECOMM_PRIVATE_KEY,
    squareEnvironment: process.env.SQUARE_ENVIRONMENT,
    squareAccessToken: process.env.SQUARE_ACCESS_TOKEN,
    analyticsInternalUrl: process.env.INTERNAL_ANALYTICS_API_URL,
    kdsAnalyticsPushToken: process.env.KDS_ANALYTICS_PUSH_TOKEN,
    deliverectWebhookSecret: process.env.DELIVERECT_WEBHOOK_SECRET,
    deliverectWebhookSignatureHeader: process.env.DELIVERECT_WEBHOOK_SIGNATURE_HEADER,
    reconcileIntervalMs: process.env.RECONCILE_INTERVAL_MS,
    workerIntervalMs: process.env.WORKER_INTERVAL_MS,
    kdsWorkerConcurrency: process.env.KDS_WORKER_CONCURRENCY,
    kdsFulfillmentWorkerConcurrency: process.env.KDS_FULFILLMENT_WORKER_CONCURRENCY,
    kdsCloverBucketRealtime: process.env.KDS_CLOVER_BUCKET_REALTIME,
    kdsCloverBucketRecon: process.env.KDS_CLOVER_BUCKET_RECON,
    kdsCloverBucketGlobal: process.env.KDS_CLOVER_BUCKET_GLOBAL,
    kdsRealtimeBackfillLimit: process.env.KDS_REALTIME_BACKFILL_LIMIT,
    dailyResetEnabled: process.env.DAILY_RESET_ENABLED,
    dailyResetHour: process.env.DAILY_RESET_HOUR,
    dailyResetMinute: process.env.DAILY_RESET_MINUTE,
    dailyResetTimezone: process.env.DAILY_RESET_TIMEZONE ?? process.env.BOARD_TIMEZONE,
    dailyResetCheckIntervalMs: process.env.DAILY_RESET_CHECK_INTERVAL_MS,
    multiTenantMode: process.env.MULTITENANT_MODE
  });
}

export function getCloverWebOrigin(region: string) {
  switch (region.toUpperCase()) {
    case "EU":
      return "https://www.eu.clover.com";
    case "LA":
      return "https://www.la.clover.com";
    default:
      return "https://www.clover.com";
  }
}

export function getCloverApiOrigin(baseUrl: string) {
  return new URL(baseUrl).origin;
}
