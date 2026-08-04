import { describe, expect, it, vi } from "vitest";

import { generateObject } from "ai";

import { suggestCatalogMatches } from "@/lib/ai/match-suggest";

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

describe("suggestCatalogMatches", () => {
  it("keeps real candidate ids, drops hallucinated ones, and clamps confidence (ADR-0538 D3 guard)", async () => {
    vi.mocked(generateObject).mockResolvedValue({
      object: {
        suggestions: [
          { index: 0, item_id: "item-a", confidence: 0.92 },
          { index: 1, item_id: "item-ghost", confidence: 1.4 }, // not a candidate → null
          { index: 2, item_id: null, confidence: 0.1 },
        ],
      },
    } as never);

    const out = await suggestCatalogMatches({
      lines: [
        { index: 0, text: "members mark milk 12 oz" },
        { index: 1, text: "mystery thing" },
        { index: 2, text: "another" },
      ],
      candidates: [{ id: "item-a", name: "Milk 12 oz" }],
    });

    expect(out).toEqual([
      { index: 0, item_id: "item-a", confidence: 0.92 },
      { index: 1, item_id: null, confidence: 1 }, // hallucinated id dropped; confidence clamped to 1
      { index: 2, item_id: null, confidence: 0.1 },
    ]);
  });

  it("short-circuits without calling the model when there are no candidates", async () => {
    vi.mocked(generateObject).mockClear();
    const out = await suggestCatalogMatches({
      lines: [{ index: 0, text: "x" }],
      candidates: [],
    });
    expect(out).toEqual([]);
    expect(generateObject).not.toHaveBeenCalled();
  });
});
