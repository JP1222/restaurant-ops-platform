import { describe, expect, it } from "vitest";
import {
  ensureSyncFreshnessGauge,
  recordSyncFreshness,
  RECURRING_SYNC_JOB_TYPES,
  secondsSinceLastSuccess,
} from "../src/metrics/sync-freshness-gauges.js";

// GH #142: prove the freshness gauge's "no data on never-completed" semantics
// (so a fresh deploy doesn't false-fire) and that a stale completion produces a
// climbing seconds-since value the Prometheus rule can alert on.

const NOW = new Date("2026-06-16T12:00:00.000Z");

describe("secondsSinceLastSuccess (GH #142)", () => {
  it("returns null when the job has never completed (series stays absent)", () => {
    expect(secondsSinceLastSuccess(null, NOW)).toBeNull();
  });

  it("returns null for an unparseable timestamp rather than NaN", () => {
    expect(secondsSinceLastSuccess("not-a-date", NOW)).toBeNull();
  });

  it("returns elapsed seconds for a past completion", () => {
    // 3 hours ago
    expect(secondsSinceLastSuccess("2026-06-16T09:00:00.000Z", NOW)).toBe(3 * 3600);
  });

  it("clamps a future completion to 0 (clock skew never goes negative)", () => {
    expect(secondsSinceLastSuccess("2026-06-16T12:05:00.000Z", NOW)).toBe(0);
  });
});

async function seriesValue(jobType: string, merchantId: string): Promise<number | undefined> {
  const snap = await ensureSyncFreshnessGauge().get();
  return snap.values.find(
    (v) => v.labels.job_type === jobType && v.labels.merchant_id === merchantId
  )?.value;
}

describe("recordSyncFreshness (GH #142)", () => {
  it("sets a stale series and omits never-completed rows", async () => {
    recordSyncFreshness(
      [
        { jobType: "hourly_rest_sweep", merchantId: "M1", lastCompletedAt: "2026-06-16T09:00:00.000Z" },
        { jobType: "export_reconcile", merchantId: "M1", lastCompletedAt: null }
      ],
      NOW
    );
    expect(await seriesValue("hourly_rest_sweep", "M1")).toBe(3 * 3600);
    // never-completed → absent, not 0 (so the alert reads "no data")
    expect(await seriesValue("export_reconcile", "M1")).toBeUndefined();
  });

  it("tracks square_sweep — a Square store's only ingest path is alertable", async () => {
    // Regression: square_sweep was missing from RECURRING_SYNC_JOB_TYPES, so a
    // stalled Square ingest emitted no freshness series and Prometheus could not
    // alert on it (multi-store audit Must-change D).
    expect(RECURRING_SYNC_JOB_TYPES).toContain("square_sweep");
    recordSyncFreshness(
      [{ jobType: "square_sweep", merchantId: "SQ1", lastCompletedAt: "2026-06-16T09:00:00.000Z" }],
      NOW
    );
    expect(await seriesValue("square_sweep", "SQ1")).toBe(3 * 3600);
  });

  it("resets stale series each cycle so a recovered job stops reporting", async () => {
    recordSyncFreshness(
      [{ jobType: "hourly_rest_sweep", merchantId: "M2", lastCompletedAt: "2026-06-16T08:00:00.000Z" }],
      NOW
    );
    expect(await seriesValue("hourly_rest_sweep", "M2")).toBe(4 * 3600);

    // Next cycle: M2 no longer in the rows → its series clears.
    recordSyncFreshness([], NOW);
    expect(await seriesValue("hourly_rest_sweep", "M2")).toBeUndefined();
  });
});
