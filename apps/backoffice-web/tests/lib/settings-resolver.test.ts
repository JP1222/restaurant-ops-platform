import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { settingsRegistry, settingKeys } from "@rop/contracts";
import type { AppSettingRead } from "@rop/contracts";

const findAllSettingsMock = vi.fn();
const findSettingMock = vi.fn();

vi.mock("@/lib/settings/db", () => ({
  findAllSettings: (...args: unknown[]) => findAllSettingsMock(...args),
  findSetting: (...args: unknown[]) => findSettingMock(...args),
}));

const ORIGINAL_ENV = process.env;

function row(key: string, value: string) {
  return {
    merchantId: "default-merchant",
    key,
    value,
    category: "ai",
    version: 0,
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedBy: "acct-1",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
  };
}

function byKey(settings: AppSettingRead[], key: string): AppSettingRead {
  const found = settings.find((s) => s.key === key);
  if (!found) throw new Error(`missing key in resolved settings: ${key}`);
  return found;
}

beforeEach(() => {
  // Strip every setting env var so unrelated keys deterministically resolve to
  // "default"; each case opts back in to the single env var it exercises.
  const stripped = { ...ORIGINAL_ENV };
  for (const key of settingKeys) {
    const envVar = settingsRegistry[key].envVar;
    if (envVar) delete stripped[envVar];
  }
  process.env = stripped;

  findAllSettingsMock.mockReset();
  findSettingMock.mockReset();
  findAllSettingsMock.mockResolvedValue([]);
  findSettingMock.mockResolvedValue(null);

  vi.resetModules();
});

afterEach(() => {
  process.env = ORIGINAL_ENV;
  vi.restoreAllMocks();
});

describe("lib/settings resolver", () => {
  test("a valid DB row resolves with source 'db'", async () => {
    findAllSettingsMock.mockResolvedValue([row("ai.rate_limit_per_minute", JSON.stringify(25))]);
    const { listResolvedSettings } = await import("@/lib/settings");
    const resolved = byKey(await listResolvedSettings(), "ai.rate_limit_per_minute");
    expect(resolved.source).toBe("db");
    expect(resolved.value).toBe(25);
  });

  test("a malformed DB row falls through to the env value with source 'env'", async () => {
    process.env.AI_RATE_LIMIT_PER_MINUTE = "42";
    findAllSettingsMock.mockResolvedValue([row("ai.rate_limit_per_minute", "{not valid json")]);
    const { listResolvedSettings } = await import("@/lib/settings");
    const resolved = byKey(await listResolvedSettings(), "ai.rate_limit_per_minute");
    expect(resolved.source).toBe("env");
    expect(resolved.value).toBe(42);
  });

  test("absent DB row and unset env resolves to the registry default with source 'default'", async () => {
    findAllSettingsMock.mockResolvedValue([]);
    const { listResolvedSettings } = await import("@/lib/settings");
    const resolved = byKey(await listResolvedSettings(), "ai.rate_limit_per_minute");
    expect(resolved.source).toBe("default");
    expect(resolved.value).toBe(settingsRegistry["ai.rate_limit_per_minute"].defaultValue);
  });

  test("an env value that fails the key schema falls through to the default", async () => {
    process.env.AI_RATE_LIMIT_PER_MINUTE = "0";
    findAllSettingsMock.mockResolvedValue([]);
    const { listResolvedSettings } = await import("@/lib/settings");
    const resolved = byKey(await listResolvedSettings(), "ai.rate_limit_per_minute");
    expect(resolved.source).toBe("default");
    expect(resolved.value).toBe(settingsRegistry["ai.rate_limit_per_minute"].defaultValue);
  });

  test("getSetting returns the DB value when the row is valid", async () => {
    findSettingMock.mockResolvedValue(row("ai.model_id", JSON.stringify("deepseek-v4-flash")));
    const { getSetting } = await import("@/lib/settings");
    expect(await getSetting("ai.model_id")).toBe("deepseek-v4-flash");
  });

  test("getSetting falls back to the default when the DB row is malformed and env is unset", async () => {
    findSettingMock.mockResolvedValue(row("ai.model_id", "{bad"));
    const { getSetting } = await import("@/lib/settings");
    expect(await getSetting("ai.model_id")).toBe(settingsRegistry["ai.model_id"].defaultValue);
  });
});

describe("lib/settings TTL cache (issue #195)", () => {
  test("a cache hit serves the prior value without a second DB read", async () => {
    findSettingMock.mockResolvedValue(row("ai.kill_switch", JSON.stringify(true)));
    const { getSetting } = await import("@/lib/settings");

    expect(await getSetting("ai.kill_switch")).toBe(true);
    expect(await getSetting("ai.kill_switch")).toBe(true);
    expect(await getSetting("ai.kill_switch")).toBe(true);

    // Three reads, one DB round-trip — the rest are served from the Map.
    expect(findSettingMock).toHaveBeenCalledTimes(1);
  });

  test("invalidateSetting forces the next read back to the DB", async () => {
    findSettingMock.mockResolvedValue(row("ai.kill_switch", JSON.stringify(false)));
    const { getSetting, invalidateSetting } = await import("@/lib/settings");

    expect(await getSetting("ai.kill_switch")).toBe(false);
    expect(findSettingMock).toHaveBeenCalledTimes(1);

    // Operator flips the switch; the PUT route calls invalidateSetting.
    findSettingMock.mockResolvedValue(row("ai.kill_switch", JSON.stringify(true)));
    invalidateSetting("ai.kill_switch");

    expect(await getSetting("ai.kill_switch")).toBe(true);
    expect(findSettingMock).toHaveBeenCalledTimes(2);
  });

  test("the cache is per-key — one key's entry does not satisfy another", async () => {
    findSettingMock.mockImplementation(async (key: string) => {
      if (key === "ai.kill_switch") return row("ai.kill_switch", JSON.stringify(true));
      if (key === "ai.model_id") return row("ai.model_id", JSON.stringify("deepseek-v4-flash"));
      return null;
    });
    const { getSetting } = await import("@/lib/settings");

    expect(await getSetting("ai.kill_switch")).toBe(true);
    expect(await getSetting("ai.model_id")).toBe("deepseek-v4-flash");
    expect(findSettingMock).toHaveBeenCalledTimes(2);
  });

  test("the kill-switch read is well under 5ms p99 on a cache hit", async () => {
    findSettingMock.mockResolvedValue(row("ai.kill_switch", JSON.stringify(true)));
    const { getSetting } = await import("@/lib/settings");

    // Warm the cache, then measure steady-state hits.
    await getSetting("ai.kill_switch");

    const samples: number[] = [];
    for (let i = 0; i < 500; i += 1) {
      const start = performance.now();
      await getSetting("ai.kill_switch");
      samples.push(performance.now() - start);
    }
    samples.sort((a, b) => a - b);
    const p99 = samples[Math.floor(samples.length * 0.99)] ?? 0;

    // Only the one warm-up read touched the DB.
    expect(findSettingMock).toHaveBeenCalledTimes(1);
    expect(p99).toBeLessThan(5);
  });
});
