-- Actual COGS + yield variance metrics (ADR-0031). Ordinary single-base-view metrics
-- over mart.cost_variance_daily_mv (migration 020), where actual (inventory) and
-- theoretical (sales-side) COGS are already joined per window -- so no composer change.
-- They register into the AI's get_metric catalog (ADR-0030) automatically, so "what's my
-- yield variance / shrink?" is answerable with no tools.ts change.
--
-- Both are NULL until the store has counted twice (no window exists, the MV is empty), so
-- the Cost dashboard's Yield-variance card stays in its honest "not connected" state
-- rather than showing a fabricated 0. yield_variance_cents can be negative (found
-- inventory / under-portioning), which is meaningful, not an error.

INSERT INTO meta.metric_definitions
  (metric_name, business_definition, sql_expression, grain, notes,
   label, measure, base_view, allowed_dimensions, allowed_filters, unit, format, synonyms)
VALUES
  ('actual_cogs_cents',
   'Actual cost of goods sold from physical inventory counts: beginning + received - ending inventory value, valued at current item cost, summed over the counted windows in range. The inventory-measured counterpart to theoretical food_cost_cents.',
   'sum(actual_cogs_cents)', 'merchant / count-window',
   'Count-based actual COGS from inventory (ADR-0031). Pairs with food_cost_cents (theoretical) for yield variance. NULL until two counts bound a window.',
   'Actual COGS', 'sum(actual_cogs_cents)', 'mart.cost_variance_daily_mv',
   ARRAY['business_date'], ARRAY[]::text[], 'cents', 'currency',
   ARRAY['actual cogs','counted cogs','inventory cogs','real cost of goods']),

  ('yield_variance_cents',
   'Actual COGS minus theoretical COGS over the counted windows in range, in cents. Positive = shrink, waste, or over-portioning beyond recipe; negative = found inventory or under-portioning. The signal in the gap between what recipes say you should have used and what inventory says you did.',
   'sum(yield_variance_cents)', 'merchant / count-window',
   'Cross-source variance: inventory actual vs recipe-based theoretical. NULL until a counted window exists.',
   'Yield Variance', 'sum(yield_variance_cents)', 'mart.cost_variance_daily_mv',
   ARRAY['business_date'], ARRAY[]::text[], 'cents', 'currency',
   ARRAY['yield variance','shrink','shrinkage','waste vs theoretical','cost variance'])
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
