import { afterEach, describe, expect, it } from "vitest";
import type { ServerResponse } from "node:http";
import { handleMetrics } from "../src/http/metrics.js";
import {
  ensureBackfillGauges,
  recordBackfillSummary,
  resetBackfillGauges,
  secondsSinceLastProgress,
  type BackfillSummaryForGauges,
} from "../src/metrics/backfill-gauges.js";

const NOW = new Date("2026-06-14T00:00:00.000Z");

function summary(overrides: Partial<BackfillSummaryForGauges> = {}): BackfillSummaryForGauges {
  return {
    expectedWindows: 100,
    completedWindows: 40,
    blockedWindows: 0,
    failedWindows: 0,
    progressPct: 40,
    lastCompletedAt: "2026-06-13T00:00:00.000Z",
    oldestWindowUpdatedAt: "2018-04-01T00:00:00.000Z",
    ...overrides,
  };
}

type Gauge = ReturnType<typeof ensureBackfillGauges>["expectedWindows"];

async function valueFor(gauge: Gauge, merchantId: string) {
  const metric = await gauge.get();
  return metric.values.find((v) => v.labels.merchant_id === merchantId)?.value;
}

afterEach(() => {
  resetBackfillGauges();
});

describe("secondsSinceLastProgress", () => {
  it("is null when the backfill is complete (no remaining windows)", () => {
    expect(
      secondsSinceLastProgress(
        { lastCompletedAt: "2026-06-13T00:00:00.000Z", oldestWindowUpdatedAt: null, remainingWindows: 0 },
        NOW,
      ),
    ).toBeNull();
  });

  it("anchors on lastCompletedAt when present", () => {
    const result = secondsSinceLastProgress(
      { lastCompletedAt: "2026-06-13T00:00:00.000Z", oldestWindowUpdatedAt: "2018-04-01T00:00:00.000Z", remainingWindows: 5 },
      NOW,
    );
    expect(result).toBe(24 * 3600); // exactly one day stale
  });

  it("falls back to the oldest window touch when nothing has completed yet", () => {
    const result = secondsSinceLastProgress(
      { lastCompletedAt: null, oldestWindowUpdatedAt: "2026-06-12T00:00:00.000Z", remainingWindows: 5 },
      NOW,
    );
    expect(result).toBe(2 * 24 * 3600); // two days since the backfill started trying
  });

  it("is null when nothing has been observed and nothing completed", () => {
    expect(
      secondsSinceLastProgress({ lastCompletedAt: null, oldestWindowUpdatedAt: null, remainingWindows: 5 }, NOW),
    ).toBeNull();
  });

  it("is null on an unparseable timestamp rather than NaN", () => {
    expect(
      secondsSinceLastProgress({ lastCompletedAt: "not-a-date", oldestWindowUpdatedAt: null, remainingWindows: 5 }, NOW),
    ).toBeNull();
  });

  it("clamps to 0 instead of going negative on a future anchor", () => {
    expect(
      secondsSinceLastProgress(
        { lastCompletedAt: "2999-01-01T00:00:00.000Z", oldestWindowUpdatedAt: null, remainingWindows: 5 },
        NOW,
      ),
    ).toBe(0);
  });
});

describe("recordBackfillSummary", () => {
  it("sets every gauge for the merchant, labelled by merchant_id", async () => {
    const gauges = ensureBackfillGauges();
    recordBackfillSummary("m1", summary(), NOW);

    expect(await valueFor(gauges.expectedWindows, "m1")).toBe(100);
    expect(await valueFor(gauges.completedWindows, "m1")).toBe(40);
    expect(await valueFor(gauges.remainingWindows, "m1")).toBe(60);
    expect(await valueFor(gauges.progressPct, "m1")).toBe(40);
    expect(await valueFor(gauges.blockedWindows, "m1")).toBe(0);
    expect(await valueFor(gauges.secondsSinceLastCompleted, "m1")).toBe(24 * 3600);
  });

  it("leaves seconds_since_last_completed absent when the backfill is complete", async () => {
    const gauges = ensureBackfillGauges();
    recordBackfillSummary(
      "m1",
      summary({ completedWindows: 100, progressPct: 100, expectedWindows: 100 }),
      NOW,
    );

    expect(await valueFor(gauges.remainingWindows, "m1")).toBe(0);
    expect(await valueFor(gauges.secondsSinceLastCompleted, "m1")).toBeUndefined();
  });

  it("keeps separate series per merchant (multi-location)", async () => {
    const gauges = ensureBackfillGauges();
    recordBackfillSummary("m1", summary({ blockedWindows: 2 }), NOW);
    recordBackfillSummary("m2", summary({ blockedWindows: 0 }), NOW);

    expect(await valueFor(gauges.blockedWindows, "m1")).toBe(2);
    expect(await valueFor(gauges.blockedWindows, "m2")).toBe(0);
  });
});

describe("resetBackfillGauges", () => {
  it("clears all per-merchant series", async () => {
    const gauges = ensureBackfillGauges();
    recordBackfillSummary("m1", summary(), NOW);
    expect(await valueFor(gauges.expectedWindows, "m1")).toBe(100);

    resetBackfillGauges();
    expect((await gauges.expectedWindows.get()).values).toHaveLength(0);
  });
});

describe("/metrics integration", () => {
  it("exposes the rop_backfill_* gauges in the Prometheus text format", async () => {
    recordBackfillSummary("m1", summary({ blockedWindows: 1 }), NOW);

    const body = { value: "" };
    const res = {
      statusCode: 0,
      headers: {} as Record<string, string>,
      setHeader(key: string, value: string) {
        this.headers[key] = value;
      },
      end(chunk = "") {
        body.value = chunk;
      },
    } as ServerResponse & { headers: Record<string, string> };

    await handleMetrics(res);

    expect(body.value).toContain("rop_backfill_blocked_windows");
    expect(body.value).toContain("rop_backfill_progress_pct");
    expect(body.value).toContain('merchant_id="m1"');
  });
});
