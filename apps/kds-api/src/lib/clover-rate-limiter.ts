import { randomUUID } from "node:crypto";
import type { Redis } from "ioredis";
import type { AppConfig } from "../config.js";
import { kdsCloverRateLimitWaitSeconds } from "./metrics.js";

export type CloverRateBucket = "realtime" | "recon";

// Per-merchant Clover token-refresh lock timings (GH #134). See withMerchantLock
// for the rationale; TTL must exceed the worst-case refresh duration and the
// wait must outlast the TTL so a contender never times out under a healthy
// holder on a slow network.
const LOCK_TTL_MS = 60_000;
const LOCK_WAIT_MS = 65_000;

type BucketSpec = {
  capacity: number;
  refillPerSec: number;
};

const TOKEN_BUCKET_SCRIPT = `
local now = tonumber(ARGV[1])
local bucket_count = tonumber(ARGV[2])
local max_wait = 0
local states = {}

for i = 1, bucket_count do
  local capacity = tonumber(ARGV[2 + ((i - 1) * 2) + 1])
  local refill = tonumber(ARGV[2 + ((i - 1) * 2) + 2])
  local key = KEYS[i]
  local values = redis.call("HMGET", key, "tokens", "ts")
  local tokens = tonumber(values[1])
  local ts = tonumber(values[2])
  if tokens == nil then tokens = capacity end
  if ts == nil then ts = now end

  local elapsed = math.max(0, now - ts)
  tokens = math.min(capacity, tokens + (elapsed * refill / 1000))
  states[i] = { key, tokens, now, capacity, refill }

  if tokens < 1 then
    local wait = math.ceil((1 - tokens) * 1000 / refill)
    if wait > max_wait then max_wait = wait end
  end
end

if max_wait > 0 then
  for i = 1, bucket_count do
    redis.call("HMSET", states[i][1], "tokens", states[i][2], "ts", states[i][3])
    redis.call("PEXPIRE", states[i][1], 60000)
  end
  return max_wait
end

for i = 1, bucket_count do
  redis.call("HMSET", states[i][1], "tokens", states[i][2] - 1, "ts", states[i][3])
  redis.call("PEXPIRE", states[i][1], 60000)
end
return 0
`;

export class CloverRateLimiter {
  private readonly realtime: BucketSpec;
  private readonly recon: BucketSpec;
  private readonly global: BucketSpec;

  constructor(
    private readonly redis: Redis,
    config: AppConfig
  ) {
    this.realtime = parseBucketSpec(config.kdsCloverBucketRealtime);
    this.recon = parseBucketSpec(config.kdsCloverBucketRecon);
    this.global = parseBucketSpec(config.kdsCloverBucketGlobal);
  }

  async acquire(bucket: CloverRateBucket) {
    const classSpec = bucket === "recon" ? this.recon : this.realtime;
    const keys = ["clover:bucket:global", `clover:bucket:${bucket}`];
    const args = [
      Date.now(),
      keys.length,
      this.global.capacity,
      this.global.refillPerSec,
      classSpec.capacity,
      classSpec.refillPerSec
    ].map(String);

    while (true) {
      const waitMs = Number(await this.redis.eval(TOKEN_BUCKET_SCRIPT, keys.length, ...keys, ...args));
      if (!Number.isFinite(waitMs) || waitMs <= 0) {
        return;
      }

      kdsCloverRateLimitWaitSeconds.observe({ bucket }, waitMs / 1000);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      args[0] = String(Date.now());
    }
  }

  /**
   * Serialize Clover token refreshes for one merchant across all workers via a
   * Redis SET NX lock. Lock strategy (GH #134):
   *
   * - TTL 60s: the lock auto-expires this long after acquisition so a crashed
   *   holder can never wedge a merchant permanently. It MUST exceed the worst
   *   plausible refresh time — a single Clover token call is capped at
   *   {@link CLOVER_FETCH_TIMEOUT_MS} (10s), and a refresh-then-recovery does at
   *   most two such calls, so 60s leaves a wide margin even on a slow network.
   *   The old 30s TTL could expire mid-refresh on a slow link, letting a second
   *   caller acquire the lock and issue a duplicate refresh.
   * - Wait 65s: a contender blocks slightly past the TTL so it outlasts a holder
   *   that ran the full TTL, then either acquires the freed lock or observes the
   *   refreshed token (refreshWithLock re-reads after acquiring) — instead of
   *   timing out and erroring.
   * - Fenced release: only the holder whose token still matches deletes the key,
   *   so a caller that overran the TTL never deletes a successor's lock.
   */
  async withMerchantLock<T>(merchantId: string, task: () => Promise<T>) {
    const key = `clover:merchant:${merchantId}:token-refresh-lock`;
    const startedAt = Date.now();
    let token = randomUUID();

    while (true) {
      const acquired = await this.redis.set(key, token, "PX", LOCK_TTL_MS, "NX");
      if (acquired === "OK") {
        break;
      }

      if (Date.now() - startedAt > LOCK_WAIT_MS) {
        throw new Error(`Timed out waiting for Clover token refresh lock for merchant ${merchantId}.`);
      }

      await new Promise((resolve) => setTimeout(resolve, 100 + Math.floor(Math.random() * 100)));
      token = randomUUID();
    }

    try {
      return await task();
    } finally {
      const current = await this.redis.get(key);
      if (current === token) {
        await this.redis.del(key);
      }
    }
  }
}

function parseBucketSpec(value: string): BucketSpec {
  const [capacityRaw, refillRaw] = value.split(":");
  const capacity = Number(capacityRaw);
  const refillPerSec = Number(refillRaw);
  if (!Number.isFinite(capacity) || !Number.isFinite(refillPerSec) || capacity <= 0 || refillPerSec <= 0) {
    throw new Error(`Invalid Clover bucket spec: ${value}`);
  }

  return { capacity, refillPerSec };
}
