import { beforeEach, describe, expect, test, vi } from "vitest";

const generateTextMock = vi.fn();
const createVisionProviderMock = vi.fn();
const getSettingMock = vi.fn();

// Stand-in for the provider's key error, initialized before the hoisted mock
// factory reads it (a plain class would hit the TDZ). The module's
// `instanceof MissingVisionKeyError` resolves to this same class.
const { MissingVisionKeyError } = vi.hoisted(() => ({
  MissingVisionKeyError: class MissingVisionKeyError extends Error {
    constructor() {
      super("missing key");
      this.name = "MissingVisionKeyError";
    }
  },
}));

vi.mock("ai", async () => {
  const actual = await vi.importActual<typeof import("ai")>("ai");
  return { ...actual, generateText: (...args: unknown[]) => generateTextMock(...args) };
});

vi.mock("@/lib/ai/vision-provider", () => ({
  createVisionProvider: (...args: unknown[]) => createVisionProviderMock(...args),
  MissingVisionKeyError,
}));

vi.mock("@/lib/settings", () => ({
  getSetting: (...args: unknown[]) => getSettingMock(...args),
}));

vi.mock("@/lib/ai/log", () => ({
  logErrorEvent: () => {},
  errorMessage: (cause: unknown, fallback: string) =>
    cause instanceof Error ? cause.message : fallback,
}));

import { groundedWebSearch } from "@/lib/ai/grounded-search";

// A provider stub: a callable that returns a model handle and carries the
// `.tools.googleSearch` provider-defined tool factory the module wires in.
function providerStub() {
  const provider = ((modelId: string) => ({ modelId })) as unknown as {
    (modelId: string): unknown;
    tools: { googleSearch: (config: unknown) => unknown };
  };
  provider.tools = { googleSearch: () => ({ type: "google_search" }) };
  return provider;
}

describe("groundedWebSearch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getSettingMock.mockResolvedValue("gemini-flash-latest");
    createVisionProviderMock.mockResolvedValue(providerStub());
  });

  test("maps Gemini url sources to {title,url} and returns available=true", async () => {
    generateTextMock.mockResolvedValue({
      text: "Wholesale tapioca runs about $30 a case.",
      sources: [
        { type: "source", sourceType: "url", id: "s1", title: "Supplier A", url: "https://a.example.com/boba" },
        // A url source with no title falls back to the url.
        { type: "source", sourceType: "url", id: "s2", url: "https://b.example.com/x" },
        // Non-url sources are ignored.
        { type: "source", sourceType: "document", id: "d1", title: "doc", mediaType: "application/pdf" },
      ],
      providerMetadata: {},
    });

    const result = await groundedWebSearch("wholesale boba price");

    expect(result.available).toBe(true);
    expect(result.answer).toBe("Wholesale tapioca runs about $30 a case.");
    expect(result.sources).toEqual([
      { title: "Supplier A", url: "https://a.example.com/boba" },
      { title: "https://b.example.com/x", url: "https://b.example.com/x" },
    ]);
  });

  test("caps sources at 10", async () => {
    const many = Array.from({ length: 15 }, (_value, index) => ({
      type: "source",
      sourceType: "url",
      id: `s${index}`,
      title: `Source ${index}`,
      url: `https://example.com/${index}`,
    }));
    generateTextMock.mockResolvedValue({ text: "ok", sources: many, providerMetadata: {} });

    const result = await groundedWebSearch("news");
    expect(result.sources).toHaveLength(10);
  });

  test("a missing Gemini key returns the graceful unavailable shape (never throws)", async () => {
    createVisionProviderMock.mockRejectedValue(new MissingVisionKeyError());

    const result = await groundedWebSearch("anything");
    expect(result).toEqual({ query: "anything", answer: "", sources: [], available: false });
    expect(generateTextMock).not.toHaveBeenCalled();
  });

  test("a grounding/model error returns the graceful unavailable shape (never a 500)", async () => {
    generateTextMock.mockRejectedValue(new Error("model does not support google_search"));

    const result = await groundedWebSearch("anything");
    expect(result).toEqual({ query: "anything", answer: "", sources: [], available: false });
  });
});
