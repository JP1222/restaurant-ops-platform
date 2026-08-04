-- Migration 008: mart.item_sales_hourly_mv
--
-- Per-item hourly aggregate for the Backoffice Menu Engineering drill-down.
-- Mirrors `mart.sales_hourly_mv` (aggregated by hour) and
-- `mart.item_sales_daily_mv` (per-item) but at hour granularity.
--
-- Note: `mart.fact_order_line_items` does NOT carry `local_hour`. The hour
-- bucket lives on `mart.fact_orders`, so we join on
-- (merchant_id, order_id, business_date) to pick it up.
--
-- Forward-only, idempotent (IF NOT EXISTS). Ships WITH NO DATA — the first
-- mart-refresh-worker tick populates it.

CREATE MATERIALIZED VIEW IF NOT EXISTS mart.item_sales_hourly_mv AS
SELECT li.merchant_id, li.business_date, o.local_hour, li.item_fingerprint,
       min(li.item_name) AS item_name,
       sum(li.quantity)::numeric(14,3) AS quantity,
       sum(li.gross_sales_cents)::bigint AS gross_sales_cents,
       count(*)::integer AS line_count
FROM mart.fact_order_line_items li
JOIN mart.fact_orders o
  ON o.merchant_id = li.merchant_id
 AND o.order_id    = li.order_id
 AND o.business_date = li.business_date
WHERE li.refunded = false AND o.local_hour IS NOT NULL
GROUP BY li.merchant_id, li.business_date, o.local_hour, li.item_fingerprint
WITH NO DATA;

CREATE UNIQUE INDEX IF NOT EXISTS item_sales_hourly_mv_pk
  ON mart.item_sales_hourly_mv (merchant_id, business_date, local_hour, item_fingerprint);

CREATE INDEX IF NOT EXISTS item_sales_hourly_mv_item_idx
  ON mart.item_sales_hourly_mv (merchant_id, item_fingerprint, business_date);
