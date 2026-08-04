import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { startAnalyticsItContext, type AnalyticsItContext } from "./fixture.js";
import type { AppConfig } from "../../src/config.js";
import { reconcileWindow } from "../../src/jobs/reconciliation-check.js";
import { loadReconBreaks } from "../../src/http/dashboard.js";

// Closes the detect->repair->RE-VERIFY loop over real Postgres. The bug (prod
// 2026-06-18): a day that broke, then self-healed via its repair_window, stayed
// 'failed' on the ops panel forever because it had aged out of the rolling
// export window and was never re-reconciled. reconcileWindow now folds any
// still-'failed' day back into the comparison spine regardless of the window, so
// a healed day re-checks clean and flips 'failed'->'passed' — and drops out of
// the dashboard's reconBreaks (asserted against the real loadReconBreaks query).
describe("reconciliation re-verify loop (real Postgres)", () => {
  let ctx: AnalyticsItContext;
  const M = "M_RECHECK";
  const config = { storeTimezone: "America/Chicago" } as AppConfig;

  // A window whose business dates are 2026-06-07 .. 2026-06-14 (America/Chicago).
  // None of the stale dates below fall inside it.
  const WINDOW_START = new Date("2026-06-08T00:00:00.000Z");
  const WINDOW_END = new Date("2026-06-15T00:00:00.000Z");

  // 2026-05-20: a break that has since aged out of the rolling window.
  const STALE_FAILED_BD = "2026-05-20";
  // 2026-05-25: inside the widened raw/mart SCAN range but NOT a break — proves
  // the union SPINE (not the scan bounds) governs which days get re-reconciled.
  const STALE_PASSED_BD = "2026-05-25";

  // Noon America/Chicago (CDT, UTC-5) -> 17:00Z, i.e. squarely inside the local
  // business date, so (created_time_utc AT TIME ZONE tz)::date == the date.
  const noonUtc = (isoDate: string) => new Date(`${isoDate}T17:00:00.000Z`);

  async function seedFailedResult(businessDate: string, agedDaysAgo: number) {
    await ctx.pool.query(
      `INSERT INTO audit.reconciliation_results
         (merchant_id, business_date, status, payment_total_delta_cents, details, created_at)
       VALUES ($1, $2::date, 'failed', 500, '{"note":"seeded stale break"}'::jsonb,
               now() - ($3 || ' days')::interval)`,
      [M, businessDate, String(agedDaysAgo)]
    );
  }

  async function seedPassedResult(businessDate: string, agedDaysAgo: number) {
    await ctx.pool.query(
      `INSERT INTO audit.reconciliation_results
         (merchant_id, business_date, status, details, created_at)
       VALUES ($1, $2::date, 'passed', '{"note":"seeded prior pass"}'::jsonb,
               now() - ($3 || ' days')::interval)`,
      [M, businessDate, String(agedDaysAgo)]
    );
  }

  // Seed raw + mart so the day reconciles with ZERO delta across every metric:
  // 1 order, one $10 credit-card payment, no refunds, on both sides.
  async function seedMatchingDay(businessDate: string) {
    const ts = noonUtc(businessDate);
    await ctx.pool.query(
      `INSERT INTO raw.clover_orders (merchant_id, order_id, payload, created_time_utc)
       VALUES ($1, $2, '{}'::jsonb, $3)`,
      [M, `o_${businessDate}`, ts]
    );
    await ctx.pool.query(
      `INSERT INTO raw.clover_payments (merchant_id, payment_id, payload, created_time_utc)
       VALUES ($1, $2, $3::jsonb, $4)`,
      [
        M,
        `p_${businessDate}`,
        JSON.stringify({ amount: 1000, taxAmount: 0, tipAmount: 0, tender: { label: "Credit Card" } }),
        ts
      ]
    );
    await ctx.pool.query(
      `INSERT INTO mart.fact_orders (merchant_id, order_id, business_date)
       VALUES ($1, $2, $3::date)`,
      [M, `o_${businessDate}`, businessDate]
    );
    await ctx.pool.query(
      `INSERT INTO mart.fact_payments
         (merchant_id, payment_id, business_date, tender_type, amount_cents, tax_cents, tip_cents)
       VALUES ($1, $2, $3::date, 'CREDIT_CARD', 1000, 0, 0)`,
      [M, `p_${businessDate}`, businessDate]
    );
  }

  async function latestStatus(businessDate: string) {
    const { rows } = await ctx.pool.query<{ status: string }>(
      `SELECT status FROM audit.reconciliation_results
       WHERE merchant_id = $1 AND business_date = $2::date
       ORDER BY created_at DESC LIMIT 1`,
      [M, businessDate]
    );
    return rows[0]?.status;
  }

  async function resultCount(businessDate: string) {
    const { rows } = await ctx.pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM audit.reconciliation_results
       WHERE merchant_id = $1 AND business_date = $2::date`,
      [M, businessDate]
    );
    return Number(rows[0]!.n);
  }

  async function reconBreakDates() {
    const { rows } = await loadReconBreaks(ctx.pool, M);
    return (rows as Array<{ business_date: string }>).map((r) => r.business_date);
  }

  beforeAll(async () => {
    ctx = await startAnalyticsItContext();
  });

  afterAll(async () => {
    await ctx?.stop();
  });

  beforeEach(async () => {
    for (const table of [
      "audit.reconciliation_results",
      "raw.clover_orders",
      "raw.clover_payments",
      "raw.clover_refunds",
      "mart.fact_orders",
      "mart.fact_payments",
      "mart.fact_refunds"
    ]) {
      await ctx.pool.query(`DELETE FROM ${table} WHERE merchant_id = $1`, [M]);
    }
  });

  it("re-verifies a stale 'failed' day that aged out of the window and flips it to 'passed'", async () => {
    // A break recorded 20 days ago; its data has since been repaired so raw==mart.
    await seedFailedResult(STALE_FAILED_BD, 20);
    await seedMatchingDay(STALE_FAILED_BD);

    // Pre-condition: the ops panel shows it as an unresolved break.
    expect(await reconBreakDates()).toContain(STALE_FAILED_BD);

    await reconcileWindow(ctx.pool, config, M, WINDOW_START, WINDOW_END);

    // The aged-out day was re-checked despite being outside [start, end] ...
    expect(await latestStatus(STALE_FAILED_BD)).toBe("passed");
    // ... and is gone from the dashboard's reconBreaks (the real query).
    expect(await reconBreakDates()).not.toContain(STALE_FAILED_BD);
  });

  it("re-flags a stale day that is STILL broken and re-enqueues its repair", async () => {
    // Break recorded 20 days ago; mart still missing the payment (raw has it).
    await seedFailedResult(STALE_FAILED_BD, 20);
    await ctx.pool.query(
      `INSERT INTO raw.clover_payments (merchant_id, payment_id, payload, created_time_utc)
       VALUES ($1, $2, $3::jsonb, $4)`,
      [
        M,
        `p_${STALE_FAILED_BD}`,
        JSON.stringify({ amount: 1000, tender: { label: "Credit Card" } }),
        noonUtc(STALE_FAILED_BD)
      ]
    );

    const result = await reconcileWindow(ctx.pool, config, M, WINDOW_START, WINDOW_END);

    expect(await latestStatus(STALE_FAILED_BD)).toBe("failed");
    expect(await reconBreakDates()).toContain(STALE_FAILED_BD);
    // The re-check re-runs the repair loop for the day that is genuinely broken.
    expect(result.repairJobsCreated).toBeGreaterThanOrEqual(1);
  });

  it("does not re-check a passing day inside the scan range but outside the spine (bounded)", async () => {
    await seedFailedResult(STALE_FAILED_BD, 20); // pulls the scan bound back to 05-20
    await seedMatchingDay(STALE_FAILED_BD);
    await seedPassedResult(STALE_PASSED_BD, 18); // 05-25: within [05-20, 06-14], already passing

    const result = await reconcileWindow(ctx.pool, config, M, WINDOW_START, WINDOW_END);

    // Only the 8 window days + the single stale failed day are reconciled — NOT
    // every day in the widened scan range.
    expect(result.daysChecked).toBe(9);
    // The already-passing 05-25 was not in the spine, so no new row was written.
    expect(await resultCount(STALE_PASSED_BD)).toBe(1);
  });
});
