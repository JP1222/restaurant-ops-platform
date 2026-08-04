-- Yield-variance mart (ADR-0031). Joins the two COGS lenses per between-count window so
-- yield_variance stays an ordinary single-base-view metric (the same shape as
-- food_cost_%): the cross-source join (inventory actual COGS x sales-side theoretical
-- COGS) has already happened here, so the metric registry needs no cross-view machinery.
--
-- Each row is one actual-COGS window (migration 019). theoretical_cogs_cents is the sum
-- of cost_daily_mv's daily theoretical COGS over the window's (period_start, period_end]
-- span -- half-open to match the inventory side, which measures consumption AFTER the
-- opening count through the closing count. yield_variance_cents = actual - theoretical:
-- positive = shrink / over-portioning / waste beyond recipe; negative = found inventory
-- or under-portioning.
--
-- business_date is the window's CLOSING count date (period_end), so the metric composer's
-- standard business_date window (ADR-0030) selects windows that CLOSED within the asked
-- range and sum() over them is the variance for that range. A window only exists once a
-- store has counted twice, so this MV is empty (honest "not connected") until then.

CREATE MATERIALIZED VIEW IF NOT EXISTS mart.cost_variance_daily_mv AS
SELECT
  ac.merchant_id,
  ac.period_end                                                                 AS business_date,
  ac.period_start,
  ac.period_end,
  ac.actual_cogs_cents                                                          AS actual_cogs_cents,
  COALESCE(sum(cd.theoretical_cogs_cents), 0)::numeric                          AS theoretical_cogs_cents,
  (ac.actual_cogs_cents - COALESCE(sum(cd.theoretical_cogs_cents), 0))::numeric AS yield_variance_cents
FROM mart.dim_actual_cogs ac
LEFT JOIN mart.cost_daily_mv cd
  ON cd.merchant_id = ac.merchant_id
 AND cd.business_date > ac.period_start
 AND cd.business_date <= ac.period_end
GROUP BY ac.merchant_id, ac.period_start, ac.period_end, ac.actual_cogs_cents
WITH NO DATA;
-- WITH NO DATA: reads cost_daily_mv, which is itself created unpopulated at migration
-- time. The mart-refresh-worker populates it on first REFRESH -- ordered AFTER
-- cost_daily_mv in the same batch so it sees the just-refreshed theoretical leg.

-- Unique index: required for any future REFRESH ... CONCURRENTLY and the natural key for
-- the metric composer's merchant_id + business_date predicates.
CREATE UNIQUE INDEX IF NOT EXISTS cost_variance_daily_mv_pk
  ON mart.cost_variance_daily_mv (merchant_id, period_end, period_start);
