import { beforeEach, describe, expect, it, vi } from "vitest";

const aggregateMock = vi.fn();
// Untyped (like aggregateMock); returns undefined → buildUsageReport falls back to the
// baked price table. Override per-test with priceCacheMock.mockResolvedValue(...).
const priceCacheMock = vi.fn();
vi.mock("@/lib/ai/db", () => ({
  aggregateAiUsageSince: (...a: unknown[]) => aggregateMock(...a),
  loadModelPriceCache: (...a: unknown[]) => priceCacheMock(...a),
  recordAiUsageEvent: vi.fn(),
}));
vi.mock("@/lib/ai/log", () => ({
  logErrorEvent: vi.fn(),
  errorMessage: (_e: unknown, fallback: string) => fallback,
}));

import {
  buildUsageReport,
  estimateCostUsd,
  parseUsagePeriod,
  periodRange,
} from "@/lib/ai/usage";
import { priceFor } from "@/lib/ai/model-prices";
import { selectProviderPrices } from "@/lib/ai/litellm-prices";
import { litellmEntryToPrice } from "../../../../scripts/ai-prices-sync.mjs";

describe("estimateCostUsd", () => {
  it("prices a known model by input + output per 1M tokens", () => {
    const p = priceFor("gpt-4o");
    expect(p).not.toBeNull();
    expect(estimateCostUsd("gpt-4o", 1_000_000, 1_000_000)).toBeCloseTo(
      (p?.inputPer1M ?? 0) + (p?.outputPer1M ?? 0),
    );
    expect(estimateCostUsd("gpt-4o", 0, 0)).toBe(0);
  });

  it("returns null for a model with no price on file (not $0)", () => {
    expect(estimateCostUsd("some-unknown-model", 1000, 1000)).toBeNull();
  });

  it("prices cache-hit input tokens at the cheaper cached rate", () => {
    const flash = priceFor("deepseek-v4-flash");
    expect(flash?.cachedInputPer1M).toBeDefined();
    // All 1M input tokens hit the cache → billed at the cached rate, not full input.
    expect(estimateCostUsd("deepseek-v4-flash", 1_000_000, 0, 1_000_000)).toBeCloseTo(
      flash?.cachedInputPer1M ?? 0,
    );
    // Half cached → blend of full + cached input rates.
    const oai = priceFor("gpt-4o");
    expect(estimateCostUsd("gpt-4o", 1_000_000, 0, 500_000)).toBeCloseTo(
      0.5 * (oai?.inputPer1M ?? 0) + 0.5 * (oai?.cachedInputPer1M ?? 0),
    );
  });

  it("clamps cached tokens to the input total (never negative uncached)", () => {
    const flash = priceFor("deepseek-v4-flash");
    expect(estimateCostUsd("deepseek-v4-flash", 1000, 0, 999_999)).toBeCloseTo(
      (1000 / 1_000_000) * (flash?.cachedInputPer1M ?? 0),
    );
  });
});

describe("priceFor", () => {
  it("resolves a non-identity alias to the catalog price (deepseek-v4-pro → deepseek-chat)", () => {
    expect(priceFor("deepseek-v4-pro")).toEqual({
      inputPer1M: 0.28,
      cachedInputPer1M: 0.028,
      outputPer1M: 0.42,
    });
  });

  it("prices identity-mapped ids straight from the synced table (gemini-3.1-flash-lite)", () => {
    // Regression guard: the old hand-seeded value was wrong (0.1/0.4); LiteLLM has 0.25/1.5.
    const p = priceFor("gemini-3.1-flash-lite");
    expect(p?.inputPer1M).toBeCloseTo(0.25);
    expect(p?.outputPer1M).toBeCloseTo(1.5);
  });

  it("lets an operator override cover a model the catalog lacks (deepseek-v4-flash)", () => {
    expect(priceFor("deepseek-v4-flash")).toEqual({
      inputPer1M: 0.07,
      cachedInputPer1M: 0.0028,
      outputPer1M: 0.28,
    });
  });

  it("returns null for an unknown model id (UI shows '—', not $0)", () => {
    expect(priceFor("no-such-model")).toBeNull();
  });

  it("prices a newly-selected model from the live cache (absent from the baked table)", () => {
    const live = { "gemini-2.5-flash-lite": { inputPer1M: 0.1, outputPer1M: 0.4 } };
    expect(priceFor("gemini-2.5-flash-lite")).toBeNull(); // unknown without the cache
    expect(priceFor("gemini-2.5-flash-lite", live)).toEqual({ inputPer1M: 0.1, outputPer1M: 0.4 });
  });

  it("prefers the live cache over the baked table, and an override over both", () => {
    const live = {
      "gpt-4o": { inputPer1M: 9, outputPer1M: 9 },
      "deepseek-v4-flash": { inputPer1M: 9, outputPer1M: 9 },
    };
    // gpt-4o is baked at 2.5/10 — the live value wins.
    expect(priceFor("gpt-4o", live)).toEqual({ inputPer1M: 9, outputPer1M: 9 });
    // deepseek-v4-flash has an override — it wins even when the live cache holds its key.
    expect(priceFor("deepseek-v4-flash", live)?.inputPer1M).toBeCloseTo(0.07);
  });
});

describe("selectProviderPrices (runtime LiteLLM filter)", () => {
  const catalog = {
    "gpt-4o": {
      input_cost_per_token: 2.5e-6,
      output_cost_per_token: 1e-5,
      cache_read_input_token_cost: 1.25e-6,
    },
    "gemini-2.5-flash": { input_cost_per_token: 3e-7, output_cost_per_token: 2.5e-6 },
    "deepseek-chat": { input_cost_per_token: 2.8e-7, output_cost_per_token: 4.2e-7 },
    "claude-sonnet-4-6": { input_cost_per_token: 3e-6, output_cost_per_token: 1.5e-5 },
    "azure_ai/deepseek-v3": { input_cost_per_token: 1.14e-6, output_cost_per_token: 4.56e-6 },
    "mistral-large": { input_cost_per_token: 2e-6, output_cost_per_token: 6e-6 },
    sample_spec: { litellm_provider: "x" },
  };

  it("keeps our provider families, converts per-1M, and drops rehosts/other providers", () => {
    const prices = selectProviderPrices(catalog);
    // gpt/gemini/deepseek/claude kept; azure rehost, mistral, and the meta-entry dropped.
    expect(Object.keys(prices).sort()).toEqual([
      "claude-sonnet-4-6",
      "deepseek-chat",
      "gemini-2.5-flash",
      "gpt-4o",
    ]);
    expect(prices["gpt-4o"]?.inputPer1M).toBeCloseTo(2.5);
    expect(prices["gpt-4o"]?.cachedInputPer1M).toBeCloseTo(1.25);
    expect(prices["gemini-2.5-flash"]?.cachedInputPer1M).toBeUndefined();
  });
});

describe("litellmEntryToPrice (sync extractor)", () => {
  it("converts per-token costs to per-1M and maps the cache-read rate", () => {
    const p = litellmEntryToPrice({
      input_cost_per_token: 2.5e-6,
      output_cost_per_token: 1e-5,
      cache_read_input_token_cost: 1.25e-6,
    });
    expect(p?.inputPer1M).toBeCloseTo(2.5);
    expect(p?.outputPer1M).toBeCloseTo(10);
    expect(p?.cachedInputPer1M).toBeCloseTo(1.25);
  });

  it("omits cachedInputPer1M when the entry has no cache-read cost", () => {
    const p = litellmEntryToPrice({ input_cost_per_token: 1e-6, output_cost_per_token: 2e-6 });
    expect(p?.inputPer1M).toBeCloseTo(1);
    expect(Object.prototype.hasOwnProperty.call(p ?? {}, "cachedInputPer1M")).toBe(false);
  });

  it("returns null when input/output costs are absent (skipped, not priced at $0)", () => {
    expect(litellmEntryToPrice({ context_window: 128_000 })).toBeNull();
    expect(litellmEntryToPrice(null)).toBeNull();
  });
});

describe("parseUsagePeriod", () => {
  it("accepts month/last and defaults everything else to 7d", () => {
    expect(parseUsagePeriod("month")).toBe("month");
    expect(parseUsagePeriod("last")).toBe("last");
    expect(parseUsagePeriod("7d")).toBe("7d");
    expect(parseUsagePeriod(null)).toBe("7d");
    expect(parseUsagePeriod("garbage")).toBe("7d");
  });
});

describe("periodRange", () => {
  const now = new Date("2026-06-19T12:00:00Z");

  it("7d is the trailing week ending now", () => {
    const { since, until } = periodRange("7d", now);
    expect(until).toEqual(now);
    expect(since.toISOString()).toBe("2026-06-12T12:00:00.000Z");
  });

  it("month is first-of-month UTC to now", () => {
    const { since, until } = periodRange("month", now);
    expect(since.toISOString()).toBe("2026-06-01T00:00:00.000Z");
    expect(until).toEqual(now);
  });

  it("last is the previous whole UTC month", () => {
    const { since, until } = periodRange("last", now);
    expect(since.toISOString()).toBe("2026-05-01T00:00:00.000Z");
    expect(until.toISOString()).toBe("2026-06-01T00:00:00.000Z");
  });
});

describe("buildUsageReport", () => {
  beforeEach(() => vi.clearAllMocks());

  it("prices rows, sorts costliest-first, totals, and flags unpriced", async () => {
    aggregateMock.mockResolvedValue([
      { feature: "chat", modelId: "gpt-4o", requests: 2, inputTokens: 1_000_000, outputTokens: 1_000_000 },
      { feature: "matcher", modelId: "mystery-model", requests: 5, inputTokens: 500, outputTokens: 100 },
      { feature: "emoji", modelId: "deepseek-v4-flash", requests: 1, inputTokens: 1000, outputTokens: 1000 },
    ]);

    const report = await buildUsageReport("7d");

    // Costliest first (gpt-4o = $12.50).
    expect(report.rows[0]?.modelId).toBe("gpt-4o");
    // Unpriced model reported null, not 0.
    expect(report.rows.find((r) => r.modelId === "mystery-model")?.estCostUsd).toBeNull();
    // Totals sum across rows; cost is the priced floor with the unpriced flag set.
    expect(report.totals.requests).toBe(8);
    expect(report.totals.inputTokens).toBe(1_000_000 + 500 + 1000);
    expect(report.totals.hasUnpriced).toBe(true);
    expect(report.totals.estCostUsd).toBeCloseTo(
      12.5 + (1000 / 1_000_000) * 0.07 + (1000 / 1_000_000) * 0.28,
    );
  });

  it("returns an empty, unflagged report when there is no usage", async () => {
    aggregateMock.mockResolvedValue([]);
    const report = await buildUsageReport("month");
    expect(report.rows).toEqual([]);
    expect(report.totals).toEqual({
      requests: 0,
      inputTokens: 0,
      outputTokens: 0,
      estCostUsd: 0,
      hasUnpriced: false,
    });
  });
});
