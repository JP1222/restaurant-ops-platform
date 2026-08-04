CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE SCHEMA IF NOT EXISTS raw;
CREATE SCHEMA IF NOT EXISTS staging;
CREATE SCHEMA IF NOT EXISTS mart;
CREATE SCHEMA IF NOT EXISTS audit;
CREATE SCHEMA IF NOT EXISTS meta;

CREATE TABLE IF NOT EXISTS audit.schema_migrations (
  version text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit.backfill_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id text NOT NULL,
  mode text NOT NULL CHECK (mode IN ('sample', 'full', 'custom')),
  range_start timestamptz NOT NULL,
  range_end timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'completed', 'failed')),
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  error_message text,
  options jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS audit.backfill_windows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES audit.backfill_runs(id) ON DELETE CASCADE,
  merchant_id text NOT NULL,
  window_start timestamptz NOT NULL,
  window_end timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'completed', 'failed', 'skipped')),
  orders_export_id text,
  payments_export_id text,
  order_count integer NOT NULL DEFAULT 0,
  payment_count integer NOT NULL DEFAULT 0,
  refund_count integer NOT NULL DEFAULT 0,
  started_at timestamptz,
  completed_at timestamptz,
  error_message text,
  UNIQUE (merchant_id, window_start, window_end, run_id)
);

CREATE INDEX IF NOT EXISTS backfill_windows_run_status_idx
  ON audit.backfill_windows (run_id, status, window_start);

CREATE TABLE IF NOT EXISTS audit.ai_query_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor text,
  question text,
  sql_text text NOT NULL,
  row_count integer,
  elapsed_ms integer,
  rejected boolean NOT NULL DEFAULT false,
  rejection_reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS raw.clover_exports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id text NOT NULL,
  export_id text NOT NULL,
  export_type text NOT NULL CHECK (export_type IN ('ORDERS', 'PAYMENTS')),
  window_start timestamptz NOT NULL,
  window_end timestamptz NOT NULL,
  status text NOT NULL,
  percent_complete integer,
  available_until timestamptz,
  export_urls jsonb NOT NULL DEFAULT '[]'::jsonb,
  local_paths jsonb NOT NULL DEFAULT '[]'::jsonb,
  sha256 text,
  byte_size bigint,
  row_count integer NOT NULL DEFAULT 0,
  raw_export jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (merchant_id, export_id)
);

CREATE INDEX IF NOT EXISTS clover_exports_window_idx
  ON raw.clover_exports (merchant_id, export_type, window_start, window_end);

CREATE TABLE IF NOT EXISTS raw.clover_orders (
  merchant_id text NOT NULL,
  order_id text NOT NULL,
  payload jsonb NOT NULL,
  source text NOT NULL DEFAULT 'export',
  raw_export_id uuid REFERENCES raw.clover_exports(id) ON DELETE SET NULL,
  window_start timestamptz,
  window_end timestamptz,
  created_time_utc timestamptz,
  modified_time_utc timestamptz,
  imported_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (merchant_id, order_id)
);

CREATE INDEX IF NOT EXISTS clover_orders_created_idx
  ON raw.clover_orders (merchant_id, created_time_utc);

CREATE INDEX IF NOT EXISTS clover_orders_payload_gin_idx
  ON raw.clover_orders USING gin (payload);

CREATE TABLE IF NOT EXISTS raw.clover_payments (
  merchant_id text NOT NULL,
  payment_id text NOT NULL,
  payload jsonb NOT NULL,
  source text NOT NULL DEFAULT 'export',
  raw_export_id uuid REFERENCES raw.clover_exports(id) ON DELETE SET NULL,
  window_start timestamptz,
  window_end timestamptz,
  created_time_utc timestamptz,
  imported_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (merchant_id, payment_id)
);

CREATE INDEX IF NOT EXISTS clover_payments_created_idx
  ON raw.clover_payments (merchant_id, created_time_utc);

CREATE INDEX IF NOT EXISTS clover_payments_payload_gin_idx
  ON raw.clover_payments USING gin (payload);

CREATE TABLE IF NOT EXISTS raw.clover_refunds (
  merchant_id text NOT NULL,
  refund_id text NOT NULL,
  payment_id text,
  order_id text,
  payload jsonb NOT NULL,
  source text NOT NULL DEFAULT 'rest',
  created_time_utc timestamptz,
  imported_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (merchant_id, refund_id)
);

CREATE INDEX IF NOT EXISTS clover_refunds_created_idx
  ON raw.clover_refunds (merchant_id, created_time_utc);

CREATE TABLE IF NOT EXISTS raw.clover_tenders (
  merchant_id text NOT NULL,
  tender_id text NOT NULL,
  payload jsonb NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (merchant_id, tender_id)
);

CREATE TABLE IF NOT EXISTS raw.clover_employees (
  merchant_id text NOT NULL,
  employee_id text NOT NULL,
  payload jsonb NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (merchant_id, employee_id)
);

CREATE TABLE IF NOT EXISTS raw.clover_order_types (
  merchant_id text NOT NULL,
  order_type_id text NOT NULL,
  payload jsonb NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (merchant_id, order_type_id)
);

CREATE TABLE IF NOT EXISTS mart.dim_calendar (
  business_date date PRIMARY KEY,
  year integer NOT NULL,
  quarter integer NOT NULL,
  month integer NOT NULL,
  day_of_month integer NOT NULL,
  iso_week integer NOT NULL,
  weekday integer NOT NULL,
  weekday_name text NOT NULL,
  is_weekend boolean NOT NULL,
  year_month text NOT NULL
);

CREATE TABLE IF NOT EXISTS mart.dim_employee (
  merchant_id text NOT NULL,
  employee_id text NOT NULL,
  display_name text,
  raw jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (merchant_id, employee_id)
);

CREATE TABLE IF NOT EXISTS mart.dim_tender (
  merchant_id text NOT NULL,
  tender_id text NOT NULL,
  tender_label text,
  tender_type text NOT NULL CHECK (tender_type IN ('CASH', 'CREDIT_CARD', 'GIFT_CARD', 'OTHER', 'UNKNOWN')),
  raw jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (merchant_id, tender_id)
);

CREATE TABLE IF NOT EXISTS mart.dim_order_type (
  merchant_id text NOT NULL,
  order_type_id text NOT NULL,
  label text,
  raw jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (merchant_id, order_type_id)
);

CREATE TABLE IF NOT EXISTS mart.dim_item (
  merchant_id text NOT NULL,
  item_fingerprint text NOT NULL,
  item_id text,
  item_name text NOT NULL,
  alternate_name text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (merchant_id, item_fingerprint)
);

CREATE TABLE IF NOT EXISTS mart.fact_orders (
  merchant_id text NOT NULL,
  order_id text NOT NULL,
  business_date date NOT NULL,
  created_at_utc timestamptz,
  modified_at_utc timestamptz,
  local_hour smallint,
  weekday smallint,
  year_month text,
  iso_week integer,
  employee_id text,
  order_type_id text,
  order_label text,
  payment_state text,
  order_state text,
  currency text,
  order_total_cents integer NOT NULL DEFAULT 0,
  payment_total_cents integer NOT NULL DEFAULT 0,
  refund_total_cents integer NOT NULL DEFAULT 0,
  net_sales_cents integer NOT NULL DEFAULT 0,
  tax_total_cents integer NOT NULL DEFAULT 0,
  tip_total_cents integer NOT NULL DEFAULT 0,
  discount_total_cents integer NOT NULL DEFAULT 0,
  line_item_count integer NOT NULL DEFAULT 0,
  raw_updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (merchant_id, order_id, business_date)
) PARTITION BY RANGE (business_date);

CREATE TABLE IF NOT EXISTS mart.fact_orders_default
  PARTITION OF mart.fact_orders DEFAULT;

CREATE INDEX IF NOT EXISTS fact_orders_date_idx
  ON mart.fact_orders (business_date, merchant_id);

CREATE INDEX IF NOT EXISTS fact_orders_employee_idx
  ON mart.fact_orders (merchant_id, employee_id, business_date);

CREATE TABLE IF NOT EXISTS mart.fact_order_line_items (
  merchant_id text NOT NULL,
  order_id text NOT NULL,
  line_item_fingerprint text NOT NULL,
  line_item_id text,
  business_date date NOT NULL,
  created_at_utc timestamptz,
  item_fingerprint text NOT NULL,
  item_id text,
  item_name text NOT NULL,
  quantity numeric(12, 3) NOT NULL DEFAULT 1,
  unit_price_cents integer NOT NULL DEFAULT 0,
  modifier_total_cents integer NOT NULL DEFAULT 0,
  gross_sales_cents integer NOT NULL DEFAULT 0,
  discount_total_cents integer NOT NULL DEFAULT 0,
  tax_total_cents integer NOT NULL DEFAULT 0,
  refunded boolean NOT NULL DEFAULT false,
  modifiers jsonb NOT NULL DEFAULT '[]'::jsonb,
  raw jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (merchant_id, order_id, line_item_fingerprint, business_date)
) PARTITION BY RANGE (business_date);

CREATE TABLE IF NOT EXISTS mart.fact_order_line_items_default
  PARTITION OF mart.fact_order_line_items DEFAULT;

CREATE INDEX IF NOT EXISTS fact_line_items_item_date_idx
  ON mart.fact_order_line_items (merchant_id, item_fingerprint, business_date);

CREATE TABLE IF NOT EXISTS mart.fact_payments (
  merchant_id text NOT NULL,
  payment_id text NOT NULL,
  business_date date NOT NULL,
  order_id text,
  created_at_utc timestamptz,
  local_hour smallint,
  weekday smallint,
  year_month text,
  iso_week integer,
  employee_id text,
  tender_id text,
  tender_type text NOT NULL CHECK (tender_type IN ('CASH', 'CREDIT_CARD', 'GIFT_CARD', 'OTHER', 'UNKNOWN')),
  payment_result text,
  currency text,
  amount_cents integer NOT NULL DEFAULT 0,
  tip_cents integer NOT NULL DEFAULT 0,
  tax_cents integer NOT NULL DEFAULT 0,
  PRIMARY KEY (merchant_id, payment_id, business_date)
) PARTITION BY RANGE (business_date);

CREATE TABLE IF NOT EXISTS mart.fact_payments_default
  PARTITION OF mart.fact_payments DEFAULT;

CREATE INDEX IF NOT EXISTS fact_payments_date_tender_idx
  ON mart.fact_payments (merchant_id, business_date, tender_type);

CREATE TABLE IF NOT EXISTS mart.fact_refunds (
  merchant_id text NOT NULL,
  refund_id text NOT NULL,
  business_date date NOT NULL,
  payment_id text,
  order_id text,
  created_at_utc timestamptz,
  local_hour smallint,
  weekday smallint,
  year_month text,
  iso_week integer,
  employee_id text,
  amount_cents integer NOT NULL DEFAULT 0,
  tax_cents integer NOT NULL DEFAULT 0,
  reason text,
  PRIMARY KEY (merchant_id, refund_id, business_date)
) PARTITION BY RANGE (business_date);

CREATE TABLE IF NOT EXISTS mart.fact_refunds_default
  PARTITION OF mart.fact_refunds DEFAULT;

CREATE INDEX IF NOT EXISTS fact_refunds_date_idx
  ON mart.fact_refunds (merchant_id, business_date);

CREATE MATERIALIZED VIEW IF NOT EXISTS mart.sales_daily_mv AS
WITH orders AS (
  SELECT merchant_id, business_date, count(*)::integer AS order_count, sum(discount_total_cents)::bigint AS discount_total_cents
  FROM mart.fact_orders
  GROUP BY merchant_id, business_date
),
payments AS (
  SELECT merchant_id, business_date, sum(amount_cents)::bigint AS payment_total_cents, sum(tax_cents)::bigint AS tax_total_cents, sum(tip_cents)::bigint AS tip_total_cents
  FROM mart.fact_payments
  GROUP BY merchant_id, business_date
),
refunds AS (
  SELECT merchant_id, business_date, sum(amount_cents)::bigint AS refund_total_cents
  FROM mart.fact_refunds
  GROUP BY merchant_id, business_date
)
SELECT
  COALESCE(o.merchant_id, p.merchant_id, r.merchant_id) AS merchant_id,
  COALESCE(o.business_date, p.business_date, r.business_date) AS business_date,
  COALESCE(o.order_count, 0)::integer AS order_count,
  COALESCE(p.payment_total_cents, 0)::bigint AS payment_total_cents,
  COALESCE(r.refund_total_cents, 0)::bigint AS refund_total_cents,
  (COALESCE(p.payment_total_cents, 0) - COALESCE(r.refund_total_cents, 0))::bigint AS net_sales_cents,
  COALESCE(p.tax_total_cents, 0)::bigint AS tax_total_cents,
  COALESCE(p.tip_total_cents, 0)::bigint AS tip_total_cents,
  COALESCE(o.discount_total_cents, 0)::bigint AS discount_total_cents
FROM orders o
FULL JOIN payments p USING (merchant_id, business_date)
FULL JOIN refunds r USING (merchant_id, business_date)
WITH NO DATA;

CREATE UNIQUE INDEX IF NOT EXISTS sales_daily_mv_pk
  ON mart.sales_daily_mv (merchant_id, business_date);

CREATE MATERIALIZED VIEW IF NOT EXISTS mart.sales_hourly_mv AS
WITH orders AS (
  SELECT merchant_id, business_date, local_hour, count(*)::integer AS order_count
  FROM mart.fact_orders
  GROUP BY merchant_id, business_date, local_hour
),
payments AS (
  SELECT merchant_id, business_date, local_hour, sum(amount_cents)::bigint AS payment_total_cents
  FROM mart.fact_payments
  GROUP BY merchant_id, business_date, local_hour
),
refunds AS (
  SELECT merchant_id, business_date, local_hour, sum(amount_cents)::bigint AS refund_total_cents
  FROM mart.fact_refunds
  GROUP BY merchant_id, business_date, local_hour
)
SELECT
  COALESCE(o.merchant_id, p.merchant_id, r.merchant_id) AS merchant_id,
  COALESCE(o.business_date, p.business_date, r.business_date) AS business_date,
  COALESCE(o.local_hour, p.local_hour, r.local_hour) AS local_hour,
  COALESCE(o.order_count, 0)::integer AS order_count,
  COALESCE(p.payment_total_cents, 0)::bigint AS payment_total_cents,
  COALESCE(r.refund_total_cents, 0)::bigint AS refund_total_cents,
  (COALESCE(p.payment_total_cents, 0) - COALESCE(r.refund_total_cents, 0))::bigint AS net_sales_cents
FROM orders o
FULL JOIN payments p USING (merchant_id, business_date, local_hour)
FULL JOIN refunds r USING (merchant_id, business_date, local_hour)
WITH NO DATA;

CREATE UNIQUE INDEX IF NOT EXISTS sales_hourly_mv_pk
  ON mart.sales_hourly_mv (merchant_id, business_date, local_hour);

CREATE MATERIALIZED VIEW IF NOT EXISTS mart.item_sales_daily_mv AS
SELECT
  merchant_id,
  business_date,
  item_fingerprint,
  min(item_name) AS item_name,
  sum(quantity)::numeric(14, 3) AS quantity,
  sum(gross_sales_cents)::bigint AS gross_sales_cents,
  sum(discount_total_cents)::bigint AS discount_total_cents,
  sum(tax_total_cents)::bigint AS tax_total_cents
FROM mart.fact_order_line_items
WHERE refunded = false
GROUP BY merchant_id, business_date, item_fingerprint
WITH NO DATA;

CREATE UNIQUE INDEX IF NOT EXISTS item_sales_daily_mv_pk
  ON mart.item_sales_daily_mv (merchant_id, business_date, item_fingerprint);

CREATE MATERIALIZED VIEW IF NOT EXISTS mart.payment_method_daily_mv AS
SELECT
  merchant_id,
  business_date,
  tender_type,
  count(*)::integer AS payment_count,
  sum(amount_cents)::bigint AS amount_cents,
  sum(tip_cents)::bigint AS tip_cents,
  sum(tax_cents)::bigint AS tax_cents
FROM mart.fact_payments
GROUP BY merchant_id, business_date, tender_type
WITH NO DATA;

CREATE UNIQUE INDEX IF NOT EXISTS payment_method_daily_mv_pk
  ON mart.payment_method_daily_mv (merchant_id, business_date, tender_type);

CREATE MATERIALIZED VIEW IF NOT EXISTS mart.employee_sales_daily_mv AS
SELECT
  o.merchant_id,
  o.business_date,
  coalesce(o.employee_id, 'UNKNOWN') AS employee_id,
  count(*)::integer AS order_count,
  sum(o.net_sales_cents)::bigint AS net_sales_cents
FROM mart.fact_orders o
GROUP BY o.merchant_id, o.business_date, coalesce(o.employee_id, 'UNKNOWN')
WITH NO DATA;

CREATE UNIQUE INDEX IF NOT EXISTS employee_sales_daily_mv_pk
  ON mart.employee_sales_daily_mv (merchant_id, business_date, employee_id);

CREATE TABLE IF NOT EXISTS meta.metric_definitions (
  metric_name text PRIMARY KEY,
  business_definition text NOT NULL,
  sql_expression text NOT NULL,
  grain text NOT NULL,
  notes text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO meta.metric_definitions(metric_name, business_definition, sql_expression, grain, notes)
VALUES
  ('gross_sales_cents', 'Line item sales before refunds, stored in cents.', 'sum(mart.fact_order_line_items.gross_sales_cents)', 'line item / day', 'Use item_sales_daily_mv for common item sales questions.'),
  ('payment_total_cents', 'Successful captured payments, stored in cents.', 'sum(mart.fact_payments.amount_cents)', 'payment / day', 'Split payments remain separate rows.'),
  ('refund_total_cents', 'Refund amounts, stored in cents.', 'sum(mart.fact_refunds.amount_cents)', 'refund / day', 'Refunds reduce net sales.'),
  ('net_sales_cents', 'Payment total minus refunds, stored in cents.', 'sum(payment_total_cents) - sum(refund_total_cents)', 'order / day', 'fact_orders stores the per-order rollup.'),
  ('cash_sales_cents', 'Payment total where normalized tender type is CASH.', 'sum(amount_cents) filter (where tender_type = ''CASH'')', 'payment / day', 'Use payment_method_daily_mv.'),
  ('credit_card_sales_cents', 'Payment total where normalized tender type is CREDIT_CARD.', 'sum(amount_cents) filter (where tender_type = ''CREDIT_CARD'')', 'payment / day', 'Use payment_method_daily_mv.'),
  ('tip_cents', 'Tips captured on payments, stored in cents.', 'sum(mart.fact_payments.tip_cents)', 'payment / day', 'Tips are not treated as item sales.')
ON CONFLICT (metric_name) DO UPDATE SET
  business_definition = EXCLUDED.business_definition,
  sql_expression = EXCLUDED.sql_expression,
  grain = EXCLUDED.grain,
  notes = EXCLUDED.notes,
  updated_at = now();
