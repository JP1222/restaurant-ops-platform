import { DateTime } from "luxon";

import type { AppConfig } from "../config.js";
import type { CloverClient } from "../clover/client.js";
import type { DbPool } from "../db.js";
import { recordCheckResult } from "../quality/checks.js";
import type { SyncJob } from "../scheduler/job-repository.js";
import { normalizePayment } from "../transform/normalize.js";
import type { JsonRecord, TenderType } from "../types.js";
import { asJsonRecord } from "./shared.js";

// Tolerance bands for the gross-cents diff. Exact-zero would flood false fails on
// a cross-source re-fetch (per-line rounding, tz/DST-cutover dust), so OK absorbs
// a small band; the wider band is WARN (counts match, cents drift); beyond it, or
// any txn-count mismatch, is FAIL. Relative floors scale with the day's size.
const WARN_FLOOR_CENTS = 50; // $0.50
const WARN_REL = 0.0005; // 0.05%
const FAIL_FLOOR_CENTS = 500; // $5.00
const FAIL_REL = 0.005; // 0.5%

export type ReconStatus = "ok" | "warn" | "fail" | "source_unavailable" | "boundary_suspect";

export interface ControlTotal {
  grossCents: number;
  txnCount: number;
}

export interface ReconVerdict {
  status: ReconStatus;
  deltaGrossCents: number;
  deltaTxnCount: number;
  toleranceCents: number;
}

/**
 * Reconstruct the day's control total from freshly re-fetched Clover payments by
 * running them through the SAME normalizePayment the mart loader uses — so the
 * control total can't drift from the mart's success/rounding/tz semantics and
 * false-fire. (The cost: a normalizePayment bug is invisible here too; this
 * catches export/source incompleteness, which is the real-world failure mode.)
 * Payments are fetched by createdTime window, so all bucket to `businessDate`;
 * the guard is belt-and-suspenders against a tz-boundary straggler.
 */
export function reconstructControlTotal(
  payments: JsonRecord[],
  timezone: string,
  businessDate: string
): ControlTotal {
  const tenderLookup = new Map<string, TenderType>();
  let grossCents = 0;
  let txnCount = 0;
  for (const raw of payments) {
    const normalized = normalizePayment(raw, timezone, tenderLookup);
    if (!normalized || normalized.businessDate !== businessDate) {
      continue;
    }
    grossCents += normalized.amountCents;
    txnCount += 1;
  }
  return { grossCents, txnCount };
}

/** Classify the control-vs-mart diff into a recon status with a tolerance band. */
export function classifyRecon(input: {
  controlGrossCents: number;
  controlTxnCount: number;
  martGrossCents: number;
  martTxnCount: number;
  // Age bound on the confirm-closed (zero-vs-zero) verdict. `ageDays` is how old the
  // business day is; `retentionDays` is how far back the source still retains payment
  // data. When the day is older than the horizon, a zero re-fetch can't be trusted as
  // a real closure (the source may have aged it out), so the verdict is
  // source_unavailable instead of ok. Both must be supplied to arm the bound; when
  // either is omitted (e.g. unit tests, or a source with lifetime retention) the
  // verdict is left un-bounded and a zero-vs-zero stays ok. See
  // cloverPaymentsRetentionDays in config.ts.
  ageDays?: number;
  retentionDays?: number;
}): ReconVerdict {
  const deltaGrossCents = input.controlGrossCents - input.martGrossCents;
  const deltaTxnCount = input.controlTxnCount - input.martTxnCount;
  const toleranceCents = Math.max(WARN_FLOOR_CENTS, Math.round(WARN_REL * input.martGrossCents));
  const failToleranceCents = Math.max(FAIL_FLOOR_CENTS, Math.round(FAIL_REL * input.martGrossCents));

  let status: ReconStatus;
  if (input.martTxnCount === 0 && input.controlTxnCount === 0) {
    // Nothing recorded on either side. Normally "no activity to reconcile" (ok) —
    // the confirmed-closure signal completeness de-escalates a suspect-missing day
    // on. But for a mart-0 day, this branch is the ONLY thing standing between a
    // real data loss and a dropped alarm: if the day is older than the source's
    // retention horizon, the source's zero may just be aged-out data, not a true
    // closure. In that case we cannot confirm closure, so we mark source_unavailable
    // (which keeps completeness flagging the day) rather than ok.
    const agedPastRetention =
      input.ageDays !== undefined &&
      input.retentionDays !== undefined &&
      input.ageDays > input.retentionDays;
    status = agedPastRetention ? "source_unavailable" : "ok";
  } else if (input.controlTxnCount === 0 && input.martTxnCount > 0) {
    // The mart has payments but the re-fetch returned none: cannot verify. Never
    // read 0-vs-something as agreement (the outage / data-aged-out trap).
    status = "source_unavailable";
  } else if (deltaTxnCount === 0 && Math.abs(deltaGrossCents) <= toleranceCents) {
    status = "ok";
  } else if (deltaTxnCount === 0 && Math.abs(deltaGrossCents) <= failToleranceCents) {
    // Counts agree, cents drift within the wider band — rounding-class noise.
    status = "warn";
  } else {
    // A transaction-count mismatch, or a material cents gap: a real break.
    status = "fail";
  }
  return { status, deltaGrossCents, deltaTxnCount, toleranceCents };
}

// Whole days between `businessDate` (a store-local calendar date) and "today" in
// the same zone — the day's age, used to age-bound the confirm-closed verdict. `asOf`
// is injectable for deterministic tests; production passes the wall clock. Zone math
// matters only near local midnight, where the business-day boundary is store-local.
export function businessDateAgeDays(
  businessDate: string,
  timezone: string,
  asOf: DateTime = DateTime.now()
): number {
  const today = asOf.setZone(timezone).startOf("day");
  const day = DateTime.fromISO(businessDate, { zone: timezone }).startOf("day");
  return Math.floor(today.diff(day, "days").days);
}

// [start, end) UTC instants for `businessDate` in the store's zone. startOf/plus
// are zone-aware so 23h/25h DST days produce the correct local-midnight bounds.
export function storeDayWindowUtc(businessDate: string, timezone: string): { start: Date; end: Date } {
  const startLocal = DateTime.fromISO(businessDate, { zone: timezone }).startOf("day");
  return {
    start: startLocal.toUTC().toJSDate(),
    end: startLocal.plus({ days: 1 }).toUTC().toJSDate()
  };
}

export async function runExternalReconJob(
  pool: DbPool,
  config: AppConfig,
  client: CloverClient,
  job: SyncJob
) {
  const payload = asJsonRecord(job.payload);
  const businessDate = String(payload.businessDate);
  const timezone = await storeTimezone(pool, job.merchantId, config.storeTimezone);
  const { start, end } = storeDayWindowUtc(businessDate, timezone);

  // A hard fetch failure THROWS here (so the job fails and leaves no recon_daily
  // row — the day stays a candidate and is re-tried). It never returns a false zero,
  // which is what makes the zero-vs-zero confirm-closed verdict safe. This throw-not-
  // persist behavior is load-bearing for P4b: see the candidate-gate note in
  // scheduler.ts (enqueueExternalRecon).
  const payments = await client.listPaymentsByCreatedTime(start, end);
  const control = reconstructControlTotal(payments, timezone, businessDate);
  const mart = await martTotals(pool, job.merchantId, businessDate);
  const verdict = classifyRecon({
    controlGrossCents: control.grossCents,
    controlTxnCount: control.txnCount,
    martGrossCents: mart.grossCents,
    martTxnCount: mart.txnCount,
    ageDays: businessDateAgeDays(businessDate, timezone),
    retentionDays: config.cloverPaymentsRetentionDays
  });

  await upsertReconDaily(pool, job.merchantId, businessDate, control, mart, verdict);

  // Surface on the existing DQ path (ops panel) so a break isn't another
  // written-but-never-read table; an OK run resolves any prior break for the day.
  await recordCheckResult(pool, {
    merchantId: job.merchantId,
    checkName: "external_recon_break",
    status: verdict.status === "ok" ? "passed" : "failed",
    severity: verdict.status === "fail" ? "critical" : "warning",
    start,
    end,
    details: {
      businessDate,
      status: verdict.status,
      deltaGrossCents: verdict.deltaGrossCents,
      deltaTxnCount: verdict.deltaTxnCount,
      controlTxnCount: control.txnCount,
      martTxnCount: mart.txnCount
    }
  });

  return {
    rowsRead: payments.length,
    rowsWritten: 1,
    dirtyWindowCount: 0,
    outputTables: ["audit.recon_daily", "audit.data_quality_checks"],
    metadata: {
      businessDate,
      status: verdict.status,
      deltaGrossCents: verdict.deltaGrossCents,
      deltaTxnCount: verdict.deltaTxnCount
    },
    warning: verdict.status !== "ok"
  };
}

async function storeTimezone(pool: DbPool, merchantId: string, fallback: string): Promise<string> {
  const { rows } = await pool.query<{ store_timezone: string }>(
    "SELECT store_timezone FROM config.sync_targets WHERE merchant_id = $1",
    [merchantId]
  );
  return rows[0]?.store_timezone ?? fallback;
}

// fact_payments holds only successful payments (normalizePayment drops the rest),
// so SUM(amount_cents) + count is the gross successful total — the same basis the
// control total is reconstructed on.
async function martTotals(
  pool: DbPool,
  merchantId: string,
  businessDate: string
): Promise<ControlTotal> {
  const { rows } = await pool.query<{ txn: number; gross: string }>(
    `SELECT count(*)::int AS txn, COALESCE(SUM(amount_cents), 0)::bigint AS gross
     FROM mart.fact_payments
     WHERE merchant_id = $1 AND business_date = $2`,
    [merchantId, businessDate]
  );
  return { grossCents: Number(rows[0]?.gross ?? 0), txnCount: Number(rows[0]?.txn ?? 0) };
}

async function upsertReconDaily(
  pool: DbPool,
  merchantId: string,
  businessDate: string,
  control: ControlTotal,
  mart: ControlTotal,
  verdict: ReconVerdict
): Promise<void> {
  await pool.query(
    `
      INSERT INTO audit.recon_daily (
        merchant_id, business_date, control_gross_cents, control_txn_count,
        mart_gross_cents, mart_txn_count, delta_gross_cents, delta_txn_count,
        tolerance_cents, status, source_detail, reconstructed_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, now())
      ON CONFLICT (merchant_id, business_date) DO UPDATE SET
        control_gross_cents = EXCLUDED.control_gross_cents,
        control_txn_count = EXCLUDED.control_txn_count,
        mart_gross_cents = EXCLUDED.mart_gross_cents,
        mart_txn_count = EXCLUDED.mart_txn_count,
        delta_gross_cents = EXCLUDED.delta_gross_cents,
        delta_txn_count = EXCLUDED.delta_txn_count,
        tolerance_cents = EXCLUDED.tolerance_cents,
        status = EXCLUDED.status,
        source_detail = EXCLUDED.source_detail,
        reconstructed_at = now()
    `,
    [
      merchantId,
      businessDate,
      control.grossCents,
      control.txnCount,
      mart.grossCents,
      mart.txnCount,
      verdict.deltaGrossCents,
      verdict.deltaTxnCount,
      verdict.toleranceCents,
      verdict.status,
      JSON.stringify({ controlTxnCount: control.txnCount, martTxnCount: mart.txnCount })
    ]
  );
}
