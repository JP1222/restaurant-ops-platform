import { z } from "zod";

// Normalize empty-string env values to `undefined` before validation, so
// docker-compose `${VAR:-}` expansions don't crash optional fields. Mirrors the
// pattern in apps/kds-api/src/config.ts.
const ConfigSchema = z.preprocess(
  (raw) =>
    Object.fromEntries(
      Object.entries((raw as Record<string, unknown>) ?? {}).map(([k, v]) => [
        k,
        v === "" ? undefined : v
      ])
    ),
  z.object({
    nodeEnv: z.enum(["development", "test", "production"]).default("development"),
    apiPort: z.coerce.number().int().min(1).max(65535).default(4100),
    inventoryDatabaseUrl: z.string().min(1),
    // Multi-tenant RLS (ADR-0818 / #902 Phase 1): the runtime connection used by
    // the app, which a later slice points at the non-superuser, RLS-forced `yr_app`
    // role while migrations keep using the owner `inventoryDatabaseUrl`. Optional +
    // falls back to the owner URL when unset, so the split is a pure env-provisioning
    // step at cutover with no code change and no crash-loop if it isn't wired yet.
    inventoryRuntimeDatabaseUrl: z.string().min(1).optional(),
    backofficeBaseUrl: z.string().url().default("http://localhost:3001"),
    crewBaseUrl: z.string().url().default("http://localhost:3003"),
    // Bearer token for trusted server-to-server writes (backoffice BFF). In
    // production a write with no configured token is refused.
    internalToken: z.string().min(16).optional(),
    // Crew PIN auth (Phase 5): HMAC secret for stateless session tokens + keyed
    // pepper for the PIN lookup index. Required in production (crew login fails
    // closed without them); dev falls back to fixed defaults that match the
    // db-inventory seed so seeded PINs resolve locally.
    crewSessionSecret: z.string().min(16).optional(),
    crewPinPepper: z.string().min(16).optional(),
    // Reverse-proxy trust for `request.ip` / X-Forwarded-For. The PIN limiter
    // keys on `request.ip`, so behind Traefik we MUST consume XFF or
    // every device shares one ingress IP and locks each other out (issue #121).
    // Accepts a comma-separated allowlist of trusted proxy IPs / CIDRs (e.g.
    // "10.0.0.0/8,172.16.0.0/12"). Leave empty in dev / direct-connect to keep
    // XFF spoofing rejected. Anything other than this allowlist is ignored, so
    // an attacker can't inject XFF unless they're already on the proxy network.
    trustProxyCidr: z.string().optional(),
    // Sales-driven depletion (ADR-0028 / S4): inventory polls analytics-api's
    // read-only sold-items feed over HTTP (Iron Law 5 — never its DB). All
    // optional; the sync endpoint reports "not configured" if any is missing, so a
    // dev / single-store install without analytics wired simply can't sync yet.
    // analyticsAdminToken is a Layer-1 secret (ADR-0020), injected at runtime.
    analyticsApiUrl: z.string().url().optional(),
    analyticsAdminToken: z.string().min(1).optional(),
    cloverMerchantId: z.string().min(1).optional(),
    // Cloudflare R2 (object storage) for archived receipt images (receipt-archive).
    // ALL optional: unset => image archiving is skipped (a receive still succeeds, just
    // with no stored photo), so dev and a fresh install run without R2 wired. R2 is
    // S3-compatible, talked to via @aws-sdk/client-s3 — these are app-runtime creds
    // (Infisical prod path `/`), DISTINCT from the rclone-shaped RCLONE_CONFIG_R2_*
    // the host Postgres backup uses (those live at `/backup`). region is "auto" for R2.
    r2Endpoint: z.string().url().optional(),
    r2AccessKeyId: z.string().min(1).optional(),
    r2SecretAccessKey: z.string().min(1).optional(),
    r2ReceiptBucket: z.string().min(1).optional(),
    r2Region: z.string().min(1).default("auto"),
    // Open Food Facts barcode lookup for scan-to-register auto-fill (barcode-onboarding ADR, D3).
    // Calls the free OFF public API (no key, no cost). A scanned UPC is a public product barcode,
    // not sensitive data, and the owner approved this egress (2026-06-20) in favor of self-hosting
    // a multi-GB SQLite copy. Defaulted on; the lookup FAILS OPEN, so an unreachable OFF just yields
    // a blank review form. Override OFF_API_BASE_URL only to point at a mirror / mock.
    offApiBaseUrl: z.string().url().default("https://world.openfoodfacts.org"),
    // Operator notifications (Phase 5): inventory emits an 86 to notifications-api's
    // ingest endpoint over HTTP (only it writes db-notifications, Iron Law 1). Both
    // optional — unset => emitting is skipped (the 86 still succeeds), so dev / a
    // not-yet-wired install runs quietly. The token is a Layer-1 secret (ADR-0020),
    // injected at runtime; MUST match NOTIFICATIONS_INTERNAL_TOKEN on notifications-api.
    notificationsApiUrl: z.string().url().optional(),
    notificationsInternalToken: z.string().min(16).optional()
  })
);

export type AppConfig = z.infer<typeof ConfigSchema>;

export function loadConfig(): AppConfig {
  const isProd = process.env.NODE_ENV === "production";
  return ConfigSchema.parse({
    nodeEnv: process.env.NODE_ENV,
    apiPort: process.env.INVENTORY_API_PORT,
    inventoryDatabaseUrl: process.env.INVENTORY_DATABASE_URL,
    inventoryRuntimeDatabaseUrl: process.env.INVENTORY_RUNTIME_DATABASE_URL,
    backofficeBaseUrl: process.env.BACKOFFICE_BASE_URL,
    crewBaseUrl: process.env.CREW_BASE_URL,
    internalToken: process.env.INVENTORY_INTERNAL_TOKEN,
    crewSessionSecret:
      process.env.CREW_SESSION_SECRET ?? (isProd ? undefined : "dev-crew-session-secret-change-me"),
    crewPinPepper:
      process.env.CREW_PIN_PEPPER ?? (isProd ? undefined : "dev-crew-pin-pepper-change-me"),
    trustProxyCidr: process.env.TRUST_PROXY_CIDR,
    analyticsApiUrl: process.env.INTERNAL_ANALYTICS_API_URL,
    analyticsAdminToken: process.env.ANALYTICS_ADMIN_TOKEN,
    cloverMerchantId: process.env.CLOVER_MERCHANT_ID,
    r2Endpoint: process.env.R2_ENDPOINT,
    r2AccessKeyId: process.env.R2_ACCESS_KEY_ID,
    r2SecretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    r2ReceiptBucket: process.env.RECEIPT_R2_BUCKET,
    r2Region: process.env.R2_REGION,
    offApiBaseUrl: process.env.OFF_API_BASE_URL,
    notificationsApiUrl: process.env.INTERNAL_NOTIFICATIONS_API_URL,
    notificationsInternalToken: process.env.NOTIFICATIONS_INTERNAL_TOKEN
  });
}
