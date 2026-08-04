import { internalQuery } from "../analytics/internal-query.js";
import type { DbPool } from "../db.js";
import {
  CLOVER_CONFIRMED_CLOSED,
  completenessCtes,
  SUSPECT_MISSING_PREDICATE
} from "./completeness-sql.js";

const DQ_ACTOR = "dq-check";

export async function runDataQualityChecks(pool: DbPool, merchantId: string, start?: Date, end?: Date) {
  const checks = [
    await countCheck(pool, merchantId, "hourly_sweep_stale", `
      SELECT CASE
        WHEN max(completed_at) IS NULL THEN 1
        WHEN max(completed_at) < now() - interval '90 minutes' THEN 1
        ELSE 0
      END::integer AS count
      FROM audit.sync_runs
      WHERE merchant_id = $1
        AND job_type = 'hourly_rest_sweep'
        AND status = 'completed'
    `, start, end),
    await countCheck(pool, merchantId, "export_reconcile_stale", `
      SELECT CASE
        WHEN max(completed_at) IS NULL THEN 1
        WHEN max(completed_at) < now() - interval '24 hours' THEN 1
        ELSE 0
      END::integer AS count
      FROM audit.sync_runs
      WHERE merchant_id = $1
        AND job_type = 'export_reconcile'
        AND status = 'completed'
    `, start, end),
    await countCheck(pool, merchantId, "orders_without_line_items", `
      SELECT count(*)::integer AS count
      FROM mart.fact_orders o
      LEFT JOIN mart.fact_order_line_items li
        ON li.merchant_id = o.merchant_id
       AND li.order_id = o.order_id
       AND li.business_date = o.business_date
      WHERE o.merchant_id = $1
        AND ($2::timestamptz IS NULL OR o.created_at_utc >= $2)
        AND ($3::timestamptz IS NULL OR o.created_at_utc < $3)
        AND EXISTS (
          SELECT 1
          FROM mart.fact_payments p
          WHERE p.merchant_id = o.merchant_id
            AND p.order_id = o.order_id
        )
        AND li.order_id IS NULL
    `, start, end),
    await countCheck(pool, merchantId, "payments_without_orders", `
      SELECT count(*)::integer AS count
      FROM mart.fact_payments p
      LEFT JOIN mart.fact_orders o
        ON o.merchant_id = p.merchant_id
       AND o.order_id = p.order_id
      WHERE p.merchant_id = $1
        AND ($2::timestamptz IS NULL OR p.created_at_utc >= $2)
        AND ($3::timestamptz IS NULL OR p.created_at_utc < $3)
        AND p.order_id IS NOT NULL
        AND o.order_id IS NULL
    `, start, end),
    await countCheck(pool, merchantId, "unknown_tender_type", `
      SELECT count(*)::integer AS count
      FROM mart.fact_payments p
      WHERE p.merchant_id = $1
        AND ($2::timestamptz IS NULL OR p.created_at_utc >= $2)
        AND ($3::timestamptz IS NULL OR p.created_at_utc < $3)
        AND p.tender_type = 'UNKNOWN'
    `, start, end),
    await countCheck(pool, merchantId, "invalid_quantity", `
      SELECT count(*)::integer AS count
      FROM mart.fact_order_line_items li
      WHERE li.merchant_id = $1
        AND ($2::timestamptz IS NULL OR li.created_at_utc >= $2)
        AND ($3::timestamptz IS NULL OR li.created_at_utc < $3)
        AND li.quantity <= 0
    `, start, end),
    await countCheck(pool, merchantId, "low_detail_score_paid_orders", `
      SELECT count(*)::integer AS count
      FROM raw.clover_orders o
      WHERE o.merchant_id = $1
        AND ($2::timestamptz IS NULL OR o.created_time_utc >= $2)
        AND ($3::timestamptz IS NULL OR o.created_time_utc < $3)
        AND o.detail_score < 2
        AND EXISTS (
          SELECT 1
          FROM raw.clover_payments p
          WHERE p.merchant_id = o.merchant_id
            AND (p.payload #>> '{order,id}' = o.order_id OR p.payload->>'orderId' = o.order_id)
        )
    `, start, end),
    await countCheck(pool, merchantId, "modifier_total_without_modifiers", `
      SELECT count(*)::integer AS count
      FROM mart.fact_order_line_items li
      WHERE li.merchant_id = $1
        AND ($2::timestamptz IS NULL OR li.created_at_utc >= $2)
        AND ($3::timestamptz IS NULL OR li.created_at_utc < $3)
        AND li.modifier_total_cents > 0
        AND jsonb_array_length(li.modifiers) = 0
    `, start, end),
    await countCheck(pool, merchantId, "daily_order_count_drop", `
      WITH daily AS (
        SELECT business_date, count(*)::numeric AS order_count
        FROM mart.fact_orders
        WHERE merchant_id = $1
          AND business_date >= current_date - interval '8 days'
          AND business_date < current_date
        GROUP BY business_date
      ),
      latest AS (
        SELECT order_count
        FROM daily
        ORDER BY business_date DESC
        LIMIT 1
      ),
      baseline AS (
        SELECT avg(order_count) AS avg_count
        FROM (
          SELECT order_count
          FROM daily
          ORDER BY business_date DESC
          OFFSET 1
          LIMIT 7
        ) rows
      )
      SELECT CASE
        WHEN COALESCE((SELECT avg_count FROM baseline), 0) >= 10
         AND COALESCE((SELECT order_count FROM latest), 0) < (SELECT avg_count FROM baseline) * 0.5
        THEN 1 ELSE 0
      END::integer AS count
    `, start, end),
    await calendarCompletenessCheck(pool, merchantId)
  ];

  return {
    rowsRead: checks.length,
    rowsWritten: checks.reduce((sum, check) => sum + check.rowsWritten, 0),
    failedCount: checks.filter((check) => check.status === "failed").length
  };
}

// P1 calendar completeness: are there OPEN business days inside the store's data
// span with zero ingested activity — i.e. a day that was lost, not closed?
//
// Three guards keep this from false-flagging a closed day, with NO empirical-
// inference state machine (per the lean roadmap):
//   1. Warm-up — a day within COMPLETENESS_WARMUP_DAYS of the store's start is
//      never flagged (a freshly-onboarded store has no operating history yet).
//   2. operating_days mask — an explicit per-store weekday mask (bit 0 = Sunday).
//   3. Never-open weekday — a weekday that has produced an order at NO point in
//      the store's history is treated as closed automatically, so an existing
//      store with a regular day off needs no manual mask (this is what makes a
//      default 127 mask safe across 8 years of store-#1 history).
//
// The spine is bounded by the store's OWN data span (earliest..latest active
// day), so the not-yet-loaded leading edge (today / an unreconciled tail) is
// never flagged — only interior holes are. business_date is already store-tz
// bucketed in the mart, so no timezone math is needed here.
async function calendarCompletenessCheck(pool: DbPool, merchantId: string) {
  const result = await internalQuery<{
    missing_count: number;
    confirmed_closed_count: number;
    missing_dates: string[];
  }>(pool, {
    sql: `
      WITH ${completenessCtes("bounds.last_data_date")},
      -- Every open-but-empty day, tagged with whether the external Clover recon
      -- has confirmed it a real closure (Clover also had zero). confirmed_closed
      -- days are de-escalated (not data loss); the rest are genuine/unverified
      -- misses. Counting both makes the de-escalation observable — an unexpected
      -- mass confirm-closed (e.g. an aging-out POS) shows up rather than silently
      -- dropping a critical alarm.
      suspect AS (
        SELECT
          s.business_date,
          (${CLOVER_CONFIRMED_CLOSED}) AS confirmed_closed
        FROM spine s
        LEFT JOIN activity a ON a.business_date = s.business_date
        WHERE ${SUSPECT_MISSING_PREDICATE}
      )
      SELECT
        count(*) FILTER (WHERE NOT confirmed_closed)::int AS missing_count,
        count(*) FILTER (WHERE confirmed_closed)::int AS confirmed_closed_count,
        COALESCE(
          (SELECT array_agg(to_char(business_date, 'YYYY-MM-DD') ORDER BY business_date DESC)
           FROM (SELECT business_date FROM suspect WHERE NOT confirmed_closed ORDER BY business_date DESC LIMIT 60) m),
          ARRAY[]::text[]
        ) AS missing_dates
      FROM suspect
    `,
    params: [merchantId],
    actor: DQ_ACTOR,
    label: "dq:missing_business_dates"
  });

  const row = result.rows[0];
  const count = Number(row?.missing_count ?? 0);
  const confirmedClosed = Number(row?.confirmed_closed_count ?? 0);
  const sampleDates = row?.missing_dates ?? [];
  const status = count === 0 ? "passed" : "failed";
  const rowsWritten = await recordCheckResult(pool, {
    merchantId,
    checkName: "missing_business_dates",
    status,
    // A lost sales day is more serious than a shape anomaly: surface it loudly.
    severity: status === "passed" ? "info" : "critical",
    details: { count, confirmed_closed: confirmedClosed, sample_dates: sampleDates }
  });
  return { checkName: "missing_business_dates", status, count, rowsWritten };
}

async function countCheck(
  pool: DbPool,
  merchantId: string,
  checkName: string,
  sql: string,
  start?: Date,
  end?: Date
) {
  const result = await internalQuery<{ count: number }>(pool, {
    sql,
    params: [merchantId, start ?? null, end ?? null].slice(0, sqlParameterCount(sql)),
    actor: DQ_ACTOR,
    label: `dq:${checkName}`
  });
  const count = Number(result.rows[0]?.count ?? 0);
  const status = count === 0 ? "passed" : "failed";
  const rowsWritten = await recordCheckResult(pool, {
    merchantId,
    checkName,
    status,
    severity: status === "passed" ? "info" : "warning",
    start,
    end,
    details: { count }
  });
  return { checkName, status, count, rowsWritten };
}

// Exported so other detectors (e.g. external-recon) surface on the same DQ path
// — UPDATE-or-INSERT keyed by (merchant, check_name, window), auto-resolving when
// a later run passes for the same window.
export async function recordCheckResult(
  pool: DbPool,
  input: {
    merchantId: string;
    checkName: string;
    status: "passed" | "failed";
    severity: "info" | "warning" | "critical";
    start?: Date;
    end?: Date;
    details: Record<string, unknown>;
  }
) {
  if (input.status === "passed") {
    const resolved = await internalQuery(pool, {
      sql: `
        UPDATE audit.data_quality_checks
        SET status = 'passed',
            severity = 'info',
            last_seen_at = now(),
            resolved_at = now(),
            details = $5::jsonb
        WHERE merchant_id = $1
          AND check_name = $2
          AND window_start IS NOT DISTINCT FROM $3::timestamptz
          AND window_end IS NOT DISTINCT FROM $4::timestamptz
          AND resolved_at IS NULL
      `,
      params: [
        input.merchantId,
        input.checkName,
        input.start ?? null,
        input.end ?? null,
        JSON.stringify(input.details)
      ],
      actor: DQ_ACTOR,
      label: `dq-resolve:${input.checkName}`
    });
    return resolved.rowCount ?? 0;
  }

  const updated = await internalQuery(pool, {
    sql: `
      UPDATE audit.data_quality_checks
      SET status = 'failed',
          severity = $5,
          last_seen_at = now(),
          details = $6::jsonb
      WHERE merchant_id = $1
        AND check_name = $2
        AND window_start IS NOT DISTINCT FROM $3::timestamptz
        AND window_end IS NOT DISTINCT FROM $4::timestamptz
        AND resolved_at IS NULL
    `,
    params: [
      input.merchantId,
      input.checkName,
      input.start ?? null,
      input.end ?? null,
      input.severity,
      JSON.stringify(input.details)
    ],
    actor: DQ_ACTOR,
    label: `dq-fail-update:${input.checkName}`
  });
  if ((updated.rowCount ?? 0) > 0) {
    return updated.rowCount ?? 0;
  }

  const inserted = await internalQuery(pool, {
    sql: `
      INSERT INTO audit.data_quality_checks (
        merchant_id, check_name, status, severity, window_start, window_end,
        details, first_seen_at, last_seen_at
      )
      VALUES ($1, $2, 'failed', $3, $4, $5, $6::jsonb, now(), now())
    `,
    params: [
      input.merchantId,
      input.checkName,
      input.severity,
      input.start ?? null,
      input.end ?? null,
      JSON.stringify(input.details)
    ],
    actor: DQ_ACTOR,
    label: `dq-fail-insert:${input.checkName}`
  });
  return inserted.rowCount ?? 1;
}

function sqlParameterCount(sql: string) {
  const indexes = [...sql.matchAll(/\$(\d+)/g)].map((match) => Number(match[1]));
  return indexes.length === 0 ? 0 : Math.max(...indexes);
}
