import { Redis } from "ioredis";
import type { SettingKey } from "@rop/contracts";
import { getSetting } from "@/lib/settings";

/**
 * Per-surface AI rate-limit backed by Redis. Reuses the
 * `globalThis.__ropBackofficeAuth.redis` singleton populated by
 * `lib/auth/service.ts` so we never open a second connection pool. If the
 * auth service hasn't been touched yet (e.g. in vitest), we lazily create a
 * client on demand and stash it on the same global cache so subsequent
 * imports share it.
 *
 * Each `scope` gets its OWN Redis counter + its OWN settings key so the
 * manager-facing chat assistant and the Floor invoice-scan can't starve each
 * other (a shared bucket let a chat burst 429 a cook's scan). The per-minute
 * ceiling resolves through `lib/settings` so the `/settings/ai` UI, the env
 * var, and the `settingsRegistry` default all share one cascade
 * (DB > env > default).
 *
 * The best-effort scan assists (match-suggest, emoji-suggest) are deliberately
 * NOT rate-limited — they degrade silently and only fire after a parse has
 * already passed the `scan` limit, so the parse ceiling bounds them upstream;
 * the kill switch remains their spend brake.
 */
type RateLimitGlobals = { redis?: Redis };

function getRedis(): Redis {
  const globals = globalThis as typeof globalThis & {
    __ropBackofficeAuth?: { redis?: Redis };
    __ropAiRateLimit?: RateLimitGlobals;
  };
  if (globals.__ropBackofficeAuth?.redis) return globals.__ropBackofficeAuth.redis;
  globals.__ropAiRateLimit ??= {};
  globals.__ropAiRateLimit.redis ??= new Redis(
    process.env.REDIS_URL ?? "redis://localhost:6379",
    {
      lazyConnect: true,
      maxRetriesPerRequest: 3,
      enableReadyCheck: false,
    },
  );
  return globals.__ropAiRateLimit.redis;
}

const WINDOW_SECONDS = 60;

// The metered AI surfaces that each get an independent bucket. `chat` is the
// manager-facing assistant; `scan` is the Floor invoice-scan (receipt-parse).
// Adding a scope here is the ONLY place the bucketing policy lives — give the
// new scope its own settings key below so it can't borrow another's ceiling.
export type RateLimitScope = "chat" | "scan";

// The two number-valued settings that hold a per-minute ceiling. `Extract` from
// SettingKey keeps these typo-safe (a bad key collapses to `never` and fails the
// literal below) AND lets getSetting infer a numeric return (a bare SettingKey
// would widen it to the full string|number|boolean|array union).
type RateLimitSettingKey = Extract<
  SettingKey,
  "ai.rate_limit_per_minute" | "ai.scan_rate_limit_per_minute"
>;

// scope → counter key (one Redis key per surface) and the settings key that
// supplies its per-minute ceiling. Keeping these distinct per scope is what
// decouples the surfaces: a different key means a different counter, and a
// different setting means an independently tunable ceiling.
const SCOPE_CONFIG: Record<RateLimitScope, { key: string; setting: RateLimitSettingKey }> = {
  chat: { key: "ai:ratelimit:chat", setting: "ai.rate_limit_per_minute" },
  scan: { key: "ai:ratelimit:scan", setting: "ai.scan_rate_limit_per_minute" },
};

export interface RateLimitResult {
  ok: boolean;
  remaining: number;
  retryAfterSeconds?: number;
}

export async function checkAiRateLimit(
  scope: RateLimitScope,
  limitPerMin?: number,
): Promise<RateLimitResult> {
  const { key, setting } = SCOPE_CONFIG[scope];
  const limit = limitPerMin ?? (await getSetting(setting));
  const redis = getRedis();
  const pipeline = redis.multi();
  pipeline.incr(key);
  // EXPIRE … NX sets the TTL only on the first INCR of a window so the
  // counter naturally rolls over after 60 seconds even if the operator keeps
  // hammering the route.
  pipeline.expire(key, WINDOW_SECONDS, "NX");
  const results = await pipeline.exec();
  const incrResult = results?.[0];
  const current = Number(Array.isArray(incrResult) ? incrResult[1] : 0);

  if (current > limit) {
    const ttl = await redis.ttl(key);
    return {
      ok: false,
      remaining: 0,
      retryAfterSeconds: Math.max(1, ttl),
    };
  }

  return { ok: true, remaining: Math.max(0, limit - current) };
}
