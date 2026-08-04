import { z } from "zod";

// Normalize empty-string env values to `undefined` BEFORE field validation.
//
// Why this exists: docker-compose's `${VAR:-}` syntax (used throughout
// compose/) expands to an empty string when the host env is unset.
// In Node, `process.env.VAR` then comes through as `""`, not `undefined`.
// zod's `.optional()` only accepts `undefined`, so any `.string().min(N).optional()`
// field would reject the empty string with "Too small" — taking down EVERY
// API route that imports getServerEnv(), not just the route that actually
// uses that env. (We learned this the hard way when `/api/today` died because
// GITHUB_PIPELINE_TOKEN was empty.)
//
// Treating "" as "unset" at the schema boundary lets each field's `.optional()`
// behave the way the field-level comments promise.
// Exported for unit-test access (tests/lib/env.test.ts). Application code
// should always go through `getServerEnv()` for caching + a clearer name.
export const ServerEnvSchema = z.preprocess(
  (raw) =>
    Object.fromEntries(
      Object.entries((raw as Record<string, unknown>) ?? {}).map(([k, v]) => [
        k,
        v === "" ? undefined : v,
      ])
    ),
  z.object({
    ANALYTICS_ADMIN_TOKEN: z.string().min(1),
    INTERNAL_ANALYTICS_API_URL: z.string().url(),
    // Multi-tenant (ADR-0818 Phase 2c): shared HMAC secret to SIGN the
    // AnalyticsTenantClaim that analytics-api verifies (same value as analytics'
    // ANALYTICS_TENANT_SIGNING_KEY). Optional → the BFF mints no claim when
    // unset (default), so analytics stays in its off-mode; set it during the
    // observe→enforce rollout. Cross-service shared secret, like
    // ANALYTICS_ADMIN_TOKEN (env / Layer-1), not an app_setting row.
    ANALYTICS_TENANT_SIGNING_KEY: z.string().min(1).optional(),
    // KDS admin bearer + internal URL (Phase 4 backoffice-admin migration).
    // Optional so analytics/Ops pages keep working before the operator adds
    // these vars to the production env. When unset, /admin/devices and
    // /admin/board return 503 instead of 500. See lib/kds-api/client.ts.
    KDS_INTERNAL_ADMIN_TOKEN: z.string().min(16).optional(),
    INTERNAL_KDS_API_URL: z.string().url().optional(),
    // inventory-api (Phase 4). Optional so other pages keep working before the
    // operator points backoffice at it — when unset the inventory page returns
    // 503. The token is attached to writes; inventory-api requires it in
    // production (reads are open).
    INTERNAL_INVENTORY_API_URL: z.string().url().optional(),
    INVENTORY_INTERNAL_TOKEN: z.string().min(16).optional(),
    // crm-api (loyalty/CRM). Optional so the rest of backoffice works before the
    // operator points it at the crm service — when unset the /guests page reports
    // "not connected" instead of erroring. crm-api requires the bearer for every
    // non-public route (the cohorts read included).
    INTERNAL_CRM_API_URL: z.string().url().optional(),
    CRM_INTERNAL_TOKEN: z.string().min(16).optional(),
    // notifications-api (operator bell/inbox). Optional so the rest of backoffice
    // works — AND so the bell/inbox keep showing the bundled sample data — before
    // the operator points it at the service. When set, the BFF proxies to the live
    // service; when unset, the BFF serves sample data in-memory (ADR-0801 Phase 3).
    // notifications-api requires the bearer on every route.
    INTERNAL_NOTIFICATIONS_API_URL: z.string().url().optional(),
    NOTIFICATIONS_INTERNAL_TOKEN: z.string().min(16).optional(),
    // GitHub PAT for the pipeline dashboard (read) AND the Operations panel
    // (read + write). Fine-grained scopes:
    //   - actions:read        — workflow runs/jobs (pipeline + Operations)
    //   - read:packages       — GHCR image versions (Images card)
    //   - actions:write        — dispatch build-images.yml (Deploy button)
    //   - administration:read  — list self-hosted runners (Runners card)
    //   - variables:write      — read/write the BUILD_RUNNER repo var (Build routing)
    // Read-only routes degrade to 503 when missing; the write routes require it.
    GITHUB_PIPELINE_TOKEN: z.string().min(1).optional(),
    GITHUB_REPO_OWNER: z.string().min(1).default("example-org"),
    GITHUB_REPO_NAME: z.string().min(1).default("restaurant-ops-platform"),
    BACKOFFICE_SESSION_COOKIE_NAME: z.string().min(1).default("rop_backoffice_session"),
  })
);

export type ServerEnv = z.infer<typeof ServerEnvSchema>;

let cached: ServerEnv | undefined;

export function getServerEnv(): ServerEnv {
  if (cached) {
    return cached;
  }

  const parsed = ServerEnvSchema.safeParse(process.env);
  if (!parsed.success) {
    throw new Error(
      `Invalid backoffice-web server env:\n${parsed.error.issues
        .map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`)
        .join("\n")}`
    );
  }

  cached = parsed.data;
  return cached;
}
