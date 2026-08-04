import { beforeEach, describe, expect, it, vi } from "vitest";
import { DateTime } from "luxon";

// Vitest hoists vi.mock; the factory may only close over `mock`-prefixed vars.
const mockClientQuery = vi.fn();

vi.mock("../src/db.js", () => ({
  withTransaction: async (
    _pool: unknown,
    cb: (client: { query: typeof mockClientQuery }) => Promise<unknown>,
  ) => cb({ query: mockClientQuery }),
}));

import { runForecast } from "../src/forecast/run.js";

function historyRows(weeks: number) {
  const start = DateTime.fromISO("2026-01-05", { zone: "utc" }); // Monday
  const rows: { business_date: string; net_sales_cents: string; order_count: string }[] = [];
  for (let i = 0; i < weeks * 7; i += 1) {
    const d = start.plus({ days: i });
    rows.push({
      business_date: d.toISODate()!,
      net_sales_cents: String(1000 + d.weekday * 100),
      order_count: String(d.weekday),
    });
  }
  return rows;
}

beforeEach(() => {
  mockClientQuery.mockReset();
  mockClientQuery.mockResolvedValue({ rows: [] });
});

describe("runForecast", () => {
  it("reads history, writes a forecast row per metric per day, and upserts backtest", async () => {
    const poolQuery = vi.fn().mockResolvedValueOnce({ rows: historyRows(8) });
    const pool = { query: poolQuery } as unknown as Parameters<typeof runForecast>[0];

    const result = await runForecast(pool, "M1", { horizonDays: 7, holdoutDays: 7, lookbackDays: 180 });

    expect(result.merchantId).toBe("M1");
    expect(result.horizonDays).toBe(7);
    expect(result.written).toBe(14); // 7 days × 2 metrics
    expect(result.backtest.map((b) => b.metric).sort()).toEqual(["net_sales_cents", "order_count"]);

    const sqls = mockClientQuery.mock.calls.map((call) => String(call[0]));
    expect(sqls.filter((s) => s.includes("DELETE FROM mart.forecast_daily")).length).toBe(1);
    expect(sqls.filter((s) => s.includes("INSERT INTO mart.forecast_daily")).length).toBe(14);
    expect(sqls.filter((s) => s.includes("mart.forecast_backtest")).length).toBe(2);
    // the wholesale delete precedes the inserts
    const deleteIdx = sqls.findIndex((s) => s.includes("DELETE FROM mart.forecast_daily"));
    const firstInsertIdx = sqls.findIndex((s) => s.includes("INSERT INTO mart.forecast_daily"));
    expect(deleteIdx).toBeLessThan(firstInsertIdx);
  });

  it("writes no forecast rows and reports an empty backtest when there is no history", async () => {
    const poolQuery = vi.fn().mockResolvedValueOnce({ rows: [] });
    const pool = { query: poolQuery } as unknown as Parameters<typeof runForecast>[0];

    const result = await runForecast(pool, "M1", { horizonDays: 7, holdoutDays: 7 });
    expect(result.written).toBe(0);
    expect(result.backtest.every((b) => b.n === 0)).toBe(true);

    const sqls = mockClientQuery.mock.calls.map((call) => String(call[0]));
    expect(sqls.filter((s) => s.includes("INSERT INTO mart.forecast_daily")).length).toBe(0);
  });
});
