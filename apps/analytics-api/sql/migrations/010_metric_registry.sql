-- Metric registry: promote meta.metric_definitions from documentation into an
-- executable, governed grounding contract (ADR-0030, Phase 0b). A metric is a
-- dev-authored definition the registry composes into deterministic SQL; the AI
-- (and dashboards) ask for a metric BY NAME instead of authoring free SQL.
--
-- Forward-only and non-destructive: we ADD structured columns and keep the
-- existing business_definition / sql_expression / grain / notes untouched, so
-- any existing reader of the prose columns still works. The registry loader
-- (src/analytics/metric-registry.ts) reads rows where measure + base_view are set.
--
-- Cross-base-view composition (e.g. food_cost_% = item-level cost / daily net
-- sales) is intentionally NOT modeled here — every metric below is one aggregate
-- expression over one base view. That extension lands with ADR-0031.

ALTER TABLE meta.metric_definitions
  ADD COLUMN IF NOT EXISTS label              text,
  ADD COLUMN IF NOT EXISTS measure            text,
  ADD COLUMN IF NOT EXISTS base_view          text,
  ADD COLUMN IF NOT EXISTS allowed_dimensions text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS allowed_filters    text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS unit               text,
  ADD COLUMN IF NOT EXISTS format             text,
  ADD COLUMN IF NOT EXISTS synonyms           text[] NOT NULL DEFAULT '{}';

-- Re-seed the core revenue metrics in structured form. measure is a SQL
-- aggregate over base_view; allowed_dimensions/filters are the ONLY identifiers
-- the composer will interpolate (everything caller-supplied is parameterized).
-- These cover the tools.ts Metric enum (net_sales, orders, avg_ticket, refund_rate)
-- so the get_metric() path (Phase 0b-3) maps cleanly.
INSERT INTO meta.metric_definitions
  (metric_name, business_definition, sql_expression, grain, notes,
   label, measure, base_view, allowed_dimensions, allowed_filters, unit, format, synonyms)
VALUES
  ('net_sales_cents', 'Payment total minus refunds, in cents.',
   'sum(net_sales_cents)', 'order / day', 'Base view already rolls this up per business_date.',
   'Net Sales', 'sum(net_sales_cents)', 'mart.sales_daily_mv',
   ARRAY['business_date'], ARRAY[]::text[], 'cents', 'currency', ARRAY['revenue','sales','takings']),

  ('order_count', 'Number of orders.',
   'sum(order_count)', 'order / day', NULL,
   'Orders', 'sum(order_count)', 'mart.sales_daily_mv',
   ARRAY['business_date'], ARRAY[]::text[], 'count', 'number', ARRAY['orders','tickets','transactions']),

  ('avg_ticket_cents', 'Net sales divided by order count, in cents.',
   'sum(net_sales_cents)::numeric / nullif(sum(order_count), 0)', 'order / day',
   'Ratio measure: computed within each group, never summed across rows.',
   'Average Ticket', 'sum(net_sales_cents)::numeric / nullif(sum(order_count), 0)', 'mart.sales_daily_mv',
   ARRAY['business_date'], ARRAY[]::text[], 'ratio', 'currency', ARRAY['average check','avg ticket','ticket size']),

  ('refund_rate', 'Refund total divided by payment total.',
   'sum(refund_total_cents)::numeric / nullif(sum(payment_total_cents), 0)', 'order / day',
   'Ratio measure in [0,1]; format as percent.',
   'Refund Rate', 'sum(refund_total_cents)::numeric / nullif(sum(payment_total_cents), 0)', 'mart.sales_daily_mv',
   ARRAY['business_date'], ARRAY[]::text[], 'ratio', 'percent', ARRAY['refund %','refund ratio']),

  ('payment_total_cents', 'Successful captured payments, in cents.',
   'sum(payment_total_cents)', 'payment / day', NULL,
   'Payments', 'sum(payment_total_cents)', 'mart.sales_daily_mv',
   ARRAY['business_date'], ARRAY[]::text[], 'cents', 'currency', ARRAY['gross payments']),

  ('refund_total_cents', 'Refund amounts, in cents.',
   'sum(refund_total_cents)', 'refund / day', NULL,
   'Refunds', 'sum(refund_total_cents)', 'mart.sales_daily_mv',
   ARRAY['business_date'], ARRAY[]::text[], 'cents', 'currency', ARRAY['refunds']),

  ('tip_cents', 'Tips captured on payments, in cents.',
   'sum(tip_total_cents)', 'payment / day', 'Column is tip_total_cents on the daily view.',
   'Tips', 'sum(tip_total_cents)', 'mart.sales_daily_mv',
   ARRAY['business_date'], ARRAY[]::text[], 'cents', 'currency', ARRAY['gratuity','tips']),

  ('gross_sales_cents', 'Line-item sales before refunds, in cents.',
   'sum(gross_sales_cents)', 'line item / day', 'Item-level view; sum by business_date for the daily total.',
   'Gross Sales', 'sum(gross_sales_cents)', 'mart.item_sales_daily_mv',
   ARRAY['business_date'], ARRAY[]::text[], 'cents', 'currency', ARRAY['gross revenue']),

  ('cash_sales_cents', 'Payments where normalized tender type is CASH, in cents.',
   'sum(amount_cents) filter (where tender_type = ''CASH'')', 'payment / day', 'Uses payment_method_daily_mv.',
   'Cash Sales', 'sum(amount_cents) filter (where tender_type = ''CASH'')', 'mart.payment_method_daily_mv',
   ARRAY['business_date'], ARRAY[]::text[], 'cents', 'currency', ARRAY['cash']),

  ('credit_card_sales_cents', 'Payments where normalized tender type is CREDIT_CARD, in cents.',
   'sum(amount_cents) filter (where tender_type = ''CREDIT_CARD'')', 'payment / day', 'Uses payment_method_daily_mv.',
   'Card Sales', 'sum(amount_cents) filter (where tender_type = ''CREDIT_CARD'')', 'mart.payment_method_daily_mv',
   ARRAY['business_date'], ARRAY[]::text[], 'cents', 'currency', ARRAY['credit card','card'])
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
