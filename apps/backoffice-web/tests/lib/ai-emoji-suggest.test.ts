import { describe, expect, it, vi } from "vitest";

import { generateObject } from "ai";

import { sanitizeEmoji, suggestEmojis } from "@/lib/ai/emoji-suggest";

vi.mock("ai", () => ({ generateObject: vi.fn() }));
vi.mock("@/lib/ai/chat-provider", () => ({
  resolveMatcherTarget: vi.fn(async () => ({ provider: "deepseek", modelId: "model" })),
}));
// Pass-through the fallback wrapper: invoke the call with a stub model so the
// generateObject mock + post-processing assertions below stay the unit under test.
vi.mock("@/lib/ai/text-fallback", () => ({
  withTextFallback: vi.fn(async (_target, run) => ({
    result: await run("model"),
    modelId: "model",
    fallbackUsed: false,
  })),
}));
vi.mock("@/lib/ai/usage", () => ({ recordAiUsage: vi.fn() }));

describe("sanitizeEmoji", () => {
  it("passes a single emoji glyph through (incl. variation-selector + ZWJ sequences)", () => {
    expect(sanitizeEmoji("🥛")).toBe("🥛");
    expect(sanitizeEmoji("🌶️")).toBe("🌶️");
    expect(sanitizeEmoji("👨‍👩‍👧")).toBe("👨‍👩‍👧");
  });

  it("collapses extra trailing text to the first grapheme", () => {
    // "any emoji" mode means we can't whitelist, so the guard takes the first glyph: a model
    // that returns "🥛 milk" still yields a clean icon, not a label.
    expect(sanitizeEmoji("🥛 milk")).toBe("🥛");
    expect(sanitizeEmoji(" 🍓")).toBe("🍓");
  });

  it("rejects non-emoji output to an empty string (word / sentence / punctuation)", () => {
    expect(sanitizeEmoji("milk")).toBe("");
    expect(sanitizeEmoji("a glass of milk")).toBe("");
    expect(sanitizeEmoji("")).toBe("");
    expect(sanitizeEmoji("?")).toBe("");
  });
});

describe("suggestEmojis", () => {
  it("sanitizes per line and pairs by the requested index", async () => {
    vi.mocked(generateObject).mockResolvedValue({
      object: {
        suggestions: [
          { index: 0, emoji: "🥛" },
          { index: 1, emoji: "milk" }, // not emoji-like → ""
          { index: 9, emoji: "🍓" }, // index never requested → dropped
        ],
      },
    } as never);

    const out = await suggestEmojis({
      names: [
        { index: 0, name: "Whole Milk" },
        { index: 1, name: "Mystery Thing" },
      ],
    });

    expect(out).toEqual([
      { index: 0, emoji: "🥛" },
      { index: 1, emoji: "" },
    ]);
  });

  it("short-circuits without calling the model when there are no names", async () => {
    vi.mocked(generateObject).mockClear();
    const out = await suggestEmojis({ names: [] });
    expect(out).toEqual([]);
    expect(generateObject).not.toHaveBeenCalled();
  });
});
