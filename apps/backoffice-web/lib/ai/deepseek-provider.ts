import { createDeepSeek, type DeepSeekProvider } from "@ai-sdk/deepseek";
import { getSetting } from "@/lib/settings";
import { BRAND_SCOPE_ID } from "@/lib/settings/tenancy";

/**
 * DeepSeek provider — wraps `@ai-sdk/deepseek` with an operator-rotatable API key.
 *
 * Resolution order (Phase B of the AppSetting-as-secret-store pivot, 2026-05-27):
 *
 *   1. `ai.deepseek_api_key` AppSetting row (category=secret) — written by an
 *      operator via /settings/ai, encrypted at rest with AES-GCM, and
 *      decrypted by the existing reader (PR #251).
 *   2. `process.env.DEEPSEEK_API_KEY` — transition fallback for environments
 *      that still pin the key in the stack env. Deprecated; drop after every
 *      deploy has populated the AppSetting row.
 *   3. Otherwise, throw `MissingDeepSeekKeyError`. The chat route already
 *      translates that into a 503 `auth_not_configured` for the browser.
 *
 * Resolved values are cached in-memory per merchant for `CACHE_TTL_MS` so the
 * happy path is one Prisma read every 60s (chat traffic is request-spiky).
 * `invalidateApiKeyCache(merchantId)` punches a hole on PUT so a fresh key
 * takes effect on the next chat request, not 60s later — wired from
 * `app/api/settings/route.ts`'s PUT handler.
 *
 * NOTE: ADR-0017 §6 said "the DeepSeek API key stays in env per ADR-0016 §4
 * (secrets-not-settings rule)". That line is superseded for this key by the
 * 2026-05-27 architectural pivot: AppSetting now stores `category=secret` rows
 * with encryption + masking, so operator-rotatable credentials live there
 * rather than in the stack env. Bootstrap secrets (DATABASE_URL,
 * APP_SETTING_ENCRYPTION_KEY, KDS_INTERNAL_ADMIN_TOKEN) still stay in env.
 */

const CACHE_TTL_MS = 60_000;

interface CacheEntry {
  value: string;
  expiresAt: number;
}

const apiKeyCache = new Map<string, CacheEntry>();

export class MissingDeepSeekKeyError extends Error {
  constructor() {
    super(
      "DeepSeek API key not configured — set in /settings/ai or via DEEPSEEK_API_KEY env (deprecated)",
    );
    this.name = "MissingDeepSeekKeyError";
  }
}

export function invalidateApiKeyCache(merchantId: string = BRAND_SCOPE_ID): void {
  apiKeyCache.delete(merchantId);
}

// Exposed for tests; the chat route should call `createProvider()` which wraps
// resolution + caching + provider construction in one call.
export async function resolveDeepSeekApiKey(
  merchantId: string = BRAND_SCOPE_ID,
): Promise<string> {
  const cached = apiKeyCache.get(merchantId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  // `getSetting` returns the registry default (empty string) for missing or
  // unreadable rows, so an empty result here means "no DB value" — fall
  // through to env. The DB read decrypts via the lib/settings/db.ts secret
  // pathway (#251); we never see ciphertext at this layer.
  const fromDb = await getSetting("ai.deepseek_api_key");
  const dbKey = typeof fromDb === "string" ? fromDb.trim() : "";
  if (dbKey.length > 0) {
    apiKeyCache.set(merchantId, { value: dbKey, expiresAt: Date.now() + CACHE_TTL_MS });
    return dbKey;
  }

  const envKey = process.env.DEEPSEEK_API_KEY?.trim() ?? "";
  if (envKey.length > 0) {
    apiKeyCache.set(merchantId, { value: envKey, expiresAt: Date.now() + CACHE_TTL_MS });
    return envKey;
  }

  throw new MissingDeepSeekKeyError();
}

export async function createProvider(): Promise<DeepSeekProvider> {
  const apiKey = await resolveDeepSeekApiKey();
  return createDeepSeek({ apiKey });
}
