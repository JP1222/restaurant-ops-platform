import { describe, expect, it } from "vitest";

import {
  assembleTrust,
  buildCaveat,
  classifyDay,
  isoMinusDays,
  summarizeOverall,
} from "../src/analytics/data-trust.js";

describe("isoMinusDays", () => {
  it("subtracts calendar days across a month boundary", () => {
    expect(isoMinusDays("2026-06-02", 3)).toBe("2026-05-30");
    expect(isoMinusDays("2026-06-15", 0)).toBe("2026-06-15");
  });
});

describe("classifyDay", () => {
  const latest = "2026-06-15";

  it("trusts an explicit reconcile verdict", () => {
    expect(classifyDay("2026-06-10", latest, "passed")).toBe("reconciled");
    expect(classifyDay("2026-06-10", latest, "failed")).toBe("failed");
  });

  it("treats a MISSING row as pending only for the latest day and the day before", () => {
    expect(classifyDay(latest, latest, undefined)).toBe("pending");
    expect(classifyDay("2026-06-14", latest, undefined)).toBe("pending");
  });

  it("treats an older missing row as unverified (no_data), never falsely settling", () => {
    expect(classifyDay("2026-06-13", latest, undefined)).toBe("no_data");
    expect(classifyDay("2026-05-01", latest, undefined)).toBe("no_data");
  });
});

describe("summarizeOverall", () => {
  it("is degraded on a failed reconcile day or a critical DQ failure", () => {
    expect(summarizeOverall(1, 0, 0)).toBe("degraded");
    expect(summarizeOverall(0, 1, 0)).toBe("degraded");
    expect(summarizeOverall(2, 0, 3)).toBe("degraded");
  });

  it("is caution on a warning-level DQ failure only", () => {
    expect(summarizeOverall(0, 0, 1)).toBe("caution");
  });

  it("is ok when nothing is unresolved", () => {
    expect(summarizeOverall(0, 0, 0)).toBe("ok");
  });
});

describe("buildCaveat", () => {
  it("warns hard on a failed day", () => {
    const c = buildCaveat({ business_date: "2026-06-12", status: "failed" });
    expect(c).toMatch(/FAILED/);
    expect(c).toMatch(/2026-06-12/);
  });

  it("gives a soft settling note on a pending day", () => {
    const c = buildCaveat({ business_date: "2026-06-15", status: "pending" });
    expect(c).toMatch(/settling/i);
  });

  it("notes unverified data on a no_data day", () => {
    expect(buildCaveat({ business_date: "2026-05-01", status: "no_data" })).toMatch(/unverified/i);
  });

  it("is null when the day reconciled cleanly", () => {
    expect(buildCaveat({ business_date: "2026-06-10", status: "reconciled" })).toBeNull();
  });
});

describe("assembleTrust", () => {
  const base = {
    latestDay: "2026-06-15",
    asOf: "2026-06-15",
    lookbackDays: 7,
    freshness: { last_hourly_sweep_at: null, last_export_reconcile_at: null },
  };

  it("builds a newest-first window whose head is as_of", () => {
    const result = assembleTrust({
      ...base,
      reconStatusByDate: new Map(),
      unresolvedBreakDaysAsc: [],
      dqChecks: [],
    });
    expect(result.recent_days).toHaveLength(7);
    expect(result.recent_days[0]!.business_date).toBe("2026-06-15");
    expect(result.recent_days[6]!.business_date).toBe("2026-06-09");
    expect(result.asked_day).toEqual(result.recent_days[0]);
  });

  it("keeps a clean, settling latest day trustworthy (ok overall, soft caveat)", () => {
    const result = assembleTrust({
      ...base,
      reconStatusByDate: new Map(),
      unresolvedBreakDaysAsc: [],
      dqChecks: [],
    });
    expect(result.asked_day.status).toBe("pending");
    expect(result.overall).toBe("ok");
    expect(result.sufficient).toBe(true);
    expect(result.caveat).toMatch(/settling/i);
  });

  it("flags an asked day whose own reconcile failed (not sufficient, degraded)", () => {
    const result = assembleTrust({
      ...base,
      asOf: "2026-06-12",
      reconStatusByDate: new Map([["2026-06-12", "failed"]]),
      unresolvedBreakDaysAsc: ["2026-06-12"],
      dqChecks: [],
    });
    expect(result.asked_day.status).toBe("failed");
    expect(result.sufficient).toBe(false);
    expect(result.caveat).toMatch(/FAILED/);
    expect(result.overall).toBe("degraded");
    expect(result.reconciliation).toEqual({
      unresolved_break_days: 1,
      oldest_unresolved_break_day: "2026-06-12",
    });
  });

  it("rolls up data-quality severities and reports the oldest break", () => {
    const result = assembleTrust({
      ...base,
      reconStatusByDate: new Map([["2026-06-13", "passed"]]),
      unresolvedBreakDaysAsc: ["2026-06-10", "2026-06-11"],
      dqChecks: [
        { check_name: "missing_business_dates", severity: "critical", created_at: null },
        { check_name: "daily_order_count_drop", severity: "warning", created_at: null },
      ],
    });
    expect(result.data_quality.unresolved_failures).toBe(2);
    expect(result.data_quality.critical_failures).toBe(1);
    expect(result.reconciliation.oldest_unresolved_break_day).toBe("2026-06-10");
    expect(result.overall).toBe("degraded");
  });
});
