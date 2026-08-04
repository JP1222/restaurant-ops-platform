import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { parseTrendsFilters, serializeTrendsFilters } from "@/lib/trends/url-state";
import type { TrendsFilters } from "@/lib/trends/url-state";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-05-10T15:00:00.000Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("trends URL state", () => {
  test("defaults to last 30 days, net sales, and day grain", () => {
    expect(parseTrendsFilters(new URLSearchParams())).toEqual({
      from: "2026-04-11",
      to: "2026-05-10",
      metric: "net_sales",
      grain: "day",
    });
  });

  test("parses valid params", () => {
    const params = new URLSearchParams({
      from: "2026-04-01",
      to: "2026-04-30",
      metric: "avg_ticket",
      grain: "week",
    });

    expect(parseTrendsFilters(params)).toEqual({
      from: "2026-04-01",
      to: "2026-04-30",
      metric: "avg_ticket",
      grain: "week",
    });
  });

  test("falls back when metric or dates are invalid", () => {
    const params = new URLSearchParams({
      from: "2026-02-31",
      to: "2026-04-30",
      metric: "bad",
      grain: "day",
    });

    expect(parseTrendsFilters(params)).toEqual({
      from: "2026-04-11",
      to: "2026-04-30",
      metric: "net_sales",
      grain: "day",
    });
  });

  test("round trips through serialize and parse", () => {
    const filters: TrendsFilters = {
      from: "2026-04-01",
      to: "2026-04-30",
      metric: "refund_rate",
      grain: "week",
    };

    expect(parseTrendsFilters(serializeTrendsFilters(filters))).toEqual(filters);
  });
});
