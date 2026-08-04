import { beforeEach, describe, expect, it, vi } from "vitest";

import { withTextFallback } from "@/lib/ai/text-fallback";

const resolveLanguageModelMock = vi.fn();
const getSettingMock = vi.fn();

vi.mock("@/lib/ai/chat-provider", () => ({
  resolveLanguageModel: (...args: unknown[]) => resolveLanguageModelMock(...args),
}));
vi.mock("@/lib/settings", () => ({
  getSetting: (...args: unknown[]) => getSettingMock(...args),
}));

beforeEach(() => {
  vi.clearAllMocks();
  // Sentinel keyed by model id so a test can assert WHICH model ran.
  resolveLanguageModelMock.mockImplementation(async (_provider: string, modelId: string) => `model:${modelId}`);
  getSettingMock.mockResolvedValue(""); // default: no fallback configured
});

const target = { provider: "deepseek" as const, modelId: "primary-id" };

describe("withTextFallback", () => {
  it("returns the primary result and never reads the fallback on success", async () => {
    const run = vi.fn(async (model: unknown) => ({ ok: model }));

    const out = await withTextFallback(target, run);

    expect(out).toEqual({ result: { ok: "model:primary-id" }, modelId: "primary-id", fallbackUsed: false });
    expect(run).toHaveBeenCalledTimes(1);
    // The fallback id is only consulted when the primary fails.
    expect(getSettingMock).not.toHaveBeenCalled();
  });

  it("retries once on the fallback model when the primary fails and a fallback is set", async () => {
    getSettingMock.mockResolvedValue("fallback-id");
    const run = vi.fn(async (model: unknown) => {
      if (model === "model:primary-id") throw new Error("overloaded");
      return { ok: model };
    });

    const out = await withTextFallback(target, run);

    expect(out).toEqual({ result: { ok: "model:fallback-id" }, modelId: "fallback-id", fallbackUsed: true });
    expect(run).toHaveBeenCalledTimes(2);
    // Fallback runs on the SAME provider, different model id.
    expect(resolveLanguageModelMock).toHaveBeenCalledWith("deepseek", "fallback-id");
  });

  it("rethrows the primary error when no fallback is configured", async () => {
    getSettingMock.mockResolvedValue("   "); // whitespace trims to empty
    const run = vi.fn(async () => {
      throw new Error("boom");
    });

    await expect(withTextFallback(target, run)).rejects.toThrow("boom");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("rethrows the primary error when the fallback id equals the primary id", async () => {
    getSettingMock.mockResolvedValue("primary-id");
    const run = vi.fn(async () => {
      throw new Error("boom");
    });

    await expect(withTextFallback(target, run)).rejects.toThrow("boom");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("propagates a fallback failure without a third attempt", async () => {
    getSettingMock.mockResolvedValue("fallback-id");
    const run = vi.fn(async () => {
      throw new Error("still failing");
    });

    await expect(withTextFallback(target, run)).rejects.toThrow("still failing");
    expect(run).toHaveBeenCalledTimes(2);
  });
});
