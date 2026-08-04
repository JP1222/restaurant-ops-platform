import { describe, expect, it } from "vitest";
import type { AppConfig } from "../src/config.js";
import { isForecastRefreshHour } from "../src/scheduler/scheduler.js";
import { JobTypeSchema, jobPriority, validateJobPayload } from "../src/scheduler/job-types.js";

// The daily forecast recompute (ADR-0032) is gated by isForecastRefreshHour so it
// fires once per UTC day at/after the configured hour; the date-keyed dedupe in the
// scheduler turns that into a one-shot. These are the pure pieces of that wiring.
describe("forecast_refresh scheduling", () => {
  const config = { forecastRefreshHourUtc: 16 } as unknown as AppConfig;

  it("does not fire before the configured UTC hour", () => {
    expect(isForecastRefreshHour(new Date("2026-06-15T15:59:00.000Z"), config)).toBe(false);
    expect(isForecastRefreshHour(new Date("2026-06-15T00:00:00.000Z"), config)).toBe(false);
  });

  it("fires at and after the configured UTC hour", () => {
    expect(isForecastRefreshHour(new Date("2026-06-15T16:00:00.000Z"), config)).toBe(true);
    expect(isForecastRefreshHour(new Date("2026-06-15T23:30:00.000Z"), config)).toBe(true);
  });

  it("registers forecast_refresh as a known job type with a payload schema", () => {
    expect(JobTypeSchema.options).toContain("forecast_refresh");
    expect(validateJobPayload("forecast_refresh", { reason: "scheduled_daily" })).toEqual({
      reason: "scheduled_daily"
    });
    expect(validateJobPayload("forecast_refresh", {})).toEqual({});
  });

  it("prioritizes forecast_refresh as low-urgency background work", () => {
    // Below realtime/sweep/export work, alongside the other daily background jobs.
    expect(jobPriority("forecast_refresh")).toBeGreaterThan(jobPriority("export_reconcile"));
    expect(jobPriority("forecast_refresh")).toBeLessThan(jobPriority("historical_export_backfill"));
  });
});
