import { afterEach, describe, expect, it, vi } from "vitest";
import type { Redis } from "ioredis";
import type { AppConfig } from "../src/config.js";
import { CloverRateLimiter } from "../src/lib/clover-rate-limiter.js";

function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    nodeEnv: "test",
    apiPort: 4000,
    appBaseUrl: "https://kds.example.com",
    sessionSecret: "test-secret",
    databaseUrl: "postgres://example",
    redisUrl: "redis://example",
    webLoginUsername: "admin",
    webLoginPasswordHash: "hash",
    webLoginDisplayName: "Kitchen Admin",
    webauthnRpId: "kds.example.com",
    webauthnRpName: "Example Kitchen KDS",
    webSessionTtlHours: 12,
    cloverBaseUrl: "https://api.clover.com",
    cloverRegion: "US",
    cloverMerchantId: undefined,
    cloverToken: undefined,
    cloverAppId: undefined,
    cloverAppSecret: undefined,
    cloverWebhookAuthCode: undefined,
    deliverectWebhookSecret: undefined,
    deliverectWebhookSignatureHeader: "x-server-authorization-hmac-sha256",
    deliverectApiUrl: "https://api.deliverect.com",
    deliverectStagingApiUrl: "https://staging.deliverect.com",
    kdsCloverBucketRealtime: "10:10",
    kdsCloverBucketRecon: "6:6",
    kdsCloverBucketGlobal: "12:12",
    reconcileIntervalMs: 45_000,
    workerIntervalMs: 1_000,
    dailyResetEnabled: false,
    dailyResetHour: 21,
    dailyResetMinute: 0,
    dailyResetTimezone: "UTC",
    dailyResetCheckIntervalMs: 30_000,
    ...overrides
  } as AppConfig;
}

/**
 * Minimal in-memory Redis honoring exactly the operations withMerchantLock uses:
 * `SET key val PX ttl NX`, `GET key`, `DEL key`. TTL expiry is modeled off the
 * mocked clock (vi fake timers) so a lock can be exercised deterministically.
 */
function createFakeRedis() {
  const store = new Map<string, { value: string; expiresAt: number }>();

  const isLive = (key: string) => {
    const entry = store.get(key);
    if (!entry) {
      return false;
    }
    if (entry.expiresAt <= Date.now()) {
      store.delete(key);
      return false;
    }
    return true;
  };

  const redis = {
    set: vi.fn(async (key: string, value: string, _px: "PX", ttlMs: number, _nx: "NX") => {
      if (isLive(key)) {
        return null;
      }
      store.set(key, { value, expiresAt: Date.now() + ttlMs });
      return "OK";
    }),
    get: vi.fn(async (key: string) => (isLive(key) ? store.get(key)!.value : null)),
    del: vi.fn(async (key: string) => (store.delete(key) ? 1 : 0))
  };

  return { redis: redis as unknown as Redis, store };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("CloverRateLimiter.withMerchantLock (GH #134)", () => {
  it("serializes concurrent refreshes for the same merchant", async () => {
    const { redis } = createFakeRedis();
    const limiter = new CloverRateLimiter(redis, makeConfig());

    let active = 0;
    let maxConcurrent = 0;
    const order: string[] = [];

    const task = (label: string) =>
      limiter.withMerchantLock("merchant-1", async () => {
        active += 1;
        maxConcurrent = Math.max(maxConcurrent, active);
        order.push(`${label}:start`);
        // Yield so a non-serialized implementation would interleave here.
        await Promise.resolve();
        await Promise.resolve();
        order.push(`${label}:end`);
        active -= 1;
        return label;
      });

    const results = await Promise.all([task("a"), task("b"), task("c")]);

    // All three ran (acquisition order is intentionally NOT asserted — the lock
    // uses a randomized backoff between attempts, so contenders b and c may
    // acquire in either order; only mutual exclusion is guaranteed).
    expect(results.sort()).toEqual(["a", "b", "c"]);

    // The critical invariant: only ever one holder inside the lock at a time.
    expect(maxConcurrent).toBe(1);

    // No interleaving: every task's `:start` is immediately followed by its own
    // `:end` before any other task starts.
    expect(order).toHaveLength(6);
    for (let i = 0; i < order.length; i += 2) {
      const [startLabel, startEvent] = order[i].split(":");
      const [endLabel, endEvent] = order[i + 1].split(":");
      expect(startEvent).toBe("start");
      expect(endEvent).toBe("end");
      expect(startLabel).toBe(endLabel);
    }
  });

  it("lets a different merchant proceed in parallel", async () => {
    const { redis } = createFakeRedis();
    const limiter = new CloverRateLimiter(redis, makeConfig());

    let bothInside = false;
    let releaseFirst: () => void = () => undefined;
    const firstHeld = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = limiter.withMerchantLock("merchant-1", async () => {
      await firstHeld;
    });
    const second = limiter.withMerchantLock("merchant-2", async () => {
      // Reaching here while merchant-1 still holds its lock proves locks are
      // per-merchant, not global.
      bothInside = true;
      releaseFirst();
    });

    await Promise.all([first, second]);
    expect(bothInside).toBe(true);
  });

  it("releases the lock only when the stored token still matches (fenced release)", async () => {
    const { redis, store } = createFakeRedis();
    const limiter = new CloverRateLimiter(redis, makeConfig());

    await limiter.withMerchantLock("merchant-1", async () => {
      // Simulate a TTL-expired holder being overwritten by a successor: the key
      // now carries a different token, so this holder must NOT delete it.
      store.set("clover:merchant:merchant-1:token-refresh-lock", {
        value: "someone-elses-token",
        expiresAt: Date.now() + 60_000
      });
    });

    expect(store.get("clover:merchant:merchant-1:token-refresh-lock")?.value).toBe("someone-elses-token");
  });
});
