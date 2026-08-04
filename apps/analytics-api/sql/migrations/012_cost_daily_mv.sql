-- Daily cost mart for profitability analytics (ADR-0031, Phase 2). Pre-joins
-- the cross-source inputs for food-cost % / gross-margin so the metric registry
-- can keep treating each cost metric as ONE aggregate over ONE base view (the
-- same shape as avg_ticket_cents) instead of growing cross-base-view machinery.
-- Migration 010 deferred exactly this ("that extension lands with ADR-0031").
--
-- Per (merchant_id, business_date):
--   theoretical_cogs_cents   = Σ(quantity × effective plate cost) for COSTED lines
--   costed_gross_sales_cents = gross sales of lines that HAVE a plate cost
--   total_gross_sales_cents  = gross sales of ALL lines (coverage denominator)
--   net_sales_cents          = from sales_daily_mv (payments − refunds)
--
-- Coverage = costed_gross / total_gross lets the dashboard tell the operator how
-- much of the menu is costed, so a partially-costed catalog never masquerades as
-- a flatteringly-low food cost % (the aggregate form of invariant #6: missing
-- cost is never $0).
--
-- Plate cost is effective-dated: each line is priced at the latest
-- dim_item_cost.effective_from <= its business_date, so a price change never
-- rewrites past margins. Refunded lines are excluded from COGS and costed/total
-- gross to stay consistent with net-of-refund sales.

CREATE MATERIALIZED VIEW IF NOT EXISTS mart.cost_daily_mv AS
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
-- WITH NO DATA: this MV reads mart.sales_daily_mv, which is itself created
-- unpopulated at migration time. Populating eagerly here would fail ("has not
-- been populated"). The mart-refresh-worker (and tests) populate it on first
-- REFRESH, same as every other MV in this schema.

-- Unique index: required for any future REFRESH ... CONCURRENTLY, and the natural
-- key for the metric composer's merchant_id + business_date predicates.
CREATE UNIQUE INDEX IF NOT EXISTS cost_daily_mv_pk
  ON mart.cost_daily_mv (merchant_id, business_date);
