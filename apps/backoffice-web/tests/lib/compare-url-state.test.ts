import { DateTime } from "luxon";
import { describe, expect, test } from "vitest";
import {
  COMPARE_PRESETS,
  defaultCompareFilters,
  parseCompareFilters,
  serializeCompareFilters,
} from "@/lib/compare/url-state";

const NOW = DateTime.fromISO("2026-05-10T10:00:00", { zone: "America/Chicago" });

describe("compare url state", () => {
  test("defaultCompareFilters returns this week vs last week", () => {
    expect(defaultCompareFilters(NOW)).toEqual({
      primary_from: "2026-05-04",
      primary_to: "2026-05-10",
      compare_from: "2026-04-27",
      compare_to: "2026-05-03",
      metric: "net_sales",
      grain: "day",
    });
  });

  test("parseCompareFilters returns defaults for empty search params", () => {
    const parsed = parseCompareFilters(new URLSearchParams());

    expect(parsed.metric).toBe("net_sales");
    expect(parsed.grain).toBe("day");
    expect(parsed.primary_from).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(parsed.compare_from).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test("parseCompareFilters honors valid params and rejects invalid ones", () => {
    const parsed = parseCompareFilters(
      new URLSearchParams({
        primary_from: "2026-04-01",
        primary_to: "2026-04-30",
        compare_from: "not-a-date",
        compare_to: "2026-03-31",
        metric: "orders",
        grain: "week",
      }),
    );

    expect(parsed.primary_from).toBe("2026-04-01");
    expect(parsed.primary_to).toBe("2026-04-30");
    expect(parsed.compare_from).not.toBe("not-a-date");
    expect(parsed.compare_from <= parsed.compare_to).toBe(true);
    expect(parsed.metric).toBe("orders");
    expect(parsed.grain).toBe("week");
  });

  test("reversed ranges fall back to valid defaults", () => {
    const parsed = parseCompareFilters(
      new URLSearchParams({
        primary_from: "2026-05-10",
        primary_to: "2026-05-01",
        compare_from: "2026-04-20",
        compare_to: "2026-04-01",
      }),
    );

    expect(parsed.primary_from <= parsed.primary_to).toBe(true);
    expect(parsed.compare_from <= parsed.compare_to).toBe(true);
  });

  test("presets produce contiguous week-over-week and previous calendar month ranges", () => {
    const wow = COMPARE_PRESETS.find((preset) => preset.id === "wow")!.apply(NOW);
    const mom = COMPARE_PRESETS.find((preset) => preset.id === "mom")!.apply(NOW);

    expect(wow).toEqual({
      primary_from: "2026-05-04",
      primary_to: "2026-05-10",
      compare_from: "2026-04-27",
      compare_to: "2026-05-03",
    });
    expect(mom).toEqual({
      primary_from: "2026-05-01",
      primary_to: "2026-05-10",
      compare_from: "2026-04-01",
      compare_to: "2026-04-30",
    });
  });

  test("serializeCompareFilters round trips all six params", () => {
    const query = serializeCompareFilters({
      primary_from: "2026-04-01",
      primary_to: "2026-04-30",
      compare_from: "2026-03-01",
      compare_to: "2026-03-31",
      metric: "avg_ticket",
      grain: "week",
    });

    expect(query.toString()).toContain("primary_from=2026-04-01");
    expect(parseCompareFilters(query)).toMatchObject({
      primary_from: "2026-04-01",
      primary_to: "2026-04-30",
      compare_from: "2026-03-01",
      compare_to: "2026-03-31",
      metric: "avg_ticket",
      grain: "week",
    });
  });
});
