import { describe, expect, it } from "vitest";

import { computeMetricStats, MODIFIED_Z_ANOMALY } from "../src/analytics/metric-stats.js";

describe("computeMetricStats", () => {
  // Tight baseline around 100 → median 100, MAD 1.
  const tight = [100, 101, 99, 100, 102, 98, 100, 101, 99, 100];

  it("flags a clear high outlier via the robust z-score", () => {
    const s = computeMetricStats(tight, 200);
    expect(s.isAnomaly).toBe(true);
    expect(s.direction).toBe("high");
    expect(s.percentile).toBe(1); // 200 >= every baseline value
    expect(Math.abs(s.modifiedZ!)).toBeGreaterThan(MODIFIED_Z_ANOMALY);
  });

  it("flags a clear low outlier", () => {
    const s = computeMetricStats(tight, 20);
    expect(s.isAnomaly).toBe(true);
    expect(s.direction).toBe("low");
    expect(s.percentile).toBe(0); // below every baseline value
  });

  it("treats an in-range value as normal", () => {
    const s = computeMetricStats(tight, 101);
    expect(s.isAnomaly).toBe(false);
    expect(s.direction).toBe("normal");
  });

  it("computes a non-parametric percentile rank", () => {
    const s = computeMetricStats([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 7);
    expect(s.percentile).toBe(0.7); // 7 of 10 baseline values <= 7
  });

  it("falls back to the median test when the baseline is perfectly flat", () => {
    const flat = [50, 50, 50, 50, 50, 50, 50];

    const moved = computeMetricStats(flat, 60);
    expect(moved.mad).toBe(0);
    expect(moved.modifiedZ).toBeNull();
    expect(moved.zScore).toBeNull();
    expect(moved.isAnomaly).toBe(true); // moved off the flat line
    expect(moved.direction).toBe("high");

    const onLine = computeMetricStats(flat, 50);
    expect(onLine.isAnomaly).toBe(false);
    expect(onLine.direction).toBe("normal");
  });

  it("reports the robust spread (median + MAD) for grounding", () => {
    const s = computeMetricStats(tight, 100);
    expect(s.median).toBe(100);
    expect(s.mad).toBe(1);
    expect(s.n).toBe(tight.length);
  });
});
