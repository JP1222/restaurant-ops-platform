import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const ORIGINAL_ENV = process.env;

const sessionMock = vi.fn();
const streamTextMock = vi.fn();
const createChatModelMock = vi.fn();
const getSettingMock = vi.fn();
const createConversationMock = vi.fn();
const appendMessageMock = vi.fn();
const touchConversationMock = vi.fn();
const checkRateLimitMock = vi.fn();
const logChatEventMock = vi.fn();

vi.mock("@/lib/ai/session", () => ({
  getAiSessionUser: (...args: unknown[]) => sessionMock(...args),
}));

vi.mock("@/lib/ai/chat-provider", () => ({
  createChatModel: (...args: unknown[]) => createChatModelMock(...args),
  // The guards suite only exercises text turns, so the fallback is never taken — but
  // the route imports these, so the mock must export them.
  createVisionChatModel: vi.fn(),
  providerSupportsVision: (provider: string) => provider === "gemini",
}));

vi.mock("@/lib/settings", () => ({
  getSetting: (...args: unknown[]) => getSettingMock(...args),
}));

vi.mock("@/lib/ai/db", () => ({
  createConversation: (...args: unknown[]) => createConversationMock(...args),
  appendMessage: (...args: unknown[]) => appendMessageMock(...args),
  touchConversation: (...args: unknown[]) => touchConversationMock(...args),
}));

vi.mock("@/lib/ai/rate-limit", () => ({
  checkAiRateLimit: (...args: unknown[]) => checkRateLimitMock(...args),
}));

vi.mock("@/lib/ai/log", () => ({
  logChatEvent: (...args: unknown[]) => logChatEventMock(...args),
  logErrorEvent: () => {},
  errorMessage: (cause: unknown, fallback: string) =>
    cause instanceof Error ? cause.message : fallback,
}));

vi.mock("@/lib/ai/usage", () => ({ recordAiUsage: vi.fn() }));

vi.mock("ai", async () => {
  const actual = await vi.importActual<typeof import("ai")>("ai");
  return {
    ...actual,
    streamText: (...args: unknown[]) => streamTextMock(...args),
  };
});

function makeResult(text: string) {
  let onFinish:
    | ((event: {
        text: string;
        toolCalls: unknown[];
        toolResults: unknown[];
        totalUsage: { inputTokens?: number; outputTokens?: number };
        finishReason?: string;
      }) => Promise<void> | void)
    | undefined;
  return {
    capture: (cb: typeof onFinish) => {
      onFinish = cb;
    },
    triggerFinish: async () => {
      if (onFinish) {
        await onFinish({
          text,
          toolCalls: [],
          toolResults: [],
          totalUsage: { inputTokens: 5, outputTokens: 9 },
          finishReason: "stop",
        });
      }
    },
    toUIMessageStreamResponse: (init?: ResponseInit) =>
      new Response("data: chunk\n\n", {
        ...init,
        headers: {
          ...(init?.headers as Record<string, string> | undefined),
          "Content-Type": "text/event-stream",
        },
      }),
  };
}

function settingDefault(key: string): unknown {
  switch (key) {
    case "ai.kill_switch":
      return false;
    case "ai.chat_provider":
      return "deepseek";
    case "ai.model_id":
      return "deepseek-v4-pro";
    case "ai.thinking_mode":
      return false;
    case "ai.max_output_tokens":
      return 4000;
    default:
      return undefined;
  }
}

beforeEach(() => {
  process.env = {
    ...ORIGINAL_ENV,
    BACKOFFICE_SESSION_COOKIE_NAME: "rop_backoffice_session",
    ANALYTICS_ADMIN_TOKEN: "test-analytics-token",
    INTERNAL_ANALYTICS_API_URL: "http://analytics.test",
    DEEPSEEK_API_KEY: "sk-test-deepseek",
  };
  sessionMock.mockReset();
  streamTextMock.mockReset();
  createChatModelMock.mockReset();
  getSettingMock.mockReset();
  createConversationMock.mockReset();
  appendMessageMock.mockReset();
  touchConversationMock.mockReset();
  checkRateLimitMock.mockReset();
  logChatEventMock.mockReset();

  sessionMock.mockResolvedValue({ id: "user-1", username: "op", displayName: "Op" });
  getSettingMock.mockImplementation(async (key: string) => settingDefault(key));
  createChatModelMock.mockResolvedValue({
    model: { provider: "deepseek", id: "deepseek-v4-pro" },
    provider: "deepseek",
    modelId: "deepseek-v4-pro",
  });
  createConversationMock.mockResolvedValue({ id: "conv-1" });
  appendMessageMock.mockResolvedValue({ id: "msg-x" });
  touchConversationMock.mockResolvedValue({ id: "conv-1" });
  checkRateLimitMock.mockResolvedValue({ ok: true, remaining: 42 });

  vi.resetModules();
});

afterEach(() => {
  process.env = ORIGINAL_ENV;
  vi.restoreAllMocks();
});

async function callChat(body: unknown) {
  const { POST } = await import("@/app/api/ai/chat/route");
  const { NextRequest } = await import("next/server");
  const request = new NextRequest("http://localhost:3001/api/ai/chat", {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
  return POST(request);
}

describe("POST /api/ai/chat — guards", () => {
  test("returns 503 ai_disabled when ai.kill_switch setting is true; skips auth + stream", async () => {
    getSettingMock.mockImplementation(async (key: string) =>
      key === "ai.kill_switch" ? true : settingDefault(key),
    );

    const response = await callChat({ messages: [{ role: "user", parts: [{ type: "text", text: "hi" }] }] });

    expect(response.status).toBe(503);
    const payload = (await response.json()) as { error: string };
    expect(payload.error).toBe("ai_disabled");
    expect(sessionMock).not.toHaveBeenCalled();
    expect(checkRateLimitMock).not.toHaveBeenCalled();
    expect(streamTextMock).not.toHaveBeenCalled();
  });

  test("returns 429 rate_limited with Retry-After header when rate-limit denies the request", async () => {
    checkRateLimitMock.mockResolvedValueOnce({
      ok: false,
      remaining: 0,
      retryAfterSeconds: 17,
    });

    const response = await callChat({ messages: [{ role: "user", parts: [{ type: "text", text: "hi" }] }] });

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("17");
    const payload = (await response.json()) as { error: string; retry_after_seconds: number };
    expect(payload.error).toBe("rate_limited");
    expect(payload.retry_after_seconds).toBe(17);
    expect(streamTextMock).not.toHaveBeenCalled();
  });

  test("rate-limit check runs AFTER auth (no leaking limit to anonymous callers)", async () => {
    sessionMock.mockResolvedValueOnce(null);

    const response = await callChat({ messages: [{ role: "user", parts: [{ type: "text", text: "hi" }] }] });

    expect(response.status).toBe(401);
    expect(checkRateLimitMock).not.toHaveBeenCalled();
  });

  test("on success, logChatEvent fires inside onFinish with usage + latency + model", async () => {
    const result = makeResult("ok");
    streamTextMock.mockImplementation((opts: { onFinish?: unknown }) => {
      result.capture(opts.onFinish as never);
      return result;
    });

    const response = await callChat({ messages: [{ role: "user", parts: [{ type: "text", text: "hi" }] }] });
    expect(response.status).toBe(200);
    await result.triggerFinish();

    expect(logChatEventMock).toHaveBeenCalledTimes(1);
    const event = logChatEventMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(event.conversationId).toBe("conv-1");
    expect(event.turn).toBe("assistant");
    expect(event.modelId).toBe("deepseek-v4-pro");
    expect(event.inputTokens).toBe(5);
    expect(event.outputTokens).toBe(9);
    expect(event.toolCallCount).toBe(0);
    expect(event.finishReason).toBe("stop");
    expect(event.userId).toBe("user-1");
    expect(typeof event.latencyMs).toBe("number");
  });
});
