import { describe, expect, it } from "vitest";

import {
  buildDimension,
  sameWeekdayBaselineDates,
  summarizeHeadline,
} from "../src/analytics/metric-drivers.js";

describe("sameWeekdayBaselineDates", () => {
  it("returns the same weekday across the trailing 4 weeks, newest first", () => {
    // 2026-06-21 is a Sunday; the four prior Sundays:
    expect(sameWeekdayBaselineDates("2026-06-21")).toEqual([
      "2026-06-14",
      "2026-06-07",
      "2026-05-31",
      "2026-05-24",
    ]);
  });

  it("crosses month and year boundaries cleanly", () => {
    expect(sameWeekdayBaselineDates("2026-01-10")).toEqual([
      "2026-01-03",
      "2025-12-27",
      "2025-12-20",
      "2025-12-13",
    ]);
  });
});

describe("buildDimension", () => {
  // baseline_cents is the per-day average: baseline_sum / dayCount.
  const rows = [
    { key: "A", current_cents: "5000", baseline_sum_cents: "16000" }, // baseline 4000, delta +1000
    { key: "B", current_cents: "2000", baseline_sum_cents: "12000" }, // baseline 3000, delta -1000
    { key: "C", current_cents: "1000", baseline_sum_cents: "12000" }, // baseline 3000, delta -2000
  ];

  it("averages the baseline over dayCount and ranks members by absolute delta", () => {
    const dim = buildDimension("daypart", "net_sales", rows, 4, 5);

    expect(dim.current_cents).toBe(8000);
    expect(dim.baseline_cents).toBe(10000);
    expect(dim.delta_cents).toBe(-2000);

    // Ranked by |delta|: C(-2000) then A(+1000) then B(-1000) (stable tie order).
    expect(dim.drivers.map((d) => d.key)).toEqual(["C", "A", "B"]);
    expect(dim.drivers[0]).toMatchObject({
      key: "C",
      current_cents: 1000,
      baseline_cents: 3000,
      delta_cents: -2000,
    });
  });

  it("expresses each member's share as a signed fraction of the dimension delta", () => {
    const dim = buildDimension("daypart", "net_sales", rows, 4, 5);
    const byKey = Object.fromEntries(dim.drivers.map((d) => [d.key, d.share_of_delta]));

    expect(byKey.C).toBeCloseTo(1.0, 6); // -2000 / -2000
    expect(byKey.A).toBeCloseTo(-0.5, 6); // +1000 / -2000 — A moved OPPOSITE the drop (offsetting)
    expect(byKey.B).toBeCloseTo(0.5, 6); // -1000 / -2000
  });

  it("surfaces a lost contributor (present in baseline, gone today) as a large negative delta", () => {
    const lost = [{ key: "Gone", current_cents: "0", baseline_sum_cents: "8000" }];
    const dim = buildDimension("item", "gross_sales", lost, 4, 5);

    expect(dim.drivers[0]).toMatchObject({
      key: "Gone",
      current_cents: 0,
      baseline_cents: 2000,
      delta_cents: -2000,
    });
  });

  it("truncates to the top N by impact", () => {
    const many = [
      { key: "a", current_cents: "100", baseline_sum_cents: "0" }, // +100
      { key: "b", current_cents: "900", baseline_sum_cents: "0" }, // +900
      { key: "c", current_cents: "500", baseline_sum_cents: "0" }, // +500
      { key: "d", current_cents: "300", baseline_sum_cents: "0" }, // +300
    ];
    const dim = buildDimension("order_type", "net_sales", many, 1, 2);
    expect(dim.drivers.map((d) => d.key)).toEqual(["b", "c"]);
  });

  it("returns null baselines/deltas/shares when there is no baseline history", () => {
    const dim = buildDimension("tender", "payment", rows, 0, 5);
    expect(dim.baseline_cents).toBeNull();
    expect(dim.delta_cents).toBeNull();
    for (const d of dim.drivers) {
      expect(d.baseline_cents).toBeNull();
      expect(d.delta_cents).toBeNull();
      expect(d.share_of_delta).toBeNull();
    }
    // current is still summed even without a baseline.
    expect(dim.current_cents).toBe(8000);
  });

  it("nulls the share when the dimension delta is ~0 (avoids divide-by-zero)", () => {
    const flat = [
      { key: "x", current_cents: "1000", baseline_sum_cents: "4000" }, // baseline 1000, delta 0
      { key: "y", current_cents: "2000", baseline_sum_cents: "8000" }, // baseline 2000, delta 0
    ];
    const dim = buildDimension("daypart", "net_sales", flat, 4, 5);
    expect(dim.delta_cents).toBe(0);
    for (const d of dim.drivers) expect(d.share_of_delta).toBeNull();
  });
});

describe("summarizeHeadline", () => {
  it("computes the per-day baseline, delta, and delta percent", () => {
    expect(summarizeHeadline(8000, 40000, 4)).toEqual({
      current_cents: 8000,
      baseline_cents: 10000,
      delta_cents: -2000,
      delta_pct: -0.2,
    });
  });

  it("nulls baseline/delta when there is no same-weekday history", () => {
    expect(summarizeHeadline(8000, 0, 0)).toEqual({
      current_cents: 8000,
      baseline_cents: null,
      delta_cents: null,
      delta_pct: null,
    });
  });

  it("guards the percent against a zero baseline", () => {
    const out = summarizeHeadline(5000, 0, 4);
    expect(out.baseline_cents).toBe(0);
    expect(out.delta_cents).toBe(5000);
    expect(out.delta_pct).toBeNull();
  });
});
