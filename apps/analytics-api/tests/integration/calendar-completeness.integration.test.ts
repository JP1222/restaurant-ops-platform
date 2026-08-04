import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { startAnalyticsItContext, type AnalyticsItContext } from "./fixture.js";
import { runDataQualityChecks } from "../../src/quality/checks.js";

// Proves the calendar-completeness check (missing_business_dates) over real
// Postgres: it flags an interior OPEN day with zero activity inside the store's
// data span, and is silenced by each of the three closed-day guards (warm-up,
// the operating_days mask, and the never-open-weekday auto-guard). Dates are
// CURRENT_DATE-relative so the 28-day warm-up math is exercised. fact_orders has
// a DEFAULT partition, so any business_date inserts without partition setup.
describe("calendar completeness — missing_business_dates (real Postgres)", () => {
  let ctx: AnalyticsItContext;
  const M = "M_COMPLETE";

  beforeAll(async () => {
    ctx = await startAnalyticsItContext();
  });

  afterAll(async () => {
    await ctx?.stop();
  });

  // Seed a 40-day span (CURRENT_DATE-40 .. CURRENT_DATE-1), 3 orders/day, with
  // chosen day-offsets and/or whole weekdays removed. Optionally seed a
  // sync_targets row (open_date / operating_days). Then refresh the daily MV the
  // check reads.
  async function seedSpan(opts: {
    skipOffsets?: number[];
    skipDow?: number[];
    openDate?: string | null;
    operatingDays?: number | null;
  }) {
    await ctx.pool.query("TRUNCATE mart.fact_orders");
    await ctx.pool.query("DELETE FROM config.sync_targets WHERE merchant_id = $1", [M]);
    // Isolate scenarios: recordCheckResult only persists failures + resolutions,
    // so clear any prior verdict so "no row" unambiguously means this run passed.
    await ctx.pool.query(
      "DELETE FROM audit.data_quality_checks WHERE merchant_id = $1 AND check_name = 'missing_business_dates'",
      [M],
    );
    // Clear any external-recon verdicts so the confirm-closed de-escalation tests
    // don't leak a row into a later scenario.
    await ctx.pool.query("DELETE FROM audit.recon_daily WHERE merchant_id = $1", [M]);
    await ctx.pool.query(
      `INSERT INTO mart.fact_orders (merchant_id, order_id, business_date, order_total_cents)
       SELECT $1, $1 || '-' || g || '-' || n, (CURRENT_DATE - g), 1000
       FROM generate_series(1, 40) g
       CROSS JOIN generate_series(1, 3) n
       WHERE g <> ALL($2::int[])
         AND extract(dow FROM (CURRENT_DATE - g))::int <> ALL($3::int[])`,
      [M, opts.skipOffsets ?? [], opts.skipDow ?? []],
    );
    if (opts.openDate !== undefined || opts.operatingDays !== undefined) {
      await ctx.pool.query(
        `INSERT INTO config.sync_targets (merchant_id, token, open_date, operating_days)
         VALUES ($1, 'tok', $2::date, COALESCE($3::smallint, 127))`,
        [M, opts.openDate ?? null, opts.operatingDays ?? null],
      );
    }
    await ctx.pool.query("REFRESH MATERIALIZED VIEW mart.sales_daily_mv");
  }

  async function missingCheck() {
    await runDataQualityChecks(ctx.pool, M);
    const { rows } = await ctx.pool.query<{
      status: string;
      severity: string;
      details: { count: number; sample_dates: string[] };
    }>(
      `SELECT status, severity, details
       FROM audit.data_quality_checks
       WHERE merchant_id = $1 AND check_name = 'missing_business_dates'
       ORDER BY last_seen_at DESC
       LIMIT 1`,
      [M],
    );
    const row = rows[0];
    // No row = the check never failed this run = complete (passes don't insert).
    if (!row) {
      return { status: "passed", severity: "info", count: 0, dates: [] as string[] };
    }
    return {
      status: row.status,
      severity: row.severity,
      count: row.details.count,
      dates: row.details.sample_dates,
    };
  }

  async function dateString(offset: number) {
    const { rows } = await ctx.pool.query<{ d: string }>(
      "SELECT to_char(CURRENT_DATE - $1::int, 'YYYY-MM-DD') AS d",
      [offset],
    );
    return rows[0]!.d;
  }

  // Seed an external-recon verdict for CURRENT_DATE - `offset`. The cross-stream
  // de-escalation only trusts status='ok' AND control_txn_count=0 (Clover also had
  // zero — a real closure); reconstructed_at defaults to now().
  async function insertReconVerdict(offset: number, status: string, controlTxnCount = 0) {
    await ctx.pool.query(
      `INSERT INTO audit.recon_daily (
         merchant_id, business_date, control_gross_cents, control_txn_count,
         mart_gross_cents, mart_txn_count, delta_gross_cents, delta_txn_count,
         tolerance_cents, status
       )
       VALUES ($1, CURRENT_DATE - $2::int, 0, $3, 0, 0, 0, 0, 50, $4)
       ON CONFLICT (merchant_id, business_date) DO UPDATE SET
         status = EXCLUDED.status, control_txn_count = EXCLUDED.control_txn_count`,
      [M, offset, controlTxnCount, status],
    );
  }

  it("passes when every open day in the span is present", async () => {
    await seedSpan({});
    const row = await missingCheck();
    expect(row.status).toBe("passed");
    expect(row.count).toBe(0);
  });

  it("flags an interior open-day gap past the warm-up window", async () => {
    await seedSpan({ skipOffsets: [5] });
    const row = await missingCheck();
    expect(row.status).toBe("failed");
    expect(row.severity).toBe("critical");
    expect(row.count).toBe(1);
    expect(row.dates).toContain(await dateString(5));
  });

  it("suppresses a gap inside the 28-day warm-up window", async () => {
    // Span starts at CURRENT_DATE-40, so warm-up covers everything older than
    // CURRENT_DATE-12. A hole at CURRENT_DATE-35 is within warm-up.
    await seedSpan({ skipOffsets: [35] });
    const row = await missingCheck();
    expect(row.status).toBe("passed");
    expect(row.count).toBe(0);
  });

  it("auto-treats a never-open weekday as closed (no manual mask)", async () => {
    // Remove every Sunday (dow 0). Those calendar days are absent but Sunday has
    // never produced an order, so the guard treats them closed, not missing.
    await seedSpan({ skipDow: [0] });
    const row = await missingCheck();
    expect(row.status).toBe("passed");
    expect(row.count).toBe(0);
  });

  it("honours an explicit operating_days mask that closes the gap's weekday", async () => {
    const dow = Number(
      (
        await ctx.pool.query<{ dow: number }>(
          "SELECT extract(dow FROM CURRENT_DATE - 5)::int AS dow",
        )
      ).rows[0]!.dow,
    );
    const maskWithGapDayClosed = 127 - (1 << dow);
    await seedSpan({ skipOffsets: [5], operatingDays: maskWithGapDayClosed });
    const row = await missingCheck();
    expect(row.status).toBe("passed");
    expect(row.count).toBe(0);
  });

  it("de-escalates a gap to closed when external recon confirmed Clover also had zero", async () => {
    await seedSpan({ skipOffsets: [5] });
    await insertReconVerdict(5, "ok"); // ok + zero control = confirmed real closure
    const row = await missingCheck();
    expect(row.status).toBe("passed");
    expect(row.count).toBe(0);
    expect(row.dates).not.toContain(await dateString(5));
  });

  // PR #758 follow-up: an aged-out day is recorded source_unavailable, NOT ok — so it
  // must NOT de-escalate. The critical data-loss alarm has to keep firing rather than
  // be silently dropped by an untrustworthy Clover zero.
  it("keeps a gap flagged missing when recon could only record source_unavailable", async () => {
    await seedSpan({ skipOffsets: [5] });
    await insertReconVerdict(5, "source_unavailable");
    const row = await missingCheck();
    expect(row.status).toBe("failed");
    expect(row.severity).toBe("critical");
    expect(row.count).toBe(1);
    expect(row.dates).toContain(await dateString(5));
  });
});
