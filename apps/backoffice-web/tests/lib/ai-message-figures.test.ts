import { describe, expect, test } from "vitest";
import type { UIMessage } from "ai";
import { unverifiedFiguresForMessage } from "@/lib/ai/message-figures";

function textPart(text: string) {
  return { type: "text", text };
}

function toolPart(output: unknown) {
  return {
    type: "tool-get_metric",
    toolCallId: "t1",
    state: "output-available",
    input: {},
    output
  };
}

function webSearchPart(output: unknown) {
  return {
    type: "tool-web_search",
    toolCallId: "w1",
    state: "output-available",
    input: { query: "boba price" },
    output
  };
}

function assistant(parts: unknown[]): UIMessage {
  return { id: "m1", role: "assistant", parts } as unknown as UIMessage;
}

describe("unverifiedFiguresForMessage", () => {
  test("does not flag a figure that traces to a tool output (cents -> dollars)", () => {
    // Tool returned 123456 cents; the answer states $1,234.56 — sourced.
    const message = assistant([
      toolPart({ rows: [{ value: 123_456 }], unit: "cents" }),
      textPart("Net sales were $1,234.56 today.")
    ]);
    expect(unverifiedFiguresForMessage(message)).toHaveLength(0);
  });

  test("flags a figure that appears in no tool output", () => {
    const message = assistant([
      toolPart({ rows: [{ value: 123_456 }], unit: "cents" }),
      textPart("Net sales were $1,234.56, up from $9,999.00 last week.")
    ]);
    const flagged = unverifiedFiguresForMessage(message);
    expect(flagged.map((figure) => figure.text)).toEqual(["$9,999.00"]);
  });

  test("flags reported figures when the assistant used no tools at all", () => {
    const message = assistant([textPart("Revenue was about $4,200 yesterday.")]);
    expect(unverifiedFiguresForMessage(message).map((figure) => figure.text)).toEqual([
      "$4,200"
    ]);
  });

  test("ignores user messages and empty answers", () => {
    const user = { id: "u1", role: "user", parts: [textPart("$5,000?")] } as unknown as UIMessage;
    expect(unverifiedFiguresForMessage(user)).toHaveLength(0);
    expect(unverifiedFiguresForMessage(assistant([toolPart({ value: 5 })]))).toHaveLength(0);
  });

  test("a web_search output containing a number does NOT verify a matching answer figure", () => {
    // Governance: web text is untrusted, so a price in a web snippet must NOT make
    // a matching answer figure pass as DB-verified. The figure is still flagged.
    const message = assistant([
      webSearchPart({
        query: "wholesale boba price",
        answer: "A case of tapioca pearls is about $30.00.",
        sources: [{ title: "Supplier", url: "https://example.com/boba" }],
        available: true
      }),
      textPart("Wholesale tapioca is about $30.00 per case.")
    ]);
    const flagged = unverifiedFiguresForMessage(message);
    expect(flagged.map((figure) => figure.text)).toEqual(["$30.00"]);
  });

  test("a real (non-web) tool output still verifies a matching figure (exclusion is web-only)", () => {
    // Sanity: the exclusion is scoped to web tools — DB tool numbers still count.
    const message = assistant([
      toolPart({ rows: [{ value: 3000 }], unit: "cents" }),
      textPart("That came to $30.00.")
    ]);
    expect(unverifiedFiguresForMessage(message)).toHaveLength(0);
  });
});
