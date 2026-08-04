import { beforeEach, describe, expect, it, vi } from "vitest";

import { generateObject } from "ai";

import { parseReceiptImage } from "@/lib/ai/receipt-parse";
import { getSetting } from "@/lib/settings";

// The vision SDK call + provider + model setting are mocked so this exercises the
// pure orchestration in parseReceiptImage: null->undefined mapping, contract
// re-validation, the retry-budget wiring, and the success-path latency metric
// (ADR-0538). The deterministic catalog matching is covered separately in
// inventory-receipt-samsclub.test.ts.
vi.mock("ai", () => ({ generateObject: vi.fn() }));
vi.mock("@/lib/ai/vision-provider", () => ({
  createVisionProvider: vi.fn(async () => () => "vision-model"),
  MissingVisionKeyError: class MissingVisionKeyError extends Error {},
}));
vi.mock("@/lib/settings", () => ({
  getSetting: vi.fn(async () => "gemini-flash-latest"),
}));

const logVisionMock = vi.fn();
vi.mock("@/lib/ai/log", () => ({
  logVisionParseEvent: (...args: unknown[]) => logVisionMock(...args),
}));
vi.mock("@/lib/ai/usage", () => ({ recordAiUsage: vi.fn() }));

const OBJECT = {
  vendor: "Sam's Club",
  invoice_date: "2026-06-15",
  lines: [
    {
      description: "GREAT VALUE WHOLE MILK 1 GAL",
      qty: 24,
      unit: null,
      unit_price_cents: 348,
      canonical_name: "Whole Milk 1 Gal",
      brand: "Great Value",
      pack: "1 Gal",
    },
  ],
};

describe("parseReceiptImage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(generateObject).mockResolvedValue({ object: OBJECT } as never);
    // Default: every settings key resolves to the primary model, so the fallback path is
    // inert (fallback === primary) unless a test opts in below.
    vi.mocked(getSetting).mockImplementation(
      (() => Promise.resolve("gemini-flash-latest")) as typeof getSetting,
    );
  });

  it("returns the contract-shaped parse (null -> undefined at the boundary)", async () => {
    const out = await parseReceiptImage("ZmFrZQ==", "image/jpeg");
    expect(out.vendor).toBe("Sam's Club");
    expect(out.lines).toHaveLength(1);
    expect(out.lines[0]).toMatchObject({
      description: "GREAT VALUE WHOLE MILK 1 GAL",
      qty: 24,
      unit_price_cents: 348,
      canonical_name: "Whole Milk 1 Gal",
    });
    // A model null for `unit` maps to an absent optional, not a literal null.
    expect(out.lines[0]?.unit).toBeUndefined();
  });

  it("emits one success latency event with line/vendor/model metadata", async () => {
    await parseReceiptImage("ZmFrZQ==", "image/jpeg");
    expect(logVisionMock).toHaveBeenCalledTimes(1);
    const ev = logVisionMock.mock.calls[0]?.[0] as {
      latencyMs: number;
      lineCount: number;
      vendorPresent: boolean;
      modelId: string;
    };
    expect(ev).toMatchObject({ lineCount: 1, vendorPresent: true, modelId: "gemini-flash-latest" });
    expect(typeof ev.latencyMs).toBe("number");
    expect(ev.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("passes the pinned retry budget to generateObject", async () => {
    await parseReceiptImage("ZmFrZQ==", "image/png");
    expect(vi.mocked(generateObject).mock.calls.at(-1)?.[0]).toMatchObject({ maxRetries: 2 });
  });

  it("logs droppedLines: 0 on a clean parse", async () => {
    await parseReceiptImage("ZmFrZQ==", "image/jpeg");
    expect(logVisionMock.mock.calls[0]?.[0]).toMatchObject({ lineCount: 1, droppedLines: 0 });
  });

  it("drops only the contract-invalid lines and keeps the good ones (per-line resilience)", async () => {
    // A real failure mode: the model reads a credit/return line as a NEGATIVE qty/price,
    // which passes the loose model schema but violates the contract's .nonnegative(). The
    // bad line must be dropped + counted, NOT 502 the whole multi-line invoice.
    vi.mocked(generateObject).mockResolvedValue({
      object: {
        vendor: "Sam's Club",
        invoice_date: null,
        lines: [
          { description: "WHOLE MILK 1 GAL", qty: 24, unit: null, unit_price_cents: 348, canonical_name: null, brand: null, pack: null },
          { description: "RETURN CREDIT", qty: -2, unit: null, unit_price_cents: -500, canonical_name: null, brand: null, pack: null },
          { description: "   ", qty: 6, unit: null, unit_price_cents: 100, canonical_name: null, brand: null, pack: null },
        ],
      },
    } as never);
    const out = await parseReceiptImage("ZmFrZQ==", "image/jpeg");
    expect(out.lines).toHaveLength(1);
    expect(out.lines[0]?.description).toBe("WHOLE MILK 1 GAL");
    expect(logVisionMock).toHaveBeenCalledTimes(1);
    expect(logVisionMock.mock.calls[0]?.[0]).toMatchObject({ lineCount: 1, droppedLines: 2 });
  });

  it("coerces an over-long vendor label to undefined instead of rejecting the parse", async () => {
    vi.mocked(generateObject).mockResolvedValue({
      object: {
        vendor: "V".repeat(200), // contract caps vendor at 120
        invoice_date: null,
        lines: [{ description: "WHOLE MILK 1 GAL", qty: 24, unit: null, unit_price_cents: 348, canonical_name: null, brand: null, pack: null }],
      },
    } as never);
    const out = await parseReceiptImage("ZmFrZQ==", "image/jpeg");
    expect(out.vendor).toBeUndefined();
    expect(out.lines).toHaveLength(1);
  });

  it("throws (no success log) only when EVERY line is contract-invalid", async () => {
    // Total extraction failure keeps the hard signal — route maps it to parse_failed/502
    // and a failed extraction must never count as a logged success.
    vi.mocked(generateObject).mockResolvedValue({
      object: { vendor: null, invoice_date: null, lines: [{ description: "x", qty: -1 }] },
    } as never);
    await expect(parseReceiptImage("ZmFrZQ==", "image/jpeg")).rejects.toThrow();
    expect(logVisionMock).not.toHaveBeenCalled();
  });

  it("falls back to the secondary model on a transient primary failure (and logs fallbackUsed)", async () => {
    // ai.vision_fallback_model_id is distinct from the primary; the primary call fails with a
    // transient "high demand" overload, so the fallback model carries the parse.
    vi.mocked(getSetting).mockImplementation(
      ((key: string) =>
        Promise.resolve(
          key === "ai.vision_fallback_model_id" ? "gemini-3.1-flash-lite" : "gemini-flash-latest",
        )) as typeof getSetting,
    );
    vi.mocked(generateObject)
      .mockRejectedValueOnce(new Error("This model is currently experiencing high demand"))
      .mockResolvedValueOnce({ object: OBJECT } as never);

    const out = await parseReceiptImage("ZmFrZQ==", "image/jpeg");

    expect(out.lines).toHaveLength(1);
    expect(vi.mocked(generateObject)).toHaveBeenCalledTimes(2);
    expect(logVisionMock).toHaveBeenCalledTimes(1);
    expect(logVisionMock.mock.calls[0]?.[0]).toMatchObject({
      modelId: "gemini-3.1-flash-lite",
      fallbackUsed: true,
    });
  });

  it("does not fall back when no fallback model is configured", async () => {
    vi.mocked(getSetting).mockImplementation(
      ((key: string) =>
        Promise.resolve(key === "ai.vision_fallback_model_id" ? "" : "gemini-flash-latest")) as typeof getSetting,
    );
    vi.mocked(generateObject).mockRejectedValueOnce(new Error("high demand"));

    await expect(parseReceiptImage("ZmFrZQ==", "image/jpeg")).rejects.toThrow(/high demand/);
    expect(vi.mocked(generateObject)).toHaveBeenCalledTimes(1);
    expect(logVisionMock).not.toHaveBeenCalled();
  });
});
