import type { DbPool } from "../db.js";

/**
 * GET /admin/api/trends/breakdown?from=&to= — segment mix for the Trends page
 * (order type / tender / daypart) over a date range. Each dimension is one bounded,
 * per-merchant aggregate over an EXISTING mart (no new MV; a consolidated all-stores
 * variant is the multi-location follow-up): order type from
 * fact_orders ⋈ dim_order_type (same 2-table shape as top items), tender from
 * payment_method_daily_mv, daypart from sales_hourly_mv bucketed by local_hour. The
 * BFF turns these totals into shares; the buckets mirror the Backoffice dayparts
 * page (breakfast 5-10, lunch 11-14, dinner 17-21, else off-peak).
 */

export interface BreakdownRow {
  /** order-type label, tender_type, or daypart key (offpeak/breakfast/lunch/dinner). */
  key: string;
  /** net sales for order type / daypart; payment amount for tender. Integer cents. */
  value_cents: number;
  /** order count (order type / daypart) or payment count (tender). */
  count: number;
}

export interface TrendsBreakdownResponse {
  from: string;
  to: string;
  order_type: BreakdownRow[];
  tender: BreakdownRow[];
  daypart: BreakdownRow[];
}

// Canonical daypart order so the stacked bar reads chronologically, not by size.
const DAYPART_ORDER = ["breakfast", "lunch", "dinner", "offpeak"];

function toRows(rows: { key: string | null; value_cents: string; count: string }[]): BreakdownRow[] {
  return rows.map((row) => ({
    key: row.key ?? "Unknown",
    value_cents: Number(row.value_cents),
    count: Number(row.count)
  }));
}

export async function trendsBreakdown(
  pool: DbPool,
  merchantId: string,
  from: string,
  to: string
): Promise<TrendsBreakdownResponse> {
  type Row = { key: string | null; value_cents: string; count: string };

  const [orderType, tender, daypart] = await Promise.all([
    pool.query<Row>(
      `SELECT coalesce(ot.label, o.order_type_id, 'Unknown') AS key,
              sum(o.net_sales_cents)::bigint AS value_cents,
              count(*)::bigint AS count
       FROM mart.fact_orders o
       LEFT JOIN mart.dim_order_type ot
         ON ot.merchant_id = o.merchant_id AND ot.order_type_id = o.order_type_id
       WHERE o.merchant_id = $1 AND o.business_date BETWEEN $2 AND $3
       GROUP BY 1
       ORDER BY value_cents DESC`,
      [merchantId, from, to]
    ),
    pool.query<Row>(
      `SELECT tender_type AS key,
              sum(amount_cents)::bigint AS value_cents,
              sum(payment_count)::bigint AS count
       FROM mart.payment_method_daily_mv
       WHERE merchant_id = $1 AND business_date BETWEEN $2 AND $3
       GROUP BY 1
       ORDER BY value_cents DESC`,
      [merchantId, from, to]
    ),
    pool.query<Row>(
      `SELECT CASE
                WHEN local_hour BETWEEN 5 AND 10 THEN 'breakfast'
                WHEN local_hour BETWEEN 11 AND 14 THEN 'lunch'
                WHEN local_hour BETWEEN 17 AND 21 THEN 'dinner'
                ELSE 'offpeak'
              END AS key,
              sum(net_sales_cents)::bigint AS value_cents,
              sum(order_count)::bigint AS count
       FROM mart.sales_hourly_mv
       WHERE merchant_id = $1 AND business_date BETWEEN $2 AND $3
       GROUP BY 1`,
      [merchantId, from, to]
    )
  ]);

  const daypartRows = toRows(daypart.rows).sort(
    (a, b) => DAYPART_ORDER.indexOf(a.key) - DAYPART_ORDER.indexOf(b.key)
  );

  return {
    from,
    to,
    order_type: toRows(orderType.rows),
    tender: toRows(tender.rows),
    daypart: daypartRows
  };
}
