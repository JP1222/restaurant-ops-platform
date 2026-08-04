// Daily raw-vs-mart reconciliation, and the RE-VERIFY half of the detect->repair
// loop. A break writes a 'failed' audit.reconciliation_results row and enqueues a
// repair_window (re-ingest). The repair fixes the data but does NOT itself flip
// the verdict back to 'passed' -- only a subsequent reconcile of that day does.
// Because the rolling export window is short (exportReconcileLookbackDays, ~7d),
// a day that self-healed *after* aging out of the window would otherwise stay
// 'failed' forever on the ops Reconciliation panel (observed on prod 2026-06-18:
// transient promotion-lag breaks that matched raw==mart but never re-reconciled).
// loadReconciliationRows() closes the loop: it folds any still-'failed' day back
// into the comparison spine regardless of the window, so a healed day re-checks
// clean and flips to 'passed'. Self-healing and bounded (RECHECK_STALE_FAILED_LIMIT).
import { DateTime } from "luxon";
import type { AppConfig } from "../config.js";
import type { DbPool } from "../db.js";
import { JobRepository } from "../scheduler/job-repository.js";
import { SyncWindowRepository } from "../scheduler/sync-window-repository.js";
import type { SyncJob } from "../scheduler/job-repository.js";
import { asJsonRecord } from "./shared.js";

// Re-verify ceiling: how many currently-'failed' days (newest-first) we fold
// back into a reconcile run on top of the rolling window. Bounds both the rows
// written and the raw-scan width so a pathological backlog can't unbound the
// job. Sits above the dashboard's own 30-row reconBreaks display cap so every
// break the UI can show is also eligible to self-heal. See the union spine in
// loadReconciliationRows() and the closed-loop rationale in this file's header.
const RECHECK_STALE_FAILED_LIMIT = 60;

type ReconciliationRow = {
  business_date: string | Date;
  raw_order_count: number;
  mart_order_count: number;
  order_count_delta: number;
  raw_payment_total_cents: string | number;
  mart_payment_total_cents: string | number;
  payment_total_delta_cents: string | number;
  raw_net_sales_cents: string | number;
  mart_net_sales_cents: string | number;
  net_sales_delta_cents: string | number;
  raw_tax_cents: string | number;
  mart_tax_cents: string | number;
  tax_delta_cents: string | number;
  raw_tip_cents: string | number;
  mart_tip_cents: string | number;
  tip_delta_cents: string | number;
  raw_refund_cents: string | number;
  mart_refund_cents: string | number;
  refund_delta_cents: string | number;
  raw_cash_cents: string | number;
  mart_cash_cents: string | number;
  cash_delta_cents: string | number;
  raw_credit_card_cents: string | number;
  mart_credit_card_cents: string | number;
  credit_card_delta_cents: string | number;
};

export async function runReconciliationCheckJob(pool: DbPool, config: AppConfig, job: SyncJob) {
  const payload = asJsonRecord(job.payload);
  const start = new Date(String(payload.start));
  const end = new Date(String(payload.end));
  const result = await reconcileWindow(pool, config, job.merchantId, start, end);
  return {
    rowsRead: result.daysChecked,
    rowsWritten: result.resultsWritten + result.repairJobsCreated,
    dirtyWindowCount: 0,
    outputTables: ["audit.reconciliation_results", "audit.sync_jobs"],
    metadata: {
      daysChecked: result.daysChecked,
      failedDays: result.failedDays,
      repairJobsCreated: result.repairJobsCreated
    },
    warning: result.failedDays > 0
  };
}

export async function reconcileWindow(
  pool: DbPool,
  config: AppConfig,
  merchantId: string,
  start: Date,
  end: Date
) {
  const rows = await loadReconciliationRows(pool, config, merchantId, start, end);
  const jobs = new JobRepository(pool);
  const syncWindows = new SyncWindowRepository(pool);
  let failedDays = 0;
  let repairJobsCreated = 0;

  for (const row of rows) {
    const businessDate = dateOnly(row.business_date);
    const status = hasAnyDelta(row) ? "failed" : "passed";
    if (status === "failed") {
      failedDays += 1;
    }
    const details = {
      raw: {
        orderCount: Number(row.raw_order_count),
        paymentTotalCents: toBigIntNumber(row.raw_payment_total_cents),
        netSalesCents: toBigIntNumber(row.raw_net_sales_cents),
        taxCents: toBigIntNumber(row.raw_tax_cents),
        tipCents: toBigIntNumber(row.raw_tip_cents),
        refundCents: toBigIntNumber(row.raw_refund_cents),
        cashCents: toBigIntNumber(row.raw_cash_cents),
        creditCardCents: toBigIntNumber(row.raw_credit_card_cents)
      },
      mart: {
        orderCount: Number(row.mart_order_count),
        paymentTotalCents: toBigIntNumber(row.mart_payment_total_cents),
        netSalesCents: toBigIntNumber(row.mart_net_sales_cents),
        taxCents: toBigIntNumber(row.mart_tax_cents),
        tipCents: toBigIntNumber(row.mart_tip_cents),
        refundCents: toBigIntNumber(row.mart_refund_cents),
        cashCents: toBigIntNumber(row.mart_cash_cents),
        creditCardCents: toBigIntNumber(row.mart_credit_card_cents)
      },
      note: status === "passed"
        ? "Raw and mart daily metrics match."
        : "Raw and mart daily metrics differ; repair window queued."
    };
    const inserted = await pool.query<{ id: string }>(
      `
        INSERT INTO audit.reconciliation_results (
          merchant_id, business_date, status, order_count_delta,
          payment_total_delta_cents, net_sales_delta_cents, tax_delta_cents,
          tip_delta_cents, refund_delta_cents, cash_delta_cents,
          credit_card_delta_cents, details
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb)
        RETURNING id
      `,
      [
        merchantId,
        businessDate,
        status,
        Number(row.order_count_delta),
        toBigIntNumber(row.payment_total_delta_cents),
        toBigIntNumber(row.net_sales_delta_cents),
        toBigIntNumber(row.tax_delta_cents),
        toBigIntNumber(row.tip_delta_cents),
        toBigIntNumber(row.refund_delta_cents),
        toBigIntNumber(row.cash_delta_cents),
        toBigIntNumber(row.credit_card_delta_cents),
        JSON.stringify(details)
      ]
    );

    if (inserted.rows[0]?.id) {
      await syncWindows.markStage({
        merchantId,
        windowType: "reconciliation_check",
        windowStart: start,
        windowEnd: end,
        stage: status === "passed" ? "reconciled_passed" : "reconciled_failed",
        status: status === "passed" ? "completed" : "warning",
        reconciliationId: inserted.rows[0].id,
        metrics: {
          businessDate,
          orderCountDelta: Number(row.order_count_delta),
          paymentTotalDeltaCents: toBigIntNumber(row.payment_total_delta_cents)
        }
      });
    }

    if (status === "failed") {
      const repairWindow = businessDateWindow(businessDate, config.storeTimezone);
      const repairJob = await jobs.enqueueOnce({
        jobType: "repair_window",
        merchantId,
        windowStart: repairWindow.start,
        windowEnd: repairWindow.end,
        dedupeKey: `${merchantId}:repair_window:${businessDate}`,
        payload: {
          start: repairWindow.start.toISOString(),
          end: repairWindow.end.toISOString(),
          reason: "reconciliation_delta"
        }
      });
      if (repairJob) {
        repairJobsCreated += 1;
      }
    }
  }

  return {
    daysChecked: rows.length,
    failedDays,
    resultsWritten: rows.length,
    repairJobsCreated
  };
}

async function loadReconciliationRows(
  pool: DbPool,
  config: AppConfig,
  merchantId: string,
  start: Date,
  end: Date
) {
  const businessStart = DateTime.fromJSDate(start, { zone: "utc" }).setZone(config.storeTimezone).toISODate();
  const businessEnd = DateTime.fromJSDate(new Date(end.getTime() - 1), { zone: "utc" }).setZone(config.storeTimezone).toISODate();
  const result = await pool.query<ReconciliationRow>(
    `
      WITH window_days AS (
        SELECT generate_series($2::date, $3::date, interval '1 day')::date AS business_date
      ),
      -- Re-verify spine (loop closure): days whose LATEST reconcile verdict is
      -- still 'failed' are folded back in even when they have aged out of the
      -- rolling window, so a break that self-healed via its repair_window gets
      -- re-checked and flipped 'failed'->'passed'. Mirrors the dashboard's
      -- reconBreaks truth (DISTINCT ON newest row per date). Bounded by $5 so a
      -- backlog can't unbound the run.
      stale_failed AS (
        SELECT business_date
        FROM (
          SELECT DISTINCT ON (business_date) business_date, status
          FROM audit.reconciliation_results
          WHERE merchant_id = $1
          ORDER BY business_date, created_at DESC
        ) latest
        WHERE status = 'failed'
        ORDER BY business_date DESC
        LIMIT $5
      ),
      days AS (
        SELECT business_date FROM window_days
        UNION
        SELECT business_date FROM stale_failed
      ),
      -- Drive every data scan off the actual day set (window + re-verify), not a
      -- hardcoded range: a stale failed day outside [start,end] must still load
      -- its raw/mart rows, else both sides read 0 and it would falsely 'pass'.
      bounds AS (
        SELECT min(business_date) AS lo, max(business_date) AS hi FROM days
      ),
      raw_orders AS (
        SELECT (created_time_utc AT TIME ZONE $4)::date AS business_date,
               count(*)::integer AS order_count
        FROM raw.clover_orders
        WHERE merchant_id = $1
          AND created_time_utc >= ((SELECT lo FROM bounds)::timestamp AT TIME ZONE $4)
          AND created_time_utc <  (((SELECT hi FROM bounds) + 1)::timestamp AT TIME ZONE $4)
        GROUP BY 1
      ),
      raw_payments AS (
        SELECT (created_time_utc AT TIME ZONE $4)::date AS business_date,
               sum(audit.raw_amount(payload, 'amount'))::bigint AS payment_total_cents,
               sum(audit.raw_amount(payload, 'taxAmount'))::bigint AS tax_cents,
               sum(audit.raw_amount(payload, 'tipAmount'))::bigint AS tip_cents,
               sum(CASE WHEN audit.raw_tender_label(payload) LIKE '%cash%' THEN audit.raw_amount(payload, 'amount') ELSE 0 END)::bigint AS cash_cents,
               sum(CASE WHEN audit.raw_tender_label(payload) ~ '(credit|card|visa|master|amex|discover)' THEN audit.raw_amount(payload, 'amount') ELSE 0 END)::bigint AS credit_card_cents
        FROM raw.clover_payments
        WHERE merchant_id = $1
          AND created_time_utc >= ((SELECT lo FROM bounds)::timestamp AT TIME ZONE $4)
          AND created_time_utc <  (((SELECT hi FROM bounds) + 1)::timestamp AT TIME ZONE $4)
          AND COALESCE(payload->>'voided', 'false') <> 'true'
          AND lower(concat_ws(' ', payload->>'result', payload->>'status', payload->>'state')) !~ '(fail|failed|declin|void|cancel|error)'
        GROUP BY 1
      ),
      raw_refunds AS (
        SELECT (created_time_utc AT TIME ZONE $4)::date AS business_date,
               sum(abs(audit.raw_amount(payload, 'amount')))::bigint AS refund_cents
        FROM raw.clover_refunds
        WHERE merchant_id = $1
          AND created_time_utc >= ((SELECT lo FROM bounds)::timestamp AT TIME ZONE $4)
          AND created_time_utc <  (((SELECT hi FROM bounds) + 1)::timestamp AT TIME ZONE $4)
        GROUP BY 1
      ),
      mart_orders AS (
        SELECT business_date, count(*)::integer AS order_count
        FROM mart.fact_orders
        WHERE merchant_id = $1
          AND business_date >= (SELECT lo FROM bounds)
          AND business_date <= (SELECT hi FROM bounds)
        GROUP BY business_date
      ),
      mart_payments AS (
        SELECT business_date,
               sum(amount_cents)::bigint AS payment_total_cents,
               sum(tax_cents)::bigint AS tax_cents,
               sum(tip_cents)::bigint AS tip_cents,
               sum(amount_cents) FILTER (WHERE tender_type = 'CASH')::bigint AS cash_cents,
               sum(amount_cents) FILTER (WHERE tender_type = 'CREDIT_CARD')::bigint AS credit_card_cents
        FROM mart.fact_payments
        WHERE merchant_id = $1
          AND business_date >= (SELECT lo FROM bounds)
          AND business_date <= (SELECT hi FROM bounds)
        GROUP BY business_date
      ),
      mart_refunds AS (
        SELECT business_date, sum(amount_cents)::bigint AS refund_cents
        FROM mart.fact_refunds
        WHERE merchant_id = $1
          AND business_date >= (SELECT lo FROM bounds)
          AND business_date <= (SELECT hi FROM bounds)
        GROUP BY business_date
      )
      SELECT
        d.business_date,
        COALESCE(ro.order_count, 0)::integer AS raw_order_count,
        COALESCE(mo.order_count, 0)::integer AS mart_order_count,
        (COALESCE(mo.order_count, 0) - COALESCE(ro.order_count, 0))::integer AS order_count_delta,
        COALESCE(rp.payment_total_cents, 0)::bigint AS raw_payment_total_cents,
        COALESCE(mp.payment_total_cents, 0)::bigint AS mart_payment_total_cents,
        (COALESCE(mp.payment_total_cents, 0) - COALESCE(rp.payment_total_cents, 0))::bigint AS payment_total_delta_cents,
        (COALESCE(rp.payment_total_cents, 0) - COALESCE(rr.refund_cents, 0))::bigint AS raw_net_sales_cents,
        (COALESCE(mp.payment_total_cents, 0) - COALESCE(mr.refund_cents, 0))::bigint AS mart_net_sales_cents,
        ((COALESCE(mp.payment_total_cents, 0) - COALESCE(mr.refund_cents, 0)) - (COALESCE(rp.payment_total_cents, 0) - COALESCE(rr.refund_cents, 0)))::bigint AS net_sales_delta_cents,
        COALESCE(rp.tax_cents, 0)::bigint AS raw_tax_cents,
        COALESCE(mp.tax_cents, 0)::bigint AS mart_tax_cents,
        (COALESCE(mp.tax_cents, 0) - COALESCE(rp.tax_cents, 0))::bigint AS tax_delta_cents,
        COALESCE(rp.tip_cents, 0)::bigint AS raw_tip_cents,
        COALESCE(mp.tip_cents, 0)::bigint AS mart_tip_cents,
        (COALESCE(mp.tip_cents, 0) - COALESCE(rp.tip_cents, 0))::bigint AS tip_delta_cents,
        COALESCE(rr.refund_cents, 0)::bigint AS raw_refund_cents,
        COALESCE(mr.refund_cents, 0)::bigint AS mart_refund_cents,
        (COALESCE(mr.refund_cents, 0) - COALESCE(rr.refund_cents, 0))::bigint AS refund_delta_cents,
        COALESCE(rp.cash_cents, 0)::bigint AS raw_cash_cents,
        COALESCE(mp.cash_cents, 0)::bigint AS mart_cash_cents,
        (COALESCE(mp.cash_cents, 0) - COALESCE(rp.cash_cents, 0))::bigint AS cash_delta_cents,
        COALESCE(rp.credit_card_cents, 0)::bigint AS raw_credit_card_cents,
        COALESCE(mp.credit_card_cents, 0)::bigint AS mart_credit_card_cents,
        (COALESCE(mp.credit_card_cents, 0) - COALESCE(rp.credit_card_cents, 0))::bigint AS credit_card_delta_cents
      FROM days d
      LEFT JOIN raw_orders ro USING (business_date)
      LEFT JOIN raw_payments rp USING (business_date)
      LEFT JOIN raw_refunds rr USING (business_date)
      LEFT JOIN mart_orders mo USING (business_date)
      LEFT JOIN mart_payments mp USING (business_date)
      LEFT JOIN mart_refunds mr USING (business_date)
      ORDER BY d.business_date
    `,
    [merchantId, businessStart, businessEnd, config.storeTimezone, RECHECK_STALE_FAILED_LIMIT]
  );
  return result.rows;
}

function hasAnyDelta(row: ReconciliationRow) {
  return [
    row.order_count_delta,
    row.payment_total_delta_cents,
    row.net_sales_delta_cents,
    row.tax_delta_cents,
    row.tip_delta_cents,
    row.refund_delta_cents,
    row.cash_delta_cents,
    row.credit_card_delta_cents
  ].some((value) => toBigIntNumber(value) !== 0);
}

function toBigIntNumber(value: string | number) {
  return Number(value);
}

function dateOnly(value: string | Date) {
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
}

function businessDateWindow(value: string, timezone: string) {
  const start = DateTime.fromISO(value, { zone: timezone }).startOf("day");
  return {
    start: start.toUTC().toJSDate(),
    end: start.plus({ days: 1 }).toUTC().toJSDate()
  };
}
