import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { startAnalyticsItContext, type AnalyticsItContext } from "./fixture.js";
import { completenessReport } from "../../src/http/completeness.js";

// Verifies the per-day completeness classification (the ops heatmap data source)
// over real Postgres: present / missing / closed / warming_up, the windowing, and
// the older-holes count. Mirrors the guards proven in the missing_business_dates
// check, but asserts the per-day labels the heatmap renders.
describe("completenessReport (real Postgres)", () => {
  let ctx: AnalyticsItContext;
  const M = "M_REPORT";

  beforeAll(async () => {
    ctx = await startAnalyticsItContext();
  });

  afterAll(async () => {
    await ctx?.stop();
  });

  async function seedSpan(opts: { skipOffsets?: number[]; skipDow?: number[] }) {
    await ctx.pool.query("TRUNCATE mart.fact_orders");
    await ctx.pool.query(
      `INSERT INTO mart.fact_orders (merchant_id, order_id, business_date, order_total_cents)
       SELECT $1, $1 || '-' || g || '-' || n, (CURRENT_DATE - g), 1000
       FROM generate_series(1, 60) g
       CROSS JOIN generate_series(1, 3) n
       WHERE g <> ALL($2::int[])
         AND extract(dow FROM (CURRENT_DATE - g))::int <> ALL($3::int[])`,
      [M, opts.skipOffsets ?? [], opts.skipDow ?? []]
    );
    await ctx.pool.query("REFRESH MATERIALIZED VIEW mart.sales_daily_mv");
  }

  async function statusByOffset(report: Awaited<ReturnType<typeof completenessReport>>) {
    const { rows } = await ctx.pool.query<{ d: string }>(
      "SELECT to_char(CURRENT_DATE, 'YYYY-MM-DD') AS d"
    );
    const today = rows[0]!.d;
    const map = new Map(report.days.map((day) => [day.business_date, day.status]));
    return (offset: number) => {
      const date = new Date(`${today}T00:00:00.000Z`);
      date.setUTCDate(date.getUTCDate() - offset);
      return map.get(date.toISOString().slice(0, 10));
    };
  }

  async function range(daysBack: number) {
    const { rows } = await ctx.pool.query<{ from: string; to: string }>(
      "SELECT to_char(CURRENT_DATE - $1::int, 'YYYY-MM-DD') AS from, to_char(CURRENT_DATE, 'YYYY-MM-DD') AS to",
      [daysBack]
    );
    return rows[0]!;
  }

  it("labels present, missing, and warming_up days within the window", async () => {
    await seedSpan({ skipOffsets: [5, 50] }); // hole past warm-up (5) and inside warm-up (50)
    const { from, to } = await range(58);
    const report = await completenessReport(ctx.pool, M, from, to);
    const at = await statusByOffset(report);

    expect(at(3)).toBe("present");
    expect(at(5)).toBe("missing"); // interior, past warm-up, open weekday
    expect(at(50)).toBe("warming_up"); // within 28 days of the store's start
    expect(report.summary.present).toBeGreaterThan(0);
    expect(report.summary.missing).toBe(1);
  });

  it("labels a never-open weekday as closed, never missing", async () => {
    await seedSpan({ skipDow: [0] }); // store never open on Sundays
    const { from, to } = await range(58);
    const report = await completenessReport(ctx.pool, M, from, to);
    // The rule is about LOADED past Sundays → `closed`. A Sunday is only classified `closed` when
    // it is at/before the store's last loaded day (completeness.ts: a later date is `not_loaded`).
    // Which Sundays are "trailing" (after the last loaded day) shifts with the weekday CI runs on:
    // on a Monday run the immediately-prior Sunday sits after Saturday's last-loaded date, so it is
    // legitimately `not_loaded`, not `closed`. Excluding `not_loaded` Sundays (rather than only
    // `to`) keeps the assertion date-independent — and since the seed never loads offset 0, today
    // is itself `not_loaded`, so this also drops the window end.
    const sundays = report.days.filter(
      (d) => d.status !== "not_loaded" && new Date(`${d.business_date}T00:00:00Z`).getUTCDay() === 0,
    );

    expect(sundays.length).toBeGreaterThan(0);
    expect(sundays.every((d) => d.status === "closed")).toBe(true);
    expect(report.summary.missing ?? 0).toBe(0);
  });

  it("counts holes older than the window in olderMissing, and labels today not_loaded", async () => {
    // offset 25 is past warm-up (start = CURRENT_DATE-60, warm-up ends -32) but
    // older than a 20-day window, so it must surface via olderMissing, not rows.
    await seedSpan({ skipOffsets: [5, 25] });
    const { from } = await range(20);
    const today = (await range(0)).to;
    const report = await completenessReport(ctx.pool, M, from, today);
    const at = await statusByOffset(report);

    expect(at(5)).toBe("missing"); // inside the window
    expect(at(0)).toBe("not_loaded"); // today is beyond the last loaded day
    expect(report.days.some((d) => d.business_date === at25Date(today))).toBe(false);
    expect(report.olderMissing).toBe(1); // offset-25 hole counted but not in the windowed rows
  });

  function at25Date(today: string) {
    const date = new Date(`${today}T00:00:00.000Z`);
    date.setUTCDate(date.getUTCDate() - 25);
    return date.toISOString().slice(0, 10);
  }
});
