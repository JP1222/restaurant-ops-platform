import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const ORIGINAL_ENV = process.env;

const sessionMock = vi.fn();
const streamTextMock = vi.fn();
const createChatModelMock = vi.fn();
const createVisionChatModelMock = vi.fn();
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
  createVisionChatModel: (...args: unknown[]) => createVisionChatModelMock(...args),
  // Pure capability map, mirrored from the real module: only Gemini reads images.
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

function makeResult(text: string, options?: { toolCalls?: unknown[]; toolResults?: unknown[] }) {
  let onFinish: ((event: {
    text: string;
    toolCalls: unknown[];
    toolResults: unknown[];
    totalUsage: { inputTokens?: number; outputTokens?: number };
  }) => Promise<void> | void) | undefined;
  return {
    capture: (cb: typeof onFinish) => {
      onFinish = cb;
    },
    triggerFinish: async () => {
      if (onFinish) {
        await onFinish({
          text,
          toolCalls: options?.toolCalls ?? [],
          toolResults: options?.toolResults ?? [],
          totalUsage: { inputTokens: 12, outputTokens: 34 },
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
    case "ai.rate_limit_per_minute":
      return 10;
    case "ai.vision_fallback_enabled":
      return true;
    case "ai.web_search_enabled":
      return false;
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
  createVisionChatModelMock.mockReset();
  getSettingMock.mockReset();
  createConversationMock.mockReset();
  appendMessageMock.mockReset();
  touchConversationMock.mockReset();
  checkRateLimitMock.mockReset();
  logChatEventMock.mockReset();

  checkRateLimitMock.mockResolvedValue({ ok: true, remaining: 60 });
  getSettingMock.mockImplementation(async (key: string) => settingDefault(key));
  createChatModelMock.mockResolvedValue({
    model: { provider: "deepseek", id: "deepseek-v4-pro" },
    provider: "deepseek",
    modelId: "deepseek-v4-pro",
  });
  createVisionChatModelMock.mockResolvedValue({
    model: { provider: "gemini", id: "gemini-flash-latest" },
    provider: "gemini",
    modelId: "gemini-flash-latest",
  });
  createConversationMock.mockResolvedValue({ id: "conv-1" });
  appendMessageMock.mockResolvedValue({ id: "msg-x" });
  touchConversationMock.mockResolvedValue({ id: "conv-1" });

  vi.resetModules();
});

afterEach(() => {
  process.env = ORIGINAL_ENV;
  vi.restoreAllMocks();
});

async function callChat(body: unknown, headers: Record<string, string> = {}) {
  const { POST } = await import("@/app/api/ai/chat/route");
  const { NextRequest } = await import("next/server");
  const request = new NextRequest("http://localhost:3001/api/ai/chat", {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
  });
  return POST(request);
}

describe("POST /api/ai/chat", () => {
  test("returns 401 when no session", async () => {
    sessionMock.mockResolvedValueOnce(null);

    const response = await callChat({
      messages: [{ role: "user", parts: [{ type: "text", text: "hi" }] }],
    });

    expect(response.status).toBe(401);
    const payload = (await response.json()) as { error: string };
    expect(payload.error).toBe("unauthorized");
    expect(streamTextMock).not.toHaveBeenCalled();
  });

  test("streams response, sets X-Conversation-Id header, returns text/event-stream", async () => {
    sessionMock.mockResolvedValue({ id: "user-1", username: "op", displayName: "Op" });
    const result = makeResult("hello world");
    streamTextMock.mockImplementation((opts: { onFinish?: unknown }) => {
      result.capture(opts.onFinish as never);
      return result;
    });

    const response = await callChat({
      messages: [{ role: "user", parts: [{ type: "text", text: "hi" }] }],
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("X-Conversation-Id")).toBe("conv-1");
    expect(response.headers.get("Content-Type")).toBe("text/event-stream");
    expect(streamTextMock).toHaveBeenCalledTimes(1);
    const [args] = streamTextMock.mock.calls[0] as [{ model: unknown }];
    expect(args.model).toMatchObject({ provider: "deepseek", id: "deepseek-v4-pro" });
    expect(createChatModelMock).toHaveBeenCalledTimes(1);
  });

  test("converts real useChat UIMessage parts into ModelMessage content for streamText", async () => {
    // Regression: the browser's useChat posts UIMessages (`parts`), but streamText
    // needs ModelMessages (`content`). Before convertToModelMessages was wired in,
    // every real client request was rejected and no turn ever completed.
    sessionMock.mockResolvedValue({ id: "user-ui", username: "op", displayName: "Op" });
    const uiResult = makeResult("ok");
    streamTextMock.mockImplementation((opts: { onFinish?: unknown }) => {
      uiResult.capture(opts.onFinish as never);
      return uiResult;
    });

    const response = await callChat({
      messages: [{ role: "user", parts: [{ type: "text", text: "what is low?" }] }],
    });

    expect(response.status).toBe(200);
    const [args] = streamTextMock.mock.calls[0] as [
      { messages: Array<{ role: string; content?: unknown; parts?: unknown }> },
    ];
    const first = args.messages[0];
    expect(first?.role).toBe("user");
    expect(first).toHaveProperty("content");
    expect(first).not.toHaveProperty("parts");
  });

  test("passes the resolved ai.rate_limit_per_minute setting to checkAiRateLimit", async () => {
    sessionMock.mockResolvedValue({ id: "user-1", username: "op", displayName: "Op" });
    getSettingMock.mockImplementation(async (key: string) =>
      key === "ai.rate_limit_per_minute" ? 7 : settingDefault(key),
    );
    const result = makeResult("ok");
    streamTextMock.mockImplementation((opts: { onFinish?: unknown }) => {
      result.capture(opts.onFinish as never);
      return result;
    });

    await callChat({ messages: [{ role: "user", parts: [{ type: "text", text: "hi" }] }] });

    expect(checkRateLimitMock).toHaveBeenCalledWith("chat", 7);
  });

  test("mutating the ai.rate_limit_per_minute setting changes the ceiling on the next request", async () => {
    sessionMock.mockResolvedValue({ id: "user-1", username: "op", displayName: "Op" });
    const result = makeResult("ok");
    streamTextMock.mockImplementation((opts: { onFinish?: unknown }) => {
      result.capture(opts.onFinish as never);
      return result;
    });

    getSettingMock.mockImplementation(async (key: string) =>
      key === "ai.rate_limit_per_minute" ? 5 : settingDefault(key),
    );
    await callChat({ messages: [{ role: "user", parts: [{ type: "text", text: "first" }] }] });
    expect(checkRateLimitMock).toHaveBeenLastCalledWith("chat", 5);

    getSettingMock.mockImplementation(async (key: string) =>
      key === "ai.rate_limit_per_minute" ? 25 : settingDefault(key),
    );
    await callChat({ messages: [{ role: "user", parts: [{ type: "text", text: "second" }] }] });
    expect(checkRateLimitMock).toHaveBeenLastCalledWith("chat", 25);
  });

  test("passes thinking mode providerOptions when ai.thinking_mode is true", async () => {
    sessionMock.mockResolvedValue({ id: "user-1", username: "op", displayName: "Op" });
    getSettingMock.mockImplementation(async (key: string) =>
      key === "ai.thinking_mode" ? true : settingDefault(key),
    );
    const result = makeResult("with reasoning");
    streamTextMock.mockImplementation((opts: { onFinish?: unknown }) => {
      result.capture(opts.onFinish as never);
      return result;
    });

    await callChat({ messages: [{ role: "user", parts: [{ type: "text", text: "think hard" }] }] });

    const [args] = streamTextMock.mock.calls[0] as [
      { providerOptions?: { deepseek?: { thinking?: { type?: string } } } },
    ];
    expect(args.providerOptions?.deepseek?.thinking?.type).toBe("enabled");
  });

  test("omits DeepSeek thinking providerOptions for a non-deepseek provider even when thinking_mode is true", async () => {
    sessionMock.mockResolvedValue({ id: "user-1", username: "op", displayName: "Op" });
    // Gemini is the active chat provider this turn; thinking mode is a DeepSeek-only
    // option, so the route must NOT send providerOptions.deepseek even with it on.
    createChatModelMock.mockResolvedValueOnce({
      model: { provider: "gemini", id: "gemini-2.5-flash" },
      provider: "gemini",
      modelId: "gemini-2.5-flash",
    });
    getSettingMock.mockImplementation(async (key: string) =>
      key === "ai.thinking_mode" ? true : settingDefault(key),
    );
    const result = makeResult("no thinking for gemini");
    streamTextMock.mockImplementation((opts: { onFinish?: unknown }) => {
      result.capture(opts.onFinish as never);
      return result;
    });

    await callChat({ messages: [{ role: "user", parts: [{ type: "text", text: "see this" }] }] });

    const [args] = streamTextMock.mock.calls[0] as [{ providerOptions?: unknown }];
    expect(args.providerOptions).toBeUndefined();
  });

  test("omits providerOptions when thinking_mode is false", async () => {
    sessionMock.mockResolvedValue({ id: "user-1", username: "op", displayName: "Op" });
    const result = makeResult("plain");
    streamTextMock.mockImplementation((opts: { onFinish?: unknown }) => {
      result.capture(opts.onFinish as never);
      return result;
    });

    await callChat({ messages: [{ role: "user", parts: [{ type: "text", text: "plain" }] }] });

    const [args] = streamTextMock.mock.calls[0] as [{ providerOptions?: unknown }];
    expect(args.providerOptions).toBeUndefined();
  });

  test("propagates tool-call objects in streamText config (tools wired in)", async () => {
    sessionMock.mockResolvedValue({ id: "user-1", username: "op", displayName: "Op" });
    const result = makeResult("answer with tool", { toolCalls: [{ toolName: "get_today_overview" }] });
    streamTextMock.mockImplementation((opts: { onFinish?: unknown }) => {
      result.capture(opts.onFinish as never);
      return result;
    });

    const response = await callChat({
      messages: [{ role: "user", parts: [{ type: "text", text: "how are we doing today" }] }],
    });

    expect(response.status).toBe(200);
    const [args] = streamTextMock.mock.calls[0] as [{ tools?: Record<string, unknown> }];
    expect(args.tools).toBeDefined();
    expect(args.tools).toHaveProperty("get_today_overview");
    expect(args.tools).toHaveProperty("run_sql_query");
  });

  test("web search OFF (default): the streamText tool set OMITS web_search", async () => {
    sessionMock.mockResolvedValue({ id: "user-ws-off", username: "op", displayName: "Op" });
    const result = makeResult("ok");
    streamTextMock.mockImplementation((opts: { onFinish?: unknown }) => {
      result.capture(opts.onFinish as never);
      return result;
    });

    await callChat({ messages: [{ role: "user", parts: [{ type: "text", text: "any news?" }] }] });

    const [args] = streamTextMock.mock.calls[0] as [{ tools?: Record<string, unknown> }];
    expect(args.tools).toBeDefined();
    expect(args.tools).not.toHaveProperty("web_search");
    // The other tools are still present — only web_search is gated off.
    expect(args.tools).toHaveProperty("get_today_overview");
  });

  test("web search ON: the streamText tool set INCLUDES web_search", async () => {
    sessionMock.mockResolvedValue({ id: "user-ws-on", username: "op", displayName: "Op" });
    getSettingMock.mockImplementation(async (key: string) =>
      key === "ai.web_search_enabled" ? true : settingDefault(key),
    );
    const result = makeResult("ok");
    streamTextMock.mockImplementation((opts: { onFinish?: unknown }) => {
      result.capture(opts.onFinish as never);
      return result;
    });

    await callChat({ messages: [{ role: "user", parts: [{ type: "text", text: "any news?" }] }] });

    const [args] = streamTextMock.mock.calls[0] as [{ tools?: Record<string, unknown> }];
    expect(args.tools).toHaveProperty("web_search");
  });

  test("onFinish drops web_search results from the figures fed to the numeric guardrail", async () => {
    // Governance: a web-sourced number must NOT verify a matching answer figure.
    // The route filters web_search out of event.toolResults before the guardrail,
    // so the figure persists as unverified on the assistant message.
    sessionMock.mockResolvedValue({ id: "user-ws-gov", username: "op", displayName: "Op" });
    const result = makeResult("Wholesale tapioca is about $30.00 per case.", {
      toolCalls: [{ toolName: "web_search" }],
      toolResults: [
        {
          toolName: "web_search",
          output: {
            query: "boba price",
            answer: "A case is about $30.00.",
            sources: [{ title: "Supplier", url: "https://example.com/boba" }],
            available: true,
          },
        },
      ],
    });
    streamTextMock.mockImplementation((opts: { onFinish?: unknown }) => {
      result.capture(opts.onFinish as never);
      return result;
    });

    await callChat({
      messages: [{ role: "user", parts: [{ type: "text", text: "what's wholesale boba cost?" }] }],
    });
    await result.triggerFinish();

    const assistantCall = appendMessageMock.mock.calls.find((call) => call[1] === "assistant");
    const payload = assistantCall?.[2] as { unverifiedFigures: Array<{ text: string }> };
    expect(payload.unverifiedFigures.map((figure) => figure.text)).toContain("$30.00");
  });

  test("a DB tool result still verifies a matching figure (exclusion is web-only)", async () => {
    // Sanity: the exclusion is scoped to web tools — a real tool number still grounds
    // a figure, so this answer is NOT flagged.
    sessionMock.mockResolvedValue({ id: "user-ws-db", username: "op", displayName: "Op" });
    const result = makeResult("That came to $30.00.", {
      toolCalls: [{ toolName: "get_metric" }],
      toolResults: [{ toolName: "get_metric", output: { rows: [{ value: 3000 }], unit: "cents" } }],
    });
    streamTextMock.mockImplementation((opts: { onFinish?: unknown }) => {
      result.capture(opts.onFinish as never);
      return result;
    });

    await callChat({
      messages: [{ role: "user", parts: [{ type: "text", text: "net sales?" }] }],
    });
    await result.triggerFinish();

    const assistantCall = appendMessageMock.mock.calls.find((call) => call[1] === "assistant");
    const payload = assistantCall?.[2] as { unverifiedFigures: Array<{ text: string }> };
    expect(payload.unverifiedFigures).toHaveLength(0);
  });

  test("write-gate invariant: the 3 inventory write tools keep needsApproval; web_search has none", async () => {
    // Guards the security invariant from the chat surface: web_search is read-only,
    // and adding it never weakens the inventory write-approval gate.
    const { aiTools } = await import("@/lib/ai/tools");
    expect(aiTools.record_receiving.needsApproval).toBe(true);
    expect(aiTools.record_waste.needsApproval).toBe(true);
    expect(aiTools.set_inventory_count.needsApproval).toBe(true);
    expect(aiTools.web_search.needsApproval).toBeUndefined();
  });

  test("enables multi-step so the model answers AFTER a tool runs (stopWhen wired)", async () => {
    // Regression: streamText defaults to stepCountIs(1) — the model emits a tool
    // call, the tool executes ("Completed"), and the stream STOPS with no reply.
    // The route must pass a stopWhen that allows further steps so the agent reads
    // the tool result and answers. Without this every tool-using turn hangs after
    // the tool card, and the write-approval resume can't confirm its result.
    sessionMock.mockResolvedValue({ id: "user-step", username: "op", displayName: "Op" });
    const result = makeResult("answer after tool", {
      toolCalls: [{ toolName: "get_inventory_status" }],
    });
    streamTextMock.mockImplementation((opts: { onFinish?: unknown }) => {
      result.capture(opts.onFinish as never);
      return result;
    });

    await callChat({
      messages: [{ role: "user", parts: [{ type: "text", text: "is my inventory healthy" }] }],
    });

    const [args] = streamTextMock.mock.calls[0] as [{ stopWhen?: unknown }];
    expect(args.stopWhen).toBeDefined();
    expect(typeof args.stopWhen).toBe("function");
  });

  test("persists user message + assistant message after onFinish (DB writes)", async () => {
    sessionMock.mockResolvedValue({ id: "user-2", username: "op", displayName: "Op" });
    const result = makeResult("final assistant text", {
      toolCalls: [{ toolName: "get_today_overview", input: {} }],
    });
    streamTextMock.mockImplementation((opts: { onFinish?: unknown }) => {
      result.capture(opts.onFinish as never);
      return result;
    });

    await callChat({
      messages: [{ role: "user", parts: [{ type: "text", text: "hi there" }] }],
    });
    await result.triggerFinish();

    expect(appendMessageMock).toHaveBeenCalledTimes(2);
    const userCall = appendMessageMock.mock.calls[0];
    expect(userCall?.[1]).toBe("user");
    const assistantCall = appendMessageMock.mock.calls[1];
    expect(assistantCall?.[1]).toBe("assistant");
    const assistantStats = assistantCall?.[3] as { toolCallCount: number; inputTokens: number };
    expect(assistantStats.toolCallCount).toBe(1);
    expect(assistantStats.inputTokens).toBe(12);
    expect(touchConversationMock).toHaveBeenCalledWith("conv-1");
  });

  test("returns 500 when streamText throws synchronously (provider config error)", async () => {
    sessionMock.mockResolvedValue({ id: "user-3", username: "op", displayName: "Op" });
    streamTextMock.mockImplementationOnce(() => {
      throw new Error("invalid model literal");
    });

    const response = await callChat({
      messages: [{ role: "user", parts: [{ type: "text", text: "blow up" }] }],
    });

    expect(response.status).toBe(500);
    const payload = (await response.json()) as { error: string };
    expect(payload.error).toBe("internal_error");
  });

  test("registers an onError handler on streamText for in-stream errors", async () => {
    // streamText fires upstream HTTP lazily inside the response ReadableStream;
    // a DeepSeek 401/5xx arrives AFTER our 200/SSE headers are flushed, so we
    // cannot synchronously catch + retry. The contract is: register an
    // onError observer so Loki sees stream failures.
    sessionMock.mockResolvedValue({ id: "user-onerror", username: "op", displayName: "Op" });

    await callChat({
      messages: [{ role: "user", parts: [{ type: "text", text: "hello" }] }],
    });

    expect(streamTextMock).toHaveBeenCalledTimes(1);
    const opts = streamTextMock.mock.calls[0]?.[0] as { onError?: unknown };
    expect(typeof opts.onError).toBe("function");
  });

  test("returns 503 when the chat provider key is missing (createChatModel throws)", async () => {
    sessionMock.mockResolvedValue({ id: "user-4", username: "op", displayName: "Op" });
    createChatModelMock.mockImplementationOnce(() => {
      throw new Error("DEEPSEEK_API_KEY missing");
    });

    const response = await callChat({
      messages: [{ role: "user", parts: [{ type: "text", text: "hi" }] }],
    });

    expect(response.status).toBe(503);
    const payload = (await response.json()) as { error: string };
    expect(payload.error).toBe("auth_not_configured");
    expect(streamTextMock).not.toHaveBeenCalled();
  });

  // ── Phase 2: vision fallback ────────────────────────────────────────────────
  // A 1×1 PNG as a data URL — enough for the real convertToModelMessages to emit a
  // `file` content part on the user model message.
  const PNG_DATA_URL =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

  function imageTurn(text = "what does this invoice say?") {
    return {
      messages: [
        {
          role: "user",
          parts: [
            { type: "text", text },
            { type: "file", url: PNG_DATA_URL, mediaType: "image/png", filename: "invoice.png" },
          ],
        },
      ],
    };
  }

  function streamedMessages(): Array<{ role: string; content?: unknown }> {
    const [args] = streamTextMock.mock.calls[0] as [
      { messages: Array<{ role: string; content?: unknown }> },
    ];
    return args.messages;
  }

  function lastUserHasFilePart(): boolean {
    const users = streamedMessages().filter((m) => m.role === "user");
    const content = users[users.length - 1]?.content;
    if (!Array.isArray(content)) return false;
    return content.some((part) => {
      const type = (part as { type?: unknown }).type;
      return type === "file" || type === "image";
    });
  }

  test("vision fallback ON: an image turn on a text provider swaps to the Gemini vision model", async () => {
    sessionMock.mockResolvedValue({ id: "user-vf1", username: "op", displayName: "Op" });
    const result = makeResult("it's a Sysco invoice");
    streamTextMock.mockImplementation((opts: { onFinish?: unknown }) => {
      result.capture(opts.onFinish as never);
      return result;
    });

    const response = await callChat(imageTurn());

    expect(response.status).toBe(200);
    expect(createVisionChatModelMock).toHaveBeenCalledTimes(1);
    const [args] = streamTextMock.mock.calls[0] as [{ model: unknown }];
    expect(args.model).toMatchObject({ provider: "gemini", id: "gemini-flash-latest" });
    // The image rides through to the (vision-capable) model.
    expect(lastUserHasFilePart()).toBe(true);
  });

  test("vision fallback OFF: an image turn stays on the text provider with the image stripped", async () => {
    sessionMock.mockResolvedValue({ id: "user-vf2", username: "op", displayName: "Op" });
    getSettingMock.mockImplementation(async (key: string) =>
      key === "ai.vision_fallback_enabled" ? false : settingDefault(key),
    );
    const result = makeResult("I can't see images");
    streamTextMock.mockImplementation((opts: { onFinish?: unknown }) => {
      result.capture(opts.onFinish as never);
      return result;
    });

    const response = await callChat(imageTurn());

    expect(response.status).toBe(200);
    expect(createVisionChatModelMock).not.toHaveBeenCalled();
    const [args] = streamTextMock.mock.calls[0] as [{ model: unknown }];
    expect(args.model).toMatchObject({ provider: "deepseek", id: "deepseek-v4-pro" });
    // Original behavior preserved: the image never reaches the text model.
    expect(lastUserHasFilePart()).toBe(false);
  });

  test("a multimodal chat provider (gemini) keeps the image and does NOT use the fallback", async () => {
    sessionMock.mockResolvedValue({ id: "user-vf3", username: "op", displayName: "Op" });
    createChatModelMock.mockResolvedValue({
      model: { provider: "gemini", id: "gemini-2.5-flash" },
      provider: "gemini",
      modelId: "gemini-2.5-flash",
    });
    const result = makeResult("a multimodal answer");
    streamTextMock.mockImplementation((opts: { onFinish?: unknown }) => {
      result.capture(opts.onFinish as never);
      return result;
    });

    const response = await callChat(imageTurn());

    expect(response.status).toBe(200);
    expect(createVisionChatModelMock).not.toHaveBeenCalled();
    const [args] = streamTextMock.mock.calls[0] as [{ model: unknown }];
    expect(args.model).toMatchObject({ provider: "gemini", id: "gemini-2.5-flash" });
    expect(lastUserHasFilePart()).toBe(true);
  });

  test("a text-only turn never consults the vision fallback", async () => {
    sessionMock.mockResolvedValue({ id: "user-vf4", username: "op", displayName: "Op" });
    const result = makeResult("plain text answer");
    streamTextMock.mockImplementation((opts: { onFinish?: unknown }) => {
      result.capture(opts.onFinish as never);
      return result;
    });

    await callChat({ messages: [{ role: "user", parts: [{ type: "text", text: "how is stock" }] }] });

    expect(createVisionChatModelMock).not.toHaveBeenCalled();
    const [args] = streamTextMock.mock.calls[0] as [{ model: unknown }];
    expect(args.model).toMatchObject({ provider: "deepseek", id: "deepseek-v4-pro" });
  });

  test("image turn returns 503 when the vision fallback key is missing (createVisionChatModel throws)", async () => {
    sessionMock.mockResolvedValue({ id: "user-vf5", username: "op", displayName: "Op" });
    createVisionChatModelMock.mockImplementationOnce(() => {
      throw new Error("Vision API key not configured");
    });

    const response = await callChat(imageTurn());

    expect(response.status).toBe(503);
    const payload = (await response.json()) as { error: string };
    expect(payload.error).toBe("auth_not_configured");
    expect(streamTextMock).not.toHaveBeenCalled();
  });
});
