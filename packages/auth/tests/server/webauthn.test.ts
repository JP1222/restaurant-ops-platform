import { describe, expect, it } from "vitest";
import type { AuthRedis, AuthRedisPipeline } from "../../src/server/redis.js";
import { createWebAuthnFlow, consumeWebAuthnFlow } from "../../src/server/webauthn.js";
import type { AuthServiceConfig } from "../../src/server/config.js";

const config: AuthServiceConfig = {
  appBaseUrl: "https://kds.example.test",
  webauthnRpName: "Example Kitchen KDS",
  webSessionTtlHours: 12,
  webLoginDisplayName: "Kitchen Admin"
};

/**
 * Redis fake whose MULTI runs its queued commands atomically with respect to
 * the JS event loop — exactly like a real Redis transaction, where the server
 * executes the queued commands without interleaving other clients. This lets us
 * assert the GH #477 single-use guarantee: two overlapping consumes can both be
 * in flight, but only the one whose transaction lands first observes the
 * challenge; the other sees an already-deleted key.
 */
class AtomicFakeRedis implements AuthRedis {
  readonly values = new Map<string, string>();

  async get(key: string) {
    return this.values.get(key) ?? null;
  }

  async set(key: string, value: string, mode: "EX") {
    expect(mode).toBe("EX");
    this.values.set(key, value);
    return "OK";
  }

  async del(key: string) {
    return this.values.delete(key) ? 1 : 0;
  }

  async ttl() {
    return -2;
  }

  async incr(key: string) {
    const next = Number(this.values.get(key) ?? 0) + 1;
    this.values.set(key, String(next));
    return next;
  }

  async expire() {
    return 1;
  }

  multi(): AuthRedisPipeline {
    const ops: Array<{ op: "get" | "del"; key: string }> = [];
    const store = this.values;
    const pipeline: AuthRedisPipeline = {
      get(key: string) {
        ops.push({ op: "get", key });
        return pipeline;
      },
      del(key: string) {
        ops.push({ op: "del", key });
        return pipeline;
      },
      // Snapshot the queued command results in one synchronous pass, so the whole
      // transaction commits without yielding to another in-flight consume.
      async exec() {
        return ops.map((entry): [Error | null, unknown] => {
          if (entry.op === "get") {
            return [null, store.get(entry.key) ?? null];
          }
          return [null, store.delete(entry.key) ? 1 : 0];
        });
      }
    };
    return pipeline;
  }
}

/** A redis fake WITHOUT `multi`, exercising the non-transactional fallback path. */
class NoMultiFakeRedis implements AuthRedis {
  readonly values = new Map<string, string>();

  async get(key: string) {
    return this.values.get(key) ?? null;
  }

  async set(key: string, value: string, mode: "EX") {
    expect(mode).toBe("EX");
    this.values.set(key, value);
    return "OK";
  }

  async del(key: string) {
    return this.values.delete(key) ? 1 : 0;
  }

  async ttl() {
    return -2;
  }

  async incr(key: string) {
    const next = Number(this.values.get(key) ?? 0) + 1;
    this.values.set(key, String(next));
    return next;
  }

  async expire() {
    return 1;
  }
}

describe("consumeWebAuthnFlow", () => {
  it("returns the stored flow on first consume and null on the second (single-use)", async () => {
    const redis = new AtomicFakeRedis();
    const flowId = await createWebAuthnFlow(redis, config, {
      challenge: "challenge-1",
      flowType: "authentication",
      accountId: "acct_1"
    });

    const first = await consumeWebAuthnFlow(redis, flowId);
    expect(first).toMatchObject({
      challenge: "challenge-1",
      flowType: "authentication",
      accountId: "acct_1",
      expectedOrigin: "https://kds.example.test",
      expectedRPID: "kds.example.test"
    });

    const second = await consumeWebAuthnFlow(redis, flowId);
    expect(second).toBeNull();
  });

  it("lets only one of two concurrent consumes win the same flow (GH #477 replay window closed)", async () => {
    const redis = new AtomicFakeRedis();
    const flowId = await createWebAuthnFlow(redis, config, {
      challenge: "challenge-1",
      flowType: "authentication",
      accountId: "acct_1"
    });

    // Fire both consumes "simultaneously" — with the old get-then-del they would
    // both read the challenge before either delete landed. With the atomic
    // transaction, exactly one observes it.
    const [a, b] = await Promise.all([
      consumeWebAuthnFlow(redis, flowId),
      consumeWebAuthnFlow(redis, flowId)
    ]);

    const winners = [a, b].filter((result) => result !== null);
    expect(winners).toHaveLength(1);
    expect(winners[0]).toMatchObject({ challenge: "challenge-1" });
    // The key must be gone afterwards.
    expect(redis.values.size).toBe(0);
  });

  it("returns null for an undefined flowId without touching redis", async () => {
    const redis = new AtomicFakeRedis();
    await expect(consumeWebAuthnFlow(redis, undefined)).resolves.toBeNull();
  });

  it("returns null when the stored payload fails to parse", async () => {
    const redis = new AtomicFakeRedis();
    redis.values.set("auth:webauthn:bad", "not-json{");
    await expect(consumeWebAuthnFlow(redis, "bad")).resolves.toBeNull();
    // Even a malformed entry is consumed (deleted) so it can't linger.
    expect(redis.values.has("auth:webauthn:bad")).toBe(false);
  });

  it("falls back to get/del and stays single-use when the client lacks MULTI", async () => {
    const redis = new NoMultiFakeRedis();
    const flowId = await createWebAuthnFlow(redis, config, {
      challenge: "challenge-1",
      flowType: "authentication",
      accountId: null
    });

    await expect(consumeWebAuthnFlow(redis, flowId)).resolves.toMatchObject({
      challenge: "challenge-1"
    });
    await expect(consumeWebAuthnFlow(redis, flowId)).resolves.toBeNull();
  });
});
