-- food_cost_pct / gross_margin_pct read a flattering 0% / 100% on a day that has
-- sales but NO costed items (#457). cost_daily_mv stores theoretical_cogs_cents = 0
-- (not NULL) for an un-costed day, so the ratio resolves to cogs / net_sales =
-- 0 / sales = 0% food cost and 100% margin — which looks like an unbeatable food
-- cost when the truth is "we have no recipe data for this day."
--
-- Fix at the metric layer (the registry executes the `measure` column —
-- src/analytics/metric-registry.ts builds `SELECT <measure> AS value`), NOT in the
-- MV: leaving cost_daily_mv untouched keeps cost_coverage_pct's honest 0% (it
-- legitimately reads costed_gross_sales_cents = 0) and avoids a DROP/recreate of
-- cost_daily_mv + its dependents (prime_cost_daily_mv, cost_variance_daily_mv).
--
-- Gate both ratios on costed coverage: when NO item sold in the group had a plate
-- cost (sum(costed_gross_sales_cents) = 0), theoretical COGS is unknown, so resolve
-- to NULL ("no data") instead of 0. A mixed day (some items costed) is unchanged —
-- it still computes the ratio, gated in the UI by cost_coverage_pct. Keep
-- sql_expression in lockstep with measure (it is the AI-grounding mirror).
-- Forward-only UPDATE.

UPDATE meta.metric_definitions
SET measure = 'CASE WHEN sum(costed_gross_sales_cents) > 0 THEN sum(theoretical_cogs_cents)::numeric / nullif(sum(net_sales_cents), 0) END',
    sql_expression = 'CASE WHEN sum(costed_gross_sales_cents) > 0 THEN sum(theoretical_cogs_cents)::numeric / nullif(sum(net_sales_cents), 0) END',
    updated_at = now()
WHERE metric_name = 'food_cost_pct';

UPDATE meta.metric_definitions
SET measure = 'CASE WHEN sum(costed_gross_sales_cents) > 0 THEN (sum(net_sales_cents) - sum(theoretical_cogs_cents))::numeric / nullif(sum(net_sales_cents), 0) END',
    sql_expression = 'CASE WHEN sum(costed_gross_sales_cents) > 0 THEN (sum(net_sales_cents) - sum(theoretical_cogs_cents))::numeric / nullif(sum(net_sales_cents), 0) END',
    updated_at = now()
WHERE metric_name = 'gross_margin_pct';
