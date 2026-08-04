import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { logChatEvent } from "@/lib/ai/log";

let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(() => {
  logSpy.mockRestore();
});

describe("logChatEvent", () => {
  test("emits a single JSON line with the canonical scope + ISO ts", () => {
    logChatEvent({
      conversationId: "conv-a",
      turn: "assistant",
      modelId: "gpt-5.5",
      inputTokens: 100,
      outputTokens: 200,
      toolCallCount: 1,
      latencyMs: 450,
      finishReason: "stop",
      userId: "user-1",
    });

    expect(logSpy).toHaveBeenCalledTimes(1);
    const arg = logSpy.mock.calls[0]?.[0] as string;
    const parsed = JSON.parse(arg) as Record<string, unknown>;

    expect(parsed.scope).toBe("backoffice.api.ai.chat.turn");
    expect(parsed.conversationId).toBe("conv-a");
    expect(parsed.turn).toBe("assistant");
    expect(parsed.modelId).toBe("gpt-5.5");
    expect(parsed.inputTokens).toBe(100);
    expect(parsed.outputTokens).toBe(200);
    expect(parsed.toolCallCount).toBe(1);
    expect(parsed.latencyMs).toBe(450);
    expect(parsed.finishReason).toBe("stop");
    expect(parsed.userId).toBe("user-1");
    expect(typeof parsed.ts).toBe("string");
    expect(() => new Date(parsed.ts as string).toISOString()).not.toThrow();
  });

  test("omits optional fields cleanly when not provided", () => {
    logChatEvent({
      conversationId: "conv-b",
      turn: "user",
      modelId: "gpt-5.5",
    });

    expect(logSpy).toHaveBeenCalledTimes(1);
    const arg = logSpy.mock.calls[0]?.[0] as string;
    const parsed = JSON.parse(arg) as Record<string, unknown>;
    expect(parsed.scope).toBe("backoffice.api.ai.chat.turn");
    expect(parsed.conversationId).toBe("conv-b");
    expect(parsed.turn).toBe("user");
    expect(parsed.modelId).toBe("gpt-5.5");
    expect(parsed.inputTokens).toBeUndefined();
    expect(parsed.toolCallCount).toBeUndefined();
  });

  // PII guard (issue #212): the chat log line carries only metadata
  // (ids, counts, latency, finishReason). Raw prompt/response bodies live in
  // `ai_messages.content`, never in the stdout sink Loki scrapes. If a future
  // refactor passes a message/system/content field through this helper, this
  // assertion fails so prompts can't silently leak into log aggregation.
  test("never serializes prompt/response bodies into the log line", () => {
    const SECRET = "customer Jane Doe, card 4111-1111-1111-1111";
    logChatEvent({
      conversationId: "conv-c",
      turn: "assistant",
      modelId: "gpt-5.5",
      // Deliberately smuggle prohibited fields past the typed signature to
      // simulate a future refactor; the helper must not echo them.
      ...({
        messages: [{ role: "user", content: SECRET }],
        system: SECRET,
        content: SECRET,
        prompt: SECRET,
      } as unknown as Record<string, never>),
    });

    expect(logSpy).toHaveBeenCalledTimes(1);
    const line = logSpy.mock.calls[0]?.[0] as string;
    expect(line).not.toContain(SECRET);
    const parsed = JSON.parse(line) as Record<string, unknown>;
    expect(parsed.messages).toBeUndefined();
    expect(parsed.system).toBeUndefined();
    expect(parsed.content).toBeUndefined();
    expect(parsed.prompt).toBeUndefined();
  });
});
