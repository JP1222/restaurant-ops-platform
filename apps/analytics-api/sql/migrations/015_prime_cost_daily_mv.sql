-- Daily prime-cost mart (ADR-0033, Phase 4a). Extends cost_daily_mv (migration
-- 012) with the labor leg so labor_cost_% and prime_cost_% stay ordinary
-- single-base-view metrics (the same shape as food_cost_%) -- the cross-source
-- join (sales + food cost + labor) has already happened here, so the metric
-- registry needs no cross-base-view machinery.
--
-- Per (merchant_id, business_date):
--   net_sales_cents        = carried from cost_daily_mv (payments - refunds)
--   theoretical_cogs_cents = carried from cost_daily_mv (food leg, COALESCEd 0)
--   labor_cost_cents       = effective daily labor cost, or NULL if none on file
--
-- labor_cost_cents is intentionally NULL (NOT 0) on any day with no effective
-- dim_labor_cost row. That makes sum(labor_cost_cents) NULL until labor is
-- configured, so labor_cost_% / prime_cost_% return NULL (honest "not connected")
-- rather than a flatteringly-low number -- the labor analogue of the never-$0
-- invariant the food leg already honors.

CREATE MATERIALIZED VIEW IF NOT EXISTS mart.prime_cost_daily_mv AS
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
-- WITH NO DATA: this MV reads mart.cost_daily_mv, which is itself created
-- unpopulated at migration time. Populating eagerly would fail ("has not been
-- populated"). The mart-refresh-worker populates it on first REFRESH -- ordered
-- AFTER cost_daily_mv in the same batch so it sees the just-refreshed food leg.

-- Unique index: required for any future REFRESH ... CONCURRENTLY and the natural
-- key for the metric composer's merchant_id + business_date predicates.
CREATE UNIQUE INDEX IF NOT EXISTS prime_cost_daily_mv_pk
  ON mart.prime_cost_daily_mv (merchant_id, business_date);
