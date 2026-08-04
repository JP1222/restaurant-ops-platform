-- Distribution + loss-visibility metrics (roadmap Phase 5, the statistical-depth
-- slice). The existing avg_ticket_cents is a MEAN over the daily rollup; a few large
-- catering orders pull it away from the typical guest's ticket. median/p90 give the
-- distribution the mean hides, so they read PER ORDER over mart.fact_orders rather
-- than over the daily MV. percentile_cont is the standard continuous percentile
-- (interpolates), and the composer interpolates the dev-authored measure verbatim, so
-- no composer change is needed -- the same shape as any other registry metric.
--
-- discount_total_cents surfaces gross discount given as a first-class metric (the MV
-- already carries the column) so discounting shows up as a tracked loss lens, not just
-- a column buried in a handler payload.

INSERT INTO meta.metric_definitions
  (metric_name, business_definition, sql_expression, grain, notes,
   label, measure, base_view, allowed_dimensions, allowed_filters, unit, format, synonyms)
VALUES
  ('median_ticket_cents',
   'Median order net sales (50th percentile), in cents. The typical ticket -- robust to the few large orders that skew the mean (avg_ticket_cents).',
   'percentile_cont(0.5) within group (order by net_sales_cents)', 'order',
   'Per-order percentile over mart.fact_orders, not the daily MV: a percentile cannot be recovered from a pre-aggregated daily row.',
   'Median Ticket', 'percentile_cont(0.5) within group (order by net_sales_cents)', 'mart.fact_orders',
   ARRAY['business_date'], ARRAY[]::text[], 'cents', 'currency',
   ARRAY['median ticket','median check','p50 ticket','typical ticket']),

  ('p90_ticket_cents',
   '90th-percentile order net sales, in cents. The top end of the ticket distribution -- 1 in 10 orders is at least this large.',
   'percentile_cont(0.9) within group (order by net_sales_cents)', 'order',
   'Per-order percentile over mart.fact_orders. Read with median_ticket_cents to see the spread of ticket sizes.',
   'P90 Ticket', 'percentile_cont(0.9) within group (order by net_sales_cents)', 'mart.fact_orders',
   ARRAY['business_date'], ARRAY[]::text[], 'cents', 'currency',
   ARRAY['p90 ticket','90th percentile ticket','large ticket','top decile ticket']),

  ('discount_total_cents',
   'Total discount given, in cents. A loss-visibility lens: how much was discounted off gross before tax over the period.',
   'sum(discount_total_cents)', 'merchant / day',
   'Already rolled up per business_date in the MV.',
   'Discounts Given', 'sum(discount_total_cents)', 'mart.sales_daily_mv',
   ARRAY['business_date'], ARRAY[]::text[], 'cents', 'currency',
   ARRAY['discounts','discount dollars','markdowns','comps given'])
ON CONFLICT (metric_name) DO UPDATE SET
  business_definition = EXCLUDED.business_definition,
  sql_expression      = EXCLUDED.sql_expression,
  grain               = EXCLUDED.grain,
  notes               = EXCLUDED.notes,
  label               = EXCLUDED.label,
  measure             = EXCLUDED.measure,
  base_view           = EXCLUDED.base_view,
  allowed_dimensions  = EXCLUDED.allowed_dimensions,
  allowed_filters     = EXCLUDED.allowed_filters,
  unit                = EXCLUDED.unit,
  format              = EXCLUDED.format,
  synonyms            = EXCLUDED.synonyms,
  updated_at          = now();
