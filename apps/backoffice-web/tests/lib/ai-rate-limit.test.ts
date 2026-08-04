import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const getSettingMock = vi.fn();

vi.mock("@/lib/settings", () => ({
  getSetting: (...args: unknown[]) => getSettingMock(...args),
}));

interface MultiHandle {
  incr: (key: string) => MultiHandle;
  expire: (key: string, seconds: number, mode: string) => MultiHandle;
  exec: () => Promise<Array<[Error | null, number | string]>>;
}

class FakeRedis {
  private counters = new Map<string, number>();
  private ttls = new Map<string, number>();

  multi(): MultiHandle {
    let pendingIncrKey: string | null = null;
    let pendingExpire: { key: string; ttl: number; nx: boolean } | null = null;

    const handle: MultiHandle = {
      incr: (key: string) => {
        pendingIncrKey = key;
        return handle;
      },
      expire: (key: string, seconds: number, mode: string) => {
        pendingExpire = { key, ttl: seconds, nx: mode === "NX" };
        return handle;
      },
      exec: async () => {
        const results: Array<[Error | null, number | string]> = [];
        if (pendingIncrKey) {
          const next = (this.counters.get(pendingIncrKey) ?? 0) + 1;
          this.counters.set(pendingIncrKey, next);
          results.push([null, next]);
        }
        if (pendingExpire) {
          const existing = this.ttls.get(pendingExpire.key);
          if (!pendingExpire.nx || existing === undefined) {
            this.ttls.set(pendingExpire.key, pendingExpire.ttl);
          }
          results.push([null, 1]);
        }
        return results;
      },
    };
    return handle;
  }

  async ttl(key: string): Promise<number> {
    return this.ttls.get(key) ?? -2;
  }

  reset(): void {
    this.counters.clear();
    this.ttls.clear();
  }
}

const fakeRedis = new FakeRedis();

vi.mock("ioredis", () => {
  // Constructor stub returning the singleton fake so each `new Redis(...)`
  // call yields the same instance the tests assert against.
  function Redis() {
    return fakeRedis;
  }
  return { Redis };
});

beforeEach(() => {
  fakeRedis.reset();
  vi.resetModules();
  delete (globalThis as { __ropBackofficeAuth?: unknown }).__ropBackofficeAuth;
  delete (globalThis as { __ropAiRateLimit?: unknown }).__ropAiRateLimit;
  getSettingMock.mockReset();
  // Distinct ceilings per scope so a test that rejects at one bound proves the
  // scope→setting mapping resolved the right key (not the other surface's).
  getSettingMock.mockImplementation(async (key: string) => {
    if (key === "ai.rate_limit_per_minute") return 60;
    if (key === "ai.scan_rate_limit_per_minute") return 30;
    throw new Error(`unexpected setting key: ${key}`);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("checkAiRateLimit", () => {
  test("allows the first 60 chat calls under default limit, sets TTL on first INCR", async () => {
    const { checkAiRateLimit } = await import("@/lib/ai/rate-limit");

    let lastRemaining = -1;
    for (let i = 0; i < 60; i += 1) {
      const result = await checkAiRateLimit("chat");
      expect(result.ok).toBe(true);
      lastRemaining = result.remaining;
    }
    expect(lastRemaining).toBe(0);
    expect(await fakeRedis.ttl("ai:ratelimit:chat")).toBe(60);
  });

  test("rejects the 61st chat call with retryAfterSeconds derived from TTL", async () => {
    const { checkAiRateLimit } = await import("@/lib/ai/rate-limit");

    for (let i = 0; i < 60; i += 1) {
      await checkAiRateLimit("chat");
    }
    const overage = await checkAiRateLimit("chat");
    expect(overage.ok).toBe(false);
    expect(overage.remaining).toBe(0);
    expect(overage.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    expect(overage.retryAfterSeconds).toBeLessThanOrEqual(60);
  });

  test("honors limitPerMin override (5)", async () => {
    const { checkAiRateLimit } = await import("@/lib/ai/rate-limit");

    for (let i = 0; i < 5; i += 1) {
      const r = await checkAiRateLimit("chat", 5);
      expect(r.ok).toBe(true);
    }
    const overage = await checkAiRateLimit("chat", 5);
    expect(overage.ok).toBe(false);
  });

  test("chat scope reads ai.rate_limit_per_minute via getSetting when limitPerMin not passed", async () => {
    getSettingMock.mockImplementation(async (key: string) => {
      if (key === "ai.rate_limit_per_minute") return 3;
      throw new Error(`unexpected setting key: ${key}`);
    });

    const { checkAiRateLimit } = await import("@/lib/ai/rate-limit");
    await checkAiRateLimit("chat");
    await checkAiRateLimit("chat");
    await checkAiRateLimit("chat");
    const overage = await checkAiRateLimit("chat");
    expect(overage.ok).toBe(false);
    expect(getSettingMock).toHaveBeenCalledWith("ai.rate_limit_per_minute");
  });

  test("scan scope uses its own counter + ai.scan_rate_limit_per_minute ceiling", async () => {
    const { checkAiRateLimit } = await import("@/lib/ai/rate-limit");

    // scan ceiling (30) is independent of the chat ceiling (60): the scan
    // bucket rejects at 31 even though chat could go to 60.
    for (let i = 0; i < 30; i += 1) {
      const r = await checkAiRateLimit("scan");
      expect(r.ok).toBe(true);
    }
    const overage = await checkAiRateLimit("scan");
    expect(overage.ok).toBe(false);
    expect(getSettingMock).toHaveBeenCalledWith("ai.scan_rate_limit_per_minute");
    expect(await fakeRedis.ttl("ai:ratelimit:scan")).toBe(60);
  });

  test("chat and scan buckets do not share a counter — a saturated chat bucket never 429s a scan", async () => {
    const { checkAiRateLimit } = await import("@/lib/ai/rate-limit");

    // Exhaust chat entirely (this was the bug: chat starving the cook's scan).
    for (let i = 0; i < 60; i += 1) {
      await checkAiRateLimit("chat");
    }
    expect((await checkAiRateLimit("chat")).ok).toBe(false);

    // The scan bucket is untouched, so a Floor scan still goes through.
    const scan = await checkAiRateLimit("scan");
    expect(scan.ok).toBe(true);
    expect(scan.remaining).toBe(29);
  });
});
