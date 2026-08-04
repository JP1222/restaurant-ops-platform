import { DateTime } from "luxon";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { startAnalyticsItContext, type AnalyticsItContext } from "./fixture.js";
import type { AppConfig } from "../../src/config.js";
import type { CloverClient } from "../../src/clover/client.js";
import { runExternalReconJob } from "../../src/jobs/external-recon.js";
import type { JsonRecord } from "../../src/types.js";
import type { SyncJob } from "../../src/scheduler/job-repository.js";

// Drives the full external-recon job over real Postgres with an INJECTED Clover
// client (no network): seed mart.fact_payments + a sync target, hand the job a
// canned /payments response, and assert the recon_daily verdict + the surfaced
// data_quality_checks row. Proves the control-total-vs-mart diff end to end,
// including the export-incompleteness (fail) and outage (source_unavailable) cases.
describe("external recon job (real Postgres, injected Clover)", () => {
  let ctx: AnalyticsItContext;
  const M = "M_RECON";
  const BD = "2026-06-08";
  const config = { storeTimezone: "America/Chicago" } as AppConfig;
  // createdTime within BD in America/Chicago (CDT): noon local = 17:00Z.
  const at = (hourUtc: number) => new Date(`2026-06-08T${String(hourUtc).padStart(2, "0")}:00:00Z`).getTime();

  function fakeClient(payments: JsonRecord[]): CloverClient {
    return { listPaymentsByCreatedTime: async () => payments } as unknown as CloverClient;
  }

  function job(businessDate = BD): SyncJob {
    return { merchantId: M, jobType: "external_recon", payload: { businessDate } } as unknown as SyncJob;
  }

  async function seedMartPayments(rows: Array<{ id: string; cents: number }>) {
    for (const row of rows) {
      await ctx.pool.query(
        `INSERT INTO mart.fact_payments (merchant_id, payment_id, business_date, tender_type, amount_cents)
         VALUES ($1, $2, $3::date, 'CREDIT_CARD', $4)`,
        [M, row.id, BD, row.cents]
      );
    }
  }

  async function reconRow(businessDate = BD) {
    const { rows } = await ctx.pool.query<{
      status: string;
      control_gross_cents: string;
      mart_gross_cents: string;
      delta_txn_count: number;
    }>(
      `SELECT status, control_gross_cents, mart_gross_cents, delta_txn_count
       FROM audit.recon_daily WHERE merchant_id = $1 AND business_date = $2`,
      [M, businessDate]
    );
    return rows[0];
  }

  async function dqRow() {
    const { rows } = await ctx.pool.query<{ status: string; severity: string }>(
      `SELECT status, severity FROM audit.data_quality_checks
       WHERE merchant_id = $1 AND check_name = 'external_recon_break'
       ORDER BY last_seen_at DESC LIMIT 1`,
      [M]
    );
    return rows[0];
  }

  beforeAll(async () => {
    ctx = await startAnalyticsItContext();
    await ctx.pool.query(
      `INSERT INTO config.sync_targets (merchant_id, token, store_timezone)
       VALUES ($1, 'tok', 'America/Chicago')
       ON CONFLICT (merchant_id) DO UPDATE SET store_timezone = EXCLUDED.store_timezone`,
      [M]
    );
  });

  afterAll(async () => {
    await ctx?.stop();
  });

  beforeEach(async () => {
    await ctx.pool.query("TRUNCATE mart.fact_payments");
    await ctx.pool.query("DELETE FROM audit.recon_daily WHERE merchant_id = $1", [M]);
    await ctx.pool.query(
      "DELETE FROM audit.data_quality_checks WHERE merchant_id = $1 AND check_name = 'external_recon_break'",
      [M]
    );
  });

  it("status ok when the reconstructed total matches the mart", async () => {
    await seedMartPayments([{ id: "p1", cents: 799 }, { id: "p2", cents: 1200 }]);
    const result = await runExternalReconJob(ctx.pool, config, fakeClient([
      { id: "p1", result: "SUCCESS", createdTime: at(17), amount: 799 },
      { id: "p2", result: "SUCCESS", createdTime: at(22), amount: 1200 }
    ]), job());

    expect(result.metadata.status).toBe("ok");
    const row = await reconRow();
    expect(row.status).toBe("ok");
    expect(Number(row.control_gross_cents)).toBe(1999);
    expect(Number(row.mart_gross_cents)).toBe(1999);
    // An ok run does not leave an unresolved break (passes don't insert a new row).
    const dq = await dqRow();
    expect(dq === undefined || dq.status === "passed").toBe(true);
  });

  it("status fail (critical DQ) when Clover has a payment the export missed", async () => {
    await seedMartPayments([{ id: "p1", cents: 799 }]); // export dropped p2
    const result = await runExternalReconJob(ctx.pool, config, fakeClient([
      { id: "p1", result: "SUCCESS", createdTime: at(17), amount: 799 },
      { id: "p2", result: "SUCCESS", createdTime: at(22), amount: 1200 }
    ]), job());

    expect(result.metadata.status).toBe("fail");
    const row = await reconRow();
    expect(row.status).toBe("fail");
    expect(row.delta_txn_count).toBe(1); // control has one more than mart
    const dq = await dqRow();
    expect(dq.status).toBe("failed");
    expect(dq.severity).toBe("critical");
  });

  it("status source_unavailable (never agreement) when the mart has payments but the re-fetch is empty", async () => {
    await seedMartPayments([{ id: "p1", cents: 799 }, { id: "p2", cents: 1200 }]);
    const result = await runExternalReconJob(ctx.pool, config, fakeClient([]), job());

    expect(result.metadata.status).toBe("source_unavailable");
    expect((await reconRow()).status).toBe("source_unavailable");
    expect((await dqRow()).status).toBe("failed");
  });

  // PR #758 follow-up: the aging-out guard. A mart-0 day the re-fetch also reports as
  // 0 normally lands 'ok' (confirmed closure) — but only if the day is still within
  // the source's retention horizon. Past it, a zero re-fetch can't be trusted, so the
  // verdict must be source_unavailable so completeness keeps flagging the day rather
  // than silently de-escalating a possible data loss to a closure.
  const TZ = "America/Chicago";
  const today = DateTime.now().setZone(TZ);
  const agedConfig = { storeTimezone: TZ, cloverPaymentsRetentionDays: 365 } as AppConfig;

  it("status source_unavailable for a mart-0 + Clover-0 day OLDER than the retention horizon (cannot confirm closure)", async () => {
    const agedBd = today.minus({ days: 800 }).toISODate()!; // > 365-day horizon
    // No mart payments seeded for the day (mart-0); empty re-fetch (Clover-0).
    const result = await runExternalReconJob(ctx.pool, agedConfig, fakeClient([]), job(agedBd));

    expect(result.metadata.status).toBe("source_unavailable");
    expect((await reconRow(agedBd)).status).toBe("source_unavailable");
  });

  it("status ok (confirmed closure) for a mart-0 + Clover-0 day WITHIN the retention horizon", async () => {
    const recentBd = today.minus({ days: 10 }).toISODate()!; // < 365-day horizon
    const result = await runExternalReconJob(ctx.pool, agedConfig, fakeClient([]), job(recentBd));

    expect(result.metadata.status).toBe("ok");
    expect((await reconRow(recentBd)).status).toBe("ok");
  });
});
