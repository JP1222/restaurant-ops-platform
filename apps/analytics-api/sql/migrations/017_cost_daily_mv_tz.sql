-- Timezone-correct plate-cost join (fixes #474, P0). ADR-0031 cost mart.
--
-- BUG: inventory-api emits dim_item_cost.effective_from as a UTC instant
-- (`new Date().toISOString()`), but mart.fact_order_line_items.business_date is
-- the STORE-LOCAL calendar date (Luxon `setZone(store_tz).toISODate()`). The
-- original migration 012 stored effective_from via `'...Z'::date`, which keeps
-- the UTC date. For a cost recorded just after UTC midnight (e.g. 19:30 CST =
-- 00:30 UTC the next day) the stored effective_from is a day AHEAD of the
-- store-local date it actually took effect, so the LATERAL JOIN
-- `c.effective_from <= li.business_date` failed for the store-local
-- "yesterday" and DROPPED that cost — silently understating theoretical COGS
-- and overstating margin every day there is a near-midnight cost change.
-- Chicago (UTC-5/-6) opens this corruption window every single day.
--
-- FIX (two parts, both in apps/analytics-api):
--   1. The ingest (src/inventory/ingest-plate-costs.ts) now converts the UTC
--      instant to the store-local date BEFORE writing effective_from, so the
--      column means "store-local effective date" — the same space as
--      business_date — and the two are directly comparable.
--   2. This migration REDEFINES mart.cost_daily_mv (and its dependent
--      mart.prime_cost_daily_mv) to make that contract explicit and durable:
--      the effective-dated plate-cost join compares two store-local dates, so a
--      sale on the store-local business date is always matched to the cost that
--      was in effect on that local day — including sales near midnight.
--
-- No column-type change: effective_from stays `date` (now interpreted as a
-- store-local date), so existing indexes, the (clover_item_id, effective_from)
-- key, and every other dim_item_cost reader (menu-engineering, prime cost) are
-- unaffected. Forward-only, like every migration here.
--
-- DROP + recreate (Postgres has no CREATE OR REPLACE MATERIALIZED VIEW).
-- prime_cost_daily_mv reads cost_daily_mv, so drop it first / recreate it after.
-- Both come back WITH NO DATA and are repopulated by mart-refresh-worker on the
-- next REFRESH batch (sales_daily_mv -> cost_daily_mv -> prime_cost_daily_mv),
-- exactly as before — see src/refresh/mv-refresh.ts.

DROP MATERIALIZED VIEW IF EXISTS mart.prime_cost_daily_mv;
DROP MATERIALIZED VIEW IF EXISTS mart.cost_daily_mv;

CREATE MATERIALIZED VIEW mart.cost_daily_mv AS
WITH line_cost AS (
  SELECT
    li.merchant_id,
    li.business_date,
    li.quantity,
    li.gross_sales_cents,
    pc.plate_cost_cents
  FROM mart.fact_order_line_items li
  LEFT JOIN LATERAL (
    SELECT c.plate_cost_cents
    FROM mart.dim_item_cost c
    WHERE c.clover_item_id = li.item_id
      -- Both sides are STORE-LOCAL calendar dates (#474): effective_from is the
      -- store-local date the cost took effect (normalized at ingest), so a line
      -- on business_date D is priced at the latest cost effective on or before D
      -- in store-local terms — never dropped because of a UTC date skew.
      AND c.effective_from <= li.business_date
    ORDER BY c.effective_from DESC
    LIMIT 1
  ) pc ON true
  WHERE li.item_id IS NOT NULL
    AND li.refunded = false
),
cogs AS (
  SELECT
    merchant_id,
    business_date,
    sum(quantity * plate_cost_cents)
      FILTER (WHERE plate_cost_cents IS NOT NULL) AS theoretical_cogs_cents,
    sum(gross_sales_cents)
      FILTER (WHERE plate_cost_cents IS NOT NULL) AS costed_gross_sales_cents,
    sum(gross_sales_cents) AS total_gross_sales_cents
  FROM line_cost
  GROUP BY merchant_id, business_date
)
SELECT
  s.merchant_id,
  s.business_date,
  s.net_sales_cents,
  COALESCE(c.theoretical_cogs_cents, 0)::numeric  AS theoretical_cogs_cents,
  COALESCE(c.costed_gross_sales_cents, 0)::bigint AS costed_gross_sales_cents,
  COALESCE(c.total_gross_sales_cents, 0)::bigint  AS total_gross_sales_cents
FROM mart.sales_daily_mv s
LEFT JOIN cogs c
  ON c.merchant_id = s.merchant_id
 AND c.business_date = s.business_date
WITH NO DATA;

CREATE UNIQUE INDEX IF NOT EXISTS cost_daily_mv_pk
  ON mart.cost_daily_mv (merchant_id, business_date);

-- Recreate the prime-cost mart unchanged from migration 015 (it only reads
-- cost_daily_mv + dim_labor_cost); it was dropped above as a dependent.
CREATE MATERIALIZED VIEW mart.prime_cost_daily_mv AS
SELECT
  cd.merchant_id,
  cd.business_date,
  cd.net_sales_cents,
  cd.theoretical_cogs_cents,
  lc.daily_labor_cost_cents AS labor_cost_cents
FROM mart.cost_daily_mv cd
LEFT JOIN LATERAL (
  SELECT l.daily_labor_cost_cents
  FROM mart.dim_labor_cost l
  WHERE l.merchant_id = cd.merchant_id
    AND l.effective_from <= cd.business_date
  ORDER BY l.effective_from DESC
  LIMIT 1
) lc ON true
WITH NO DATA;

CREATE UNIQUE INDEX IF NOT EXISTS prime_cost_daily_mv_pk
  ON mart.prime_cost_daily_mv (merchant_id, business_date);
