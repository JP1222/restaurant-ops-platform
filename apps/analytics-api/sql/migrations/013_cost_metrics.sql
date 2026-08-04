-- Cost metrics for the profitability dashboard (ADR-0031, Phase 2). These are
-- ordinary single-base-view metrics over mart.cost_daily_mv (migration 012) --
-- the cross-source join already happened in the MV, so food_cost_pct is the
-- same SHAPE as the existing avg_ticket_cents ratio: no composer change needed.
--
-- food_cost_pct uses the CANONICAL denominator (net sales), so it is directly
-- comparable to the NRA limited-service median of 32.4%. It is only as complete
-- as recipe coverage, so cost_coverage_pct ships alongside it: the dashboard
-- gates the green/amber/red benchmark band on coverage rather than flashing a
-- flatteringly-low number while the catalog is half-costed.

INSERT INTO meta.metric_definitions
  (metric_name, business_definition, sql_expression, grain, notes,
   label, measure, base_view, allowed_dimensions, allowed_filters, unit, format, synonyms)
VALUES
  ('food_cost_cents',
   'Theoretical cost of goods sold: sum of units sold x plate cost, in cents. Only items with a recipe on file; un-costed items are never assumed to cost $0.',
   'sum(theoretical_cogs_cents)', 'merchant / day',
   'Theoretical (sales-side) COGS. Pairs with inventory actual COGS for yield variance.',
   'Food Cost', 'sum(theoretical_cogs_cents)', 'mart.cost_daily_mv',
   ARRAY['business_date'], ARRAY[]::text[], 'cents', 'currency',
   ARRAY['cogs','cost of goods','food cost dollars','theoretical cost']),

  ('food_cost_pct',
   'Theoretical food cost as a share of net sales. Canonical denominator (net sales) so it compares to the NRA limited-service median of 32.4%. Only trustworthy as recipe coverage approaches 100% -- read alongside cost_coverage_pct.',
   'sum(theoretical_cogs_cents)::numeric / nullif(sum(net_sales_cents), 0)', 'merchant / day',
   'Ratio measure: computed within each group, never summed across rows.',
   'Food Cost %', 'sum(theoretical_cogs_cents)::numeric / nullif(sum(net_sales_cents), 0)', 'mart.cost_daily_mv',
   ARRAY['business_date'], ARRAY[]::text[], 'ratio', 'percent',
   ARRAY['food cost percent','food cost ratio','fc%','food cost %']),

  ('gross_margin_pct',
   'Net sales minus theoretical food cost, as a share of net sales. The flip side of food cost % (gross_margin_% = 1 - food_cost_%).',
   '(sum(net_sales_cents) - sum(theoretical_cogs_cents))::numeric / nullif(sum(net_sales_cents), 0)', 'merchant / day',
   'Ratio measure in [0,1]; format as percent.',
   'Gross Margin %', '(sum(net_sales_cents) - sum(theoretical_cogs_cents))::numeric / nullif(sum(net_sales_cents), 0)', 'mart.cost_daily_mv',
   ARRAY['business_date'], ARRAY[]::text[], 'ratio', 'percent',
   ARRAY['gross margin','margin %','gm%']),

  ('cost_coverage_pct',
   'Share of item sales (by gross) that have a plate cost on file. Tells you how complete the recipe catalog is; food_cost_% is only reliable as this approaches 100%.',
   'sum(costed_gross_sales_cents)::numeric / nullif(sum(total_gross_sales_cents), 0)', 'merchant / day',
   'Ratio measure in [0,1]; the dashboard gates the food-cost benchmark band on this.',
   'Recipe Cost Coverage', 'sum(costed_gross_sales_cents)::numeric / nullif(sum(total_gross_sales_cents), 0)', 'mart.cost_daily_mv',
   ARRAY['business_date'], ARRAY[]::text[], 'ratio', 'percent',
   ARRAY['recipe coverage','cost coverage','costed share','catalog coverage'])
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
