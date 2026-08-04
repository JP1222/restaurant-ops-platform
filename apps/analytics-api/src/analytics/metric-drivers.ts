import type { DbPool } from "../db.js";
import { DateTime } from "luxon";

/**
 * Driver decomposition for "why did net sales move on day D?" — attributes the
 * day's delta-vs-normal across dimensions (daypart / order type / tender / item),
 * ranking each dimension's members by their contribution to the change.
 *
 * Statistics only: this computes WHAT moved, never WHY. The caller (the AI
 * `explain_metric_change` tool) narrates the ranked drivers; it must not infer a
 * cause beyond what the numbers show.
 *
 * Baseline = the SAME WEEKDAY's recent norm (trailing 4 weeks, averaged), not a
 * contiguous range. A single store's daily series has strong day-of-week
 * seasonality, so comparing a Friday to "the last 4 days" would flag every Friday
 * as anomalous. Same-weekday is the only honest expectation. With a single
 * location, even 4 weeks is a small n — `sufficient` is false when fewer than
 * MIN_BASELINE_DAYS of same-weekday history exist, so the consumer can caveat
 * rather than trust a one-sample baseline. Sources mirror trends-breakdown.ts so
 * the segment math stays consistent with the Trends page.
 */

export type DriverDimensionKey = "daypart" | "order_type" | "tender" | "item";

// Which underlying total each dimension decomposes. daypart/order_type sum to net
// sales; tender sums to payment total; item sums to GROSS item sales (line items
// carry no order-level discounts/refunds). They are self-consistent per dimension
// but item totals deliberately do NOT reconcile to the headline net figure.
export type DriverBasis = "net_sales" | "payment" | "gross_sales";

export interface DriverMember {
  key: string;
  current_cents: number;
  /** Per-day same-weekday average (the expected value for this day), or null when no baseline history. */
  baseline_cents: number | null;
  /** current − baseline; null when no baseline history. */
  delta_cents: number | null;
  /** This member's delta as a fraction of the dimension's total delta; null when that total is ~0. */
  share_of_delta: number | null;
}

export interface DriverDimension {
  dimension: DriverDimensionKey;
  basis: DriverBasis;
  current_cents: number;
  baseline_cents: number | null;
  delta_cents: number | null;
  drivers: DriverMember[];
}

export interface MetricDriversResult {
  metric: "net_sales";
  date: string;
  baseline: { kind: "same_weekday_4wk"; dates: string[]; day_count: number };
  sufficient: boolean;
  total: {
    current_cents: number;
    baseline_cents: number | null;
    delta_cents: number | null;
    delta_pct: number | null;
  };
  dimensions: DriverDimension[];
}

const BASELINE_WEEKS = [1, 2, 3, 4];
const MIN_BASELINE_DAYS = 2;
const DEFAULT_TOP = 5;

/** The same weekday across the trailing 4 weeks (D-7, D-14, D-21, D-28), newest first. */
export function sameWeekdayBaselineDates(date: string): string[] {
  const d = DateTime.fromISO(date, { zone: "utc" });
  return BASELINE_WEEKS.map((weeks) => d.minus({ weeks }).toFormat("yyyy-MM-dd"));
}

interface RawDriverRow {
  key: string | null;
  current_cents: string | null;
  baseline_sum_cents: string | null;
}

/**
 * Pure: turn raw per-member sums (current day + summed baseline days) into a ranked
 * DriverDimension. `dayCount` is the number of same-weekday baseline days that had
 * data, so baseline_cents is the per-day average (the expected value for one day).
 * Members are ranked by absolute delta so both gains and losses surface — a member
 * that vanished today (current 0, baseline > 0) is as important as a new spike.
 */
export function buildDimension(
  dimension: DriverDimensionKey,
  basis: DriverBasis,
  rows: RawDriverRow[],
  dayCount: number,
  top: number,
): DriverDimension {
  const members = rows.map((row) => {
    const current = Number(row.current_cents ?? 0);
    const baseline = dayCount > 0 ? Number(row.baseline_sum_cents ?? 0) / dayCount : null;
    return {
      key: row.key ?? "Unknown",
      current_cents: current,
      baseline_cents: baseline,
      delta_cents: baseline === null ? null : current - baseline,
    };
  });

  const currentTotal = members.reduce((sum, m) => sum + m.current_cents, 0);
  const baselineTotal =
    dayCount > 0 ? members.reduce((sum, m) => sum + (m.baseline_cents ?? 0), 0) : null;
  const dimensionDelta = baselineTotal === null ? null : currentTotal - baselineTotal;

  const drivers: DriverMember[] = [...members]
    .sort((a, b) => Math.abs(b.delta_cents ?? 0) - Math.abs(a.delta_cents ?? 0))
    .slice(0, top)
    .map((m) => ({
      ...m,
      share_of_delta:
        dimensionDelta && dimensionDelta !== 0 && m.delta_cents !== null
          ? m.delta_cents / dimensionDelta
          : null,
    }));

  return {
    dimension,
    basis,
    current_cents: currentTotal,
    baseline_cents: baselineTotal,
    delta_cents: dimensionDelta,
    drivers,
  };
}

/** Pure: the headline net-sales summary for the day vs its same-weekday norm. */
export function summarizeHeadline(
  currentCents: number,
  baselineSumCents: number,
  dayCount: number,
): MetricDriversResult["total"] {
  const baseline = dayCount > 0 ? baselineSumCents / dayCount : null;
  const delta = baseline === null ? null : currentCents - baseline;
  const deltaPct = baseline && baseline !== 0 && delta !== null ? delta / baseline : null;
  return {
    current_cents: currentCents,
    baseline_cents: baseline,
    delta_cents: delta,
    delta_pct: deltaPct,
  };
}

function emptyResult(date: string): MetricDriversResult {
  return {
    metric: "net_sales",
    date,
    baseline: { kind: "same_weekday_4wk", dates: [], day_count: 0 },
    sufficient: false,
    total: { current_cents: 0, baseline_cents: null, delta_cents: null, delta_pct: null },
    dimensions: [],
  };
}

export async function computeMetricDrivers(
  pool: DbPool,
  opts: { merchantId: string; date?: string; top?: number },
): Promise<MetricDriversResult> {
  const top = opts.top ?? DEFAULT_TOP;

  // Resolve the target day: explicit date, else the latest day with sales. Lets the
  // model ask "why are sales low today" without knowing the exact business_date.
  let date = opts.date;
  if (!date) {
    const latest = await pool.query<{ d: string | null }>(
      `SELECT max(business_date)::text AS d FROM mart.sales_daily_mv WHERE merchant_id = $1`,
      [opts.merchantId],
    );
    date = latest.rows[0]?.d ?? undefined;
    if (!date) return emptyResult("");
  }

  const baselineDates = sameWeekdayBaselineDates(date);
  const params: [string, string, string[]] = [opts.merchantId, date, baselineDates];

  type HeadRow = {
    current_cents: string | null;
    baseline_sum_cents: string | null;
    day_count: string | null;
  };

  const [headline, orderType, tender, daypart, item] = await Promise.all([
    pool.query<HeadRow>(
      `SELECT
         sum(net_sales_cents) FILTER (WHERE business_date = $2::date)::bigint AS current_cents,
         sum(net_sales_cents) FILTER (WHERE business_date = ANY($3::date[]))::bigint AS baseline_sum_cents,
         count(DISTINCT business_date) FILTER (WHERE business_date = ANY($3::date[]))::int AS day_count
       FROM mart.sales_daily_mv
       WHERE merchant_id = $1 AND (business_date = $2::date OR business_date = ANY($3::date[]))`,
      params,
    ),
    pool.query<RawDriverRow>(
      `SELECT coalesce(ot.label, o.order_type_id, 'Unknown') AS key,
              sum(o.net_sales_cents) FILTER (WHERE o.business_date = $2::date)::bigint AS current_cents,
              sum(o.net_sales_cents) FILTER (WHERE o.business_date = ANY($3::date[]))::bigint AS baseline_sum_cents
       FROM mart.fact_orders o
       LEFT JOIN mart.dim_order_type ot
         ON ot.merchant_id = o.merchant_id AND ot.order_type_id = o.order_type_id
       WHERE o.merchant_id = $1 AND (o.business_date = $2::date OR o.business_date = ANY($3::date[]))
       GROUP BY 1`,
      params,
    ),
    pool.query<RawDriverRow>(
      `SELECT tender_type AS key,
              sum(amount_cents) FILTER (WHERE business_date = $2::date)::bigint AS current_cents,
              sum(amount_cents) FILTER (WHERE business_date = ANY($3::date[]))::bigint AS baseline_sum_cents
       FROM mart.payment_method_daily_mv
       WHERE merchant_id = $1 AND (business_date = $2::date OR business_date = ANY($3::date[]))
       GROUP BY 1`,
      params,
    ),
    pool.query<RawDriverRow>(
      `SELECT CASE
                WHEN local_hour BETWEEN 5 AND 10 THEN 'breakfast'
                WHEN local_hour BETWEEN 11 AND 14 THEN 'lunch'
                WHEN local_hour BETWEEN 17 AND 21 THEN 'dinner'
                ELSE 'offpeak'
              END AS key,
              sum(net_sales_cents) FILTER (WHERE business_date = $2::date)::bigint AS current_cents,
              sum(net_sales_cents) FILTER (WHERE business_date = ANY($3::date[]))::bigint AS baseline_sum_cents
       FROM mart.sales_hourly_mv
       WHERE merchant_id = $1 AND (business_date = $2::date OR business_date = ANY($3::date[]))
       GROUP BY 1`,
      params,
    ),
    pool.query<RawDriverRow>(
      `SELECT min(item_name) AS key,
              sum(gross_sales_cents) FILTER (WHERE business_date = $2::date)::bigint AS current_cents,
              sum(gross_sales_cents) FILTER (WHERE business_date = ANY($3::date[]))::bigint AS baseline_sum_cents
       FROM mart.item_sales_hourly_mv
       WHERE merchant_id = $1 AND (business_date = $2::date OR business_date = ANY($3::date[]))
       GROUP BY item_fingerprint`,
      params,
    ),
  ]);

  const head = headline.rows[0];
  const dayCount = head ? Number(head.day_count ?? 0) : 0;
  const currentTotal = head ? Number(head.current_cents ?? 0) : 0;
  const baselineSum = head ? Number(head.baseline_sum_cents ?? 0) : 0;

  return {
    metric: "net_sales",
    date,
    baseline: { kind: "same_weekday_4wk", dates: baselineDates, day_count: dayCount },
    sufficient: dayCount >= MIN_BASELINE_DAYS,
    total: summarizeHeadline(currentTotal, baselineSum, dayCount),
    dimensions: [
      buildDimension("daypart", "net_sales", daypart.rows, dayCount, top),
      buildDimension("order_type", "net_sales", orderType.rows, dayCount, top),
      buildDimension("tender", "payment", tender.rows, dayCount, top),
      buildDimension("item", "gross_sales", item.rows, dayCount, top),
    ],
  };
}
