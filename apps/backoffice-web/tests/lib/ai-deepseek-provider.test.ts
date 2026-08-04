import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const getSettingMock = vi.fn();
const createDeepSeekMock = vi.fn();

vi.mock("@/lib/settings", () => ({
  getSetting: (...args: unknown[]) => getSettingMock(...args),
}));

vi.mock("@ai-sdk/deepseek", () => ({
  createDeepSeek: (...args: unknown[]) => createDeepSeekMock(...args),
}));

const ORIGINAL_ENV = process.env;

async function loadProvider() {
  vi.resetModules();
  return import("@/lib/ai/deepseek-provider");
}

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  delete process.env.DEEPSEEK_API_KEY;
  getSettingMock.mockReset();
  createDeepSeekMock.mockReset();
  createDeepSeekMock.mockImplementation((opts: { apiKey: string }) => ({
    chat: () => ({ provider: "deepseek", apiKey: opts.apiKey }),
  }));
});

afterEach(() => {
  process.env = ORIGINAL_ENV;
});

describe("resolveDeepSeekApiKey", () => {
  test("returns the AppSetting value when the row is populated", async () => {
    getSettingMock.mockResolvedValueOnce("sk-from-app-setting");
    const { resolveDeepSeekApiKey } = await loadProvider();
    expect(await resolveDeepSeekApiKey()).toBe("sk-from-app-setting");
    expect(getSettingMock).toHaveBeenCalledWith("ai.deepseek_api_key");
  });

  test("falls back to DEEPSEEK_API_KEY env when AppSetting is empty", async () => {
    getSettingMock.mockResolvedValueOnce("");
    process.env.DEEPSEEK_API_KEY = "sk-from-env";
    const { resolveDeepSeekApiKey } = await loadProvider();
    expect(await resolveDeepSeekApiKey()).toBe("sk-from-env");
  });

  test("throws MissingDeepSeekKeyError when both AppSetting and env are empty", async () => {
    getSettingMock.mockResolvedValue("");
    const { resolveDeepSeekApiKey, MissingDeepSeekKeyError } = await loadProvider();
    await expect(resolveDeepSeekApiKey()).rejects.toBeInstanceOf(MissingDeepSeekKeyError);
    await expect(resolveDeepSeekApiKey()).rejects.toThrow(
      "DeepSeek API key not configured — set in /settings/ai or via DEEPSEEK_API_KEY env (deprecated)",
    );
  });

  test("whitespace-only AppSetting and env both count as empty", async () => {
    getSettingMock.mockResolvedValueOnce("   ");
    process.env.DEEPSEEK_API_KEY = "\t\n";
    const { resolveDeepSeekApiKey, MissingDeepSeekKeyError } = await loadProvider();
    await expect(resolveDeepSeekApiKey()).rejects.toBeInstanceOf(MissingDeepSeekKeyError);
  });
});

describe("cache TTL + invalidation", () => {
  test("second call within 60s reuses the cached value (one AppSetting read)", async () => {
    getSettingMock.mockResolvedValue("sk-cached");
    const { resolveDeepSeekApiKey } = await loadProvider();

    expect(await resolveDeepSeekApiKey()).toBe("sk-cached");
    expect(await resolveDeepSeekApiKey()).toBe("sk-cached");

    expect(getSettingMock).toHaveBeenCalledTimes(1);
  });

  test("invalidateApiKeyCache forces the next call to re-read AppSetting", async () => {
    getSettingMock
      .mockResolvedValueOnce("sk-first")
      .mockResolvedValueOnce("sk-rotated");
    const { resolveDeepSeekApiKey, invalidateApiKeyCache } = await loadProvider();

    expect(await resolveDeepSeekApiKey()).toBe("sk-first");
    invalidateApiKeyCache();
    expect(await resolveDeepSeekApiKey()).toBe("sk-rotated");

    expect(getSettingMock).toHaveBeenCalledTimes(2);
  });

  test("cache entry expires after CACHE_TTL_MS and re-reads", async () => {
    vi.useFakeTimers();
    try {
      getSettingMock
        .mockResolvedValueOnce("sk-pre-ttl")
        .mockResolvedValueOnce("sk-post-ttl");
      const { resolveDeepSeekApiKey } = await loadProvider();

      expect(await resolveDeepSeekApiKey()).toBe("sk-pre-ttl");
      vi.advanceTimersByTime(60_001);
      expect(await resolveDeepSeekApiKey()).toBe("sk-post-ttl");

      expect(getSettingMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("createProvider", () => {
  test("threads the resolved key into createDeepSeek", async () => {
    getSettingMock.mockResolvedValueOnce("sk-resolved");
    const { createProvider } = await loadProvider();
    await createProvider();
    expect(createDeepSeekMock).toHaveBeenCalledWith({ apiKey: "sk-resolved" });
  });

  test("propagates MissingDeepSeekKeyError when nothing is configured", async () => {
    getSettingMock.mockResolvedValueOnce("");
    const { createProvider, MissingDeepSeekKeyError } = await loadProvider();
    await expect(createProvider()).rejects.toBeInstanceOf(MissingDeepSeekKeyError);
    expect(createDeepSeekMock).not.toHaveBeenCalled();
  });
});
