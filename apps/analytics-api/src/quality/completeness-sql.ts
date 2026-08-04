// Shared SQL fragments for calendar completeness, reused by the completeness DQ
// check (quality/checks.ts), the heatmap endpoint (http/completeness.ts), and the
// external-recon enqueue (scheduler.ts) so the three never drift. $1 = merchant_id.

export const COMPLETENESS_WARMUP_DAYS = 28;

/**
 * CTE block (no leading WITH). target = per-store open_date + operating_days;
 * activity = days that have mart data; bounds = the store's own span; open_dows =
 * weekdays that have EVER sold; spine = the calendar from start to `spineEnd`.
 * `spineEnd` is a SQL expression for the upper bound — `bounds.last_data_date`
 * for the check + enqueue (interior only), or a caller param for the heatmap.
 */
export function completenessCtes(spineEnd: string): string {
  return `
      target AS (
        SELECT open_date, operating_days
        FROM config.sync_targets
        WHERE merchant_id = $1
      ),
      activity AS (
        SELECT business_date, order_count
        FROM mart.sales_daily_mv
        WHERE merchant_id = $1
      ),
      bounds AS (
        SELECT
          COALESCE((SELECT open_date FROM target), min(business_date)) AS start_date,
          max(business_date) AS last_data_date
        FROM activity
      ),
      open_dows AS (
        SELECT DISTINCT extract(dow FROM business_date)::int AS dow
        FROM activity
        WHERE order_count > 0
      ),
      spine AS (
        -- Only start_date is guarded: generate_series tolerates a NULL upper bound
        -- (yields 0 rows, no error), so a store with no data yet — NULL
        -- last_data_date — produces an empty spine exactly as intended.
        SELECT d::date AS business_date
        FROM bounds
        CROSS JOIN LATERAL generate_series(bounds.start_date, ${spineEnd}, interval '1 day') AS d
        WHERE bounds.start_date IS NOT NULL
      )`;
}

/**
 * Predicate for `spine s LEFT JOIN activity a ON a.business_date = s.business_date`
 * identifying an OPEN-but-empty day: open per the operating_days mask AND a weekday
 * that has ever sold, past the warm-up, with zero mart activity. Interior bounding
 * is the spineEnd's job. The warm-up is inlined (a constant) so the fragment
 * composes without threading a param.
 */
export const SUSPECT_MISSING_PREDICATE = `
        a.business_date IS NULL
        AND s.business_date >= (SELECT start_date FROM bounds) + ${COMPLETENESS_WARMUP_DAYS}
        AND ((COALESCE((SELECT operating_days FROM target), 127) >> extract(dow FROM s.business_date)::int) & 1) = 1
        AND extract(dow FROM s.business_date)::int IN (SELECT dow FROM open_dows)`;

/**
 * True when the external Clover recon has CONFIRMED a day's miss is a real closure
 * — Clover itself had zero successful payments that day (control_txn_count = 0,
 * status ok), so completeness must NOT read it as data loss. This is the
 * cross-stream signal: a closure is zero on BOTH sides; a lost day is zero on the
 * mart but non-zero in Clover (which lands as a recon 'fail', NOT confirmed-closed).
 * References s.business_date + $1.
 */
export const CLOVER_CONFIRMED_CLOSED = `
        EXISTS (
          SELECT 1 FROM audit.recon_daily rd
          WHERE rd.merchant_id = $1
            AND rd.business_date = s.business_date
            AND rd.status = 'ok'
            AND rd.control_txn_count = 0
        )`;
