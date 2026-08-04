import { describe, expect, it } from "vitest";

import {
  AI_VIEW_SNAPSHOT_MAX_BYTES,
  AiChatRequestSchema,
  WebSearchRequestSchema,
  WebSearchResultSchema,
} from "./ai.js";

const textMessage = (text: string) => ({
  role: "user" as const,
  parts: [{ type: "text", text }],
});

describe("AiChatRequestSchema", () => {
  it("accepts a UIMessage with a text part (the real useChat shape)", () => {
    const parsed = AiChatRequestSchema.parse({ messages: [textMessage("hello")] });
    expect(parsed.messages).toHaveLength(1);
    expect(parsed.viewSnapshot).toBeUndefined();
    expect(parsed.conversationId).toBeUndefined();
  });

  it("accepts a message id and tool-invocation parts", () => {
    const parsed = AiChatRequestSchema.parse({
      messages: [
        {
          id: "m1",
          role: "assistant",
          parts: [
            { type: "text", text: "let me check" },
            { type: "tool-get_inventory_status", state: "output-available", output: {} },
          ],
        },
      ],
    });
    const first = parsed.messages.at(0);
    if (!first) throw new Error("expected one message");
    expect(Array.isArray(first.parts)).toBe(true);
  });

  it("rejects an empty messages array", () => {
    expect(AiChatRequestSchema.safeParse({ messages: [] }).success).toBe(false);
  });

  it("rejects a message with no parts", () => {
    expect(
      AiChatRequestSchema.safeParse({ messages: [{ role: "user", parts: [] }] }).success,
    ).toBe(false);
  });

  it("rejects a content-only message (legacy shape no longer accepted)", () => {
    expect(
      AiChatRequestSchema.safeParse({ messages: [{ role: "user", content: "hi" }] }).success,
    ).toBe(false);
  });

  it("rejects a message with an unknown role", () => {
    expect(
      AiChatRequestSchema.safeParse({
        messages: [{ role: "robot", parts: [{ type: "text", text: "x" }] }],
      }).success,
    ).toBe(false);
  });

  it("accepts a null viewSnapshot and null conversationId", () => {
    const parsed = AiChatRequestSchema.parse({
      messages: [textMessage("hello")],
      viewSnapshot: null,
      conversationId: null,
    });
    expect(parsed.viewSnapshot).toBeNull();
    expect(parsed.conversationId).toBeNull();
  });

  it("accepts a bounded viewSnapshot.data payload", () => {
    const parsed = AiChatRequestSchema.parse({
      messages: [textMessage("hello")],
      viewSnapshot: { view: "today", data: { rows: [1, 2, 3] }, capturedAt: "2026-05-31" },
    });
    expect(parsed.viewSnapshot?.view).toBe("today");
  });

  it("rejects a viewSnapshot.data payload over the byte cap", () => {
    const huge = "x".repeat(AI_VIEW_SNAPSHOT_MAX_BYTES + 10);
    expect(
      AiChatRequestSchema.safeParse({
        messages: [textMessage("hello")],
        viewSnapshot: { data: huge },
      }).success,
    ).toBe(false);
  });
});

describe("WebSearchRequestSchema", () => {
  it("accepts a 1..200 char query", () => {
    expect(WebSearchRequestSchema.parse({ query: "wholesale boba price" }).query).toBe(
      "wholesale boba price",
    );
  });

  it("rejects an empty query", () => {
    expect(WebSearchRequestSchema.safeParse({ query: "" }).success).toBe(false);
  });

  it("rejects an oversized query (> 200 chars)", () => {
    expect(WebSearchRequestSchema.safeParse({ query: "x".repeat(201) }).success).toBe(false);
  });
});

describe("WebSearchResultSchema", () => {
  it("parses a grounded result and defaults available to true", () => {
    const parsed = WebSearchResultSchema.parse({
      query: "boba price",
      answer: "Wholesale tapioca runs about $30 a case.",
      sources: [{ title: "Supplier", url: "https://example.com/boba" }],
    });
    expect(parsed.available).toBe(true);
    expect(parsed.sources).toHaveLength(1);
  });

  it("accepts the clean unavailable shape", () => {
    const parsed = WebSearchResultSchema.parse({
      query: "x",
      answer: "",
      sources: [],
      available: false,
    });
    expect(parsed.available).toBe(false);
  });

  it("rejects a non-URL source", () => {
    expect(
      WebSearchResultSchema.safeParse({
        query: "x",
        answer: "y",
        sources: [{ title: "bad", url: "not a url" }],
      }).success,
    ).toBe(false);
  });

  it("rejects more than 10 sources", () => {
    const sources = Array.from({ length: 11 }, (_value, index) => ({
      title: `s${index}`,
      url: `https://example.com/${index}`,
    }));
    expect(
      WebSearchResultSchema.safeParse({ query: "x", answer: "y", sources }).success,
    ).toBe(false);
  });
});
