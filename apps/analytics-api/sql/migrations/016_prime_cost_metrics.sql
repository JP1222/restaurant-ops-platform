-- Labor + prime cost metrics (ADR-0033, Phase 4a). Ordinary single-base-view
-- metrics over mart.prime_cost_daily_mv (migration 015): the sales + food + labor
-- legs are pre-joined there, so prime_cost_pct is the same SHAPE as food_cost_pct
-- -- no composer change. These register automatically into the AI's get_metric
-- catalog (ADR-0030), so "what's my prime cost?" is answerable with no tools.ts
-- change.
--
-- labor_cost_cents is NULL on days with no effective labor row, so each sum() is
-- NULL until labor is configured: the metrics return NULL (honest "not yet
-- connected"), never a fabricated 0. prime_cost_pct needs BOTH legs -- because
-- labor is NULL pre-config, (cogs + labor) is NULL and prime_cost_pct is NULL
-- too, which is correct: you cannot state prime cost without labor.
--
-- NRA limited-service benchmarks: labor ~ 25-35% of sales; prime <= 65%.

INSERT INTO meta.metric_definitions
  (metric_name, business_definition, sql_expression, grain, notes,
   label, measure, base_view, allowed_dimensions, allowed_filters, unit, format, synonyms)
VALUES
  ('labor_cost_cents',
   'Modeled labor cost (the store''s wage bill), in cents, summed over the window. Effective-dated reference, not a timecard feed. NULL until labor is configured -- never assumed $0.',
   'sum(labor_cost_cents)', 'merchant / day',
   'Labor leg of prime cost. NULL (not 0) when no labor rate is on file.',
   'Labor Cost', 'sum(labor_cost_cents)', 'mart.prime_cost_daily_mv',
   ARRAY['business_date'], ARRAY[]::text[], 'cents', 'currency',
   ARRAY['labor dollars','wages','payroll cost','labour cost']),

  ('labor_cost_pct',
   'Labor cost as a share of net sales. NRA limited-service labor typically runs ~25-35%. NULL until labor is configured -- never assumed $0.',
   'sum(labor_cost_cents)::numeric / nullif(sum(net_sales_cents), 0)', 'merchant / day',
   'Ratio measure: computed within each group, never summed across rows.',
   'Labor Cost %', 'sum(labor_cost_cents)::numeric / nullif(sum(net_sales_cents), 0)', 'mart.prime_cost_daily_mv',
   ARRAY['business_date'], ARRAY[]::text[], 'ratio', 'percent',
   ARRAY['labor percent','labor ratio','labour %','labor %']),

  ('prime_cost_pct',
   'Prime cost (theoretical food cost + labor cost) as a share of net sales -- the headline controllable-cost number. NRA limited-service target is <= 65%. NULL until BOTH food cost and labor are available.',
   '(sum(theoretical_cogs_cents) + sum(labor_cost_cents))::numeric / nullif(sum(net_sales_cents), 0)', 'merchant / day',
   'Ratio measure in [0,1]; requires labor to be configured (else NULL).',
   'Prime Cost %', '(sum(theoretical_cogs_cents) + sum(labor_cost_cents))::numeric / nullif(sum(net_sales_cents), 0)', 'mart.prime_cost_daily_mv',
   ARRAY['business_date'], ARRAY[]::text[], 'ratio', 'percent',
   ARRAY['prime cost','prime %','prime cost percent','prime'])
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
