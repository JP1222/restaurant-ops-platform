import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  createChatModel,
  createVisionChatModel,
  providerSupportsVision,
} from "@/lib/ai/chat-provider";

const createDeepSeekMock = vi.fn();
const createGoogleMock = vi.fn();
const createOpenAIMock = vi.fn();
const createAnthropicMock = vi.fn();
const createOpenAICompatibleMock = vi.fn();
const resolveDeepSeekApiKeyMock = vi.fn();
const resolveVisionApiKeyMock = vi.fn();
const resolveOpenAiApiKeyMock = vi.fn();
const resolveAnthropicApiKeyMock = vi.fn();
const getSettingMock = vi.fn();

vi.mock("@ai-sdk/deepseek", () => ({
  createDeepSeek: (...args: unknown[]) => createDeepSeekMock(...args),
}));
vi.mock("@ai-sdk/google", () => ({
  createGoogleGenerativeAI: (...args: unknown[]) => createGoogleMock(...args),
}));
vi.mock("@ai-sdk/openai", () => ({
  createOpenAI: (...args: unknown[]) => createOpenAIMock(...args),
}));
vi.mock("@ai-sdk/anthropic", () => ({
  createAnthropic: (...args: unknown[]) => createAnthropicMock(...args),
}));
vi.mock("@ai-sdk/openai-compatible", () => ({
  createOpenAICompatible: (...args: unknown[]) => createOpenAICompatibleMock(...args),
}));
vi.mock("@/lib/ai/deepseek-provider", () => ({
  resolveDeepSeekApiKey: (...args: unknown[]) => resolveDeepSeekApiKeyMock(...args),
}));
vi.mock("@/lib/ai/vision-provider", () => ({
  resolveVisionApiKey: (...args: unknown[]) => resolveVisionApiKeyMock(...args),
}));
vi.mock("@/lib/ai/openai-provider", () => ({
  resolveOpenAiApiKey: (...args: unknown[]) => resolveOpenAiApiKeyMock(...args),
}));
vi.mock("@/lib/ai/anthropic-provider", () => ({
  resolveAnthropicApiKey: (...args: unknown[]) => resolveAnthropicApiKeyMock(...args),
}));
vi.mock("@/lib/settings", () => ({
  getSetting: (...args: unknown[]) => getSettingMock(...args),
}));

function settings(map: Record<string, unknown>) {
  getSettingMock.mockImplementation(async (key: string) => map[key]);
}

beforeEach(() => {
  vi.clearAllMocks();
  createDeepSeekMock.mockReturnValue({ chat: (id: string) => ({ kind: "deepseek-model", id }) });
  createGoogleMock.mockReturnValue((id: string) => ({ kind: "gemini-model", id }));
  createOpenAIMock.mockReturnValue((id: string) => ({ kind: "openai-model", id }));
  createAnthropicMock.mockReturnValue((id: string) => ({ kind: "anthropic-model", id }));
  createOpenAICompatibleMock.mockReturnValue((id: string) => ({ kind: "oai-compat-model", id }));
  resolveDeepSeekApiKeyMock.mockResolvedValue("dsk-key");
  resolveVisionApiKeyMock.mockResolvedValue("gem-key");
  resolveOpenAiApiKeyMock.mockResolvedValue("oai-key");
  resolveAnthropicApiKeyMock.mockResolvedValue("ant-key");
});

describe("createChatModel", () => {
  it("builds a DeepSeek model from ai.deepseek_api_key", async () => {
    settings({ "ai.chat_provider": "deepseek", "ai.model_id": "deepseek-v4-pro" });

    const out = await createChatModel();

    expect(resolveDeepSeekApiKeyMock).toHaveBeenCalledTimes(1);
    expect(createDeepSeekMock).toHaveBeenCalledWith({ apiKey: "dsk-key" });
    expect(out).toEqual({
      model: { kind: "deepseek-model", id: "deepseek-v4-pro" },
      provider: "deepseek",
      modelId: "deepseek-v4-pro",
    });
  });

  it("builds a Gemini model that REUSES the existing vision key (ai.vision_api_key)", async () => {
    settings({ "ai.chat_provider": "gemini", "ai.model_id": "gemini-2.5-flash" });

    const out = await createChatModel();

    expect(resolveVisionApiKeyMock).toHaveBeenCalledTimes(1);
    expect(resolveDeepSeekApiKeyMock).not.toHaveBeenCalled(); // no new key needed
    expect(createGoogleMock).toHaveBeenCalledWith({ apiKey: "gem-key" });
    expect(out).toEqual({
      model: { kind: "gemini-model", id: "gemini-2.5-flash" },
      provider: "gemini",
      modelId: "gemini-2.5-flash",
    });
  });

  it("builds a first-class OpenAI model from ai.openai_api_key", async () => {
    settings({ "ai.chat_provider": "openai", "ai.model_id": "gpt-4o" });

    const out = await createChatModel();

    expect(resolveOpenAiApiKeyMock).toHaveBeenCalledTimes(1);
    expect(createOpenAIMock).toHaveBeenCalledWith({ apiKey: "oai-key" });
    expect(out).toEqual({
      model: { kind: "openai-model", id: "gpt-4o" },
      provider: "openai",
      modelId: "gpt-4o",
    });
  });

  it("builds a first-class Anthropic model from ai.anthropic_api_key", async () => {
    settings({ "ai.chat_provider": "anthropic", "ai.model_id": "claude-sonnet-4-6" });

    const out = await createChatModel();

    expect(resolveAnthropicApiKeyMock).toHaveBeenCalledTimes(1);
    expect(createAnthropicMock).toHaveBeenCalledWith({ apiKey: "ant-key" });
    expect(out).toEqual({
      model: { kind: "anthropic-model", id: "claude-sonnet-4-6" },
      provider: "anthropic",
      modelId: "claude-sonnet-4-6",
    });
  });

  it("builds an OpenAI-compatible model from base URL + chat key", async () => {
    settings({
      "ai.chat_provider": "openai-compatible",
      "ai.model_id": "gpt-4o-mini",
      "ai.chat_base_url": "https://api.openai.com/v1",
      "ai.chat_api_key": "sk-test-key",
    });

    const out = await createChatModel();

    expect(createOpenAICompatibleMock).toHaveBeenCalledWith({
      name: "chat",
      baseURL: "https://api.openai.com/v1",
      apiKey: "sk-test-key",
    });
    expect(out).toEqual({
      model: { kind: "oai-compat-model", id: "gpt-4o-mini" },
      provider: "openai-compatible",
      modelId: "gpt-4o-mini",
    });
  });

  it("throws when the OpenAI-compatible base URL is unset", async () => {
    settings({
      "ai.chat_provider": "openai-compatible",
      "ai.model_id": "gpt-4o-mini",
      "ai.chat_base_url": "",
      "ai.chat_api_key": "sk-test-key",
    });

    await expect(createChatModel()).rejects.toThrow(/ai\.chat_base_url/);
    expect(createOpenAICompatibleMock).not.toHaveBeenCalled();
  });

  it("throws when the OpenAI-compatible key is unset", async () => {
    settings({
      "ai.chat_provider": "openai-compatible",
      "ai.model_id": "gpt-4o-mini",
      "ai.chat_base_url": "https://api.openai.com/v1",
      "ai.chat_api_key": "   ",
    });

    await expect(createChatModel()).rejects.toThrow(/ai\.chat_api_key/);
  });
});

describe("providerSupportsVision", () => {
  it("is true for the multimodal providers (gemini, openai, anthropic)", () => {
    expect(providerSupportsVision("gemini")).toBe(true);
    expect(providerSupportsVision("openai")).toBe(true);
    expect(providerSupportsVision("anthropic")).toBe(true);
    expect(providerSupportsVision("deepseek")).toBe(false);
    // openai-compatible is conservatively text-only (we can't probe the endpoint).
    expect(providerSupportsVision("openai-compatible")).toBe(false);
  });
});

describe("createVisionChatModel (vision fallback)", () => {
  it("builds a Gemini model from ai.vision_model_id, reusing the vision key", async () => {
    // Operator is still on DeepSeek, so ai.model_id holds a DeepSeek alias — the
    // fallback must read ai.vision_model_id (the Gemini id) instead.
    settings({ "ai.vision_model_id": "gemini-flash-latest", "ai.model_id": "deepseek-v4-pro" });

    const out = await createVisionChatModel();

    expect(resolveVisionApiKeyMock).toHaveBeenCalledTimes(1);
    expect(resolveDeepSeekApiKeyMock).not.toHaveBeenCalled();
    expect(createGoogleMock).toHaveBeenCalledWith({ apiKey: "gem-key" });
    expect(out).toEqual({
      model: { kind: "gemini-model", id: "gemini-flash-latest" },
      provider: "gemini",
      modelId: "gemini-flash-latest",
    });
  });
});
