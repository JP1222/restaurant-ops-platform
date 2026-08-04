import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { startAnalyticsItContext, type AnalyticsItContext } from "./fixture.js";
import { completenessReport } from "../../src/http/completeness.js";
import { runDataQualityChecks } from "../../src/quality/checks.js";

// Proves the cross-stream de-escalation: a MISSING open day stops reading as data
// loss once the external Clover recon confirms it was a real closure (Clover also
// had zero), but a day Clover HAS data for keeps being flagged. This is what turns
// the completeness check's holiday noise into a verdict instead of an alarm.
describe("missing-day Clover adjudication (real Postgres)", () => {
  let ctx: AnalyticsItContext;
  const M = "M_ADJ";
  const GAP = 5; // offset past the warm-up of a 40-day span (start-32)

  beforeAll(async () => {
    ctx = await startAnalyticsItContext();
    await ctx.pool.query(
      `INSERT INTO config.sync_targets (merchant_id, token) VALUES ($1, 'tok')
       ON CONFLICT (merchant_id) DO NOTHING`,
      [M]
    );
  });

  afterAll(async () => {
    await ctx?.stop();
  });

  beforeEach(async () => {
    await ctx.pool.query("TRUNCATE mart.fact_orders");
    await ctx.pool.query("DELETE FROM audit.recon_daily WHERE merchant_id = $1", [M]);
    await ctx.pool.query(
      "DELETE FROM audit.data_quality_checks WHERE merchant_id = $1 AND check_name = 'missing_business_dates'",
      [M]
    );
    await ctx.pool.query(
      `INSERT INTO mart.fact_orders (merchant_id, order_id, business_date, order_total_cents)
       SELECT $1, $1 || '-' || g || '-' || n, (CURRENT_DATE - g), 1000
       FROM generate_series(1, 40) g
       CROSS JOIN generate_series(1, 3) n
       WHERE g <> $2`,
      [M, GAP]
    );
    await ctx.pool.query("REFRESH MATERIALIZED VIEW mart.sales_daily_mv");
  });

  async function reconVerdict(offset: number, status: string, controlTxn: number) {
    await ctx.pool.query(
      `INSERT INTO audit.recon_daily (
         merchant_id, business_date, control_gross_cents, control_txn_count,
         mart_gross_cents, mart_txn_count, delta_gross_cents, delta_txn_count,
         tolerance_cents, status
       ) VALUES ($1, (CURRENT_DATE - $2::int), 0, $3, 0, 0, 0, $3, 50, $4)`,
      [M, offset, controlTxn, status]
    );
  }

  async function missingCount(): Promise<number> {
    await runDataQualityChecks(ctx.pool, M);
    const { rows } = await ctx.pool.query<{ details: { count: number } }>(
      `SELECT details FROM audit.data_quality_checks
       WHERE merchant_id = $1 AND check_name = 'missing_business_dates'
       ORDER BY last_seen_at DESC LIMIT 1`,
      [M]
    );
    return rows[0] ? rows[0].details.count : 0; // no row = passed = 0
  }

  async function gapStatus(): Promise<string | undefined> {
    const { rows } = await ctx.pool.query<{ d: string }>(
      "SELECT to_char(CURRENT_DATE - $1::int, 'YYYY-MM-DD') AS d",
      [GAP]
    );
    const target = rows[0]!.d;
    const from = (
      await ctx.pool.query<{ d: string }>("SELECT to_char(CURRENT_DATE - 38, 'YYYY-MM-DD') AS d")
    ).rows[0]!.d;
    const to = (await ctx.pool.query<{ d: string }>("SELECT to_char(CURRENT_DATE, 'YYYY-MM-DD') AS d"))
      .rows[0]!.d;
    const report = await completenessReport(ctx.pool, M, from, to);
    return report.days.find((day) => day.business_date === target)?.status;
  }

  it("flags the gap as missing while no external verdict exists", async () => {
    expect(await missingCount()).toBe(1);
    expect(await gapStatus()).toBe("missing");
  });

  it("de-escalates once Clover confirms the closure (control_txn_count = 0)", async () => {
    await reconVerdict(GAP, "ok", 0);
    expect(await missingCount()).toBe(0);
    expect(await gapStatus()).toBe("closed");
  });

  it("keeps flagging a day Clover HAS data for (a real loss, recon fail)", async () => {
    await reconVerdict(GAP, "fail", 5);
    expect(await missingCount()).toBe(1);
    expect(await gapStatus()).toBe("missing");
  });

  // The confirm-closed guard is status='ok' AND control_txn_count=0; both halves
  // are load-bearing. Neither alone may de-escalate, or a future edit could relax
  // it into masking a real loss.
  it("does NOT de-escalate on recon ok with a nonzero control_txn_count", async () => {
    await reconVerdict(GAP, "ok", 5);
    expect(await missingCount()).toBe(1);
    expect(await gapStatus()).toBe("missing");
  });

  it("does NOT de-escalate on source_unavailable (cannot confirm closure)", async () => {
    await reconVerdict(GAP, "source_unavailable", 0);
    expect(await missingCount()).toBe(1);
    expect(await gapStatus()).toBe("missing");
  });
});
