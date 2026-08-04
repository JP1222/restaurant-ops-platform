ALTER TABLE raw.clover_orders
  ADD COLUMN IF NOT EXISTS detail_score smallint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS detail_source text,
  ADD COLUMN IF NOT EXISTS source_priority smallint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_detail_fetch_at timestamptz;

UPDATE raw.clover_orders
SET source_priority = CASE source
    WHEN 'webhook' THEN 90
    WHEN 'rest_detail' THEN 80
    WHEN 'hourly_rest_sweep' THEN 70
    WHEN 'mini_rest_sweep' THEN 70
    WHEN 'repair_window' THEN 70
    WHEN 'export' THEN 10
    ELSE 0
  END,
  detail_source = COALESCE(detail_source, source),
  last_detail_fetch_at = CASE
    WHEN source IN ('webhook', 'rest_detail', 'hourly_rest_sweep', 'mini_rest_sweep', 'repair_window')
      THEN COALESCE(last_detail_fetch_at, imported_at)
    ELSE last_detail_fetch_at
  END
WHERE detail_source IS NULL
   OR source_priority = 0
   OR last_detail_fetch_at IS NULL;

ALTER TABLE raw.clover_exports
  ADD COLUMN IF NOT EXISTS import_summary jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE audit.sync_jobs
  DROP CONSTRAINT IF EXISTS sync_jobs_job_type_check;

ALTER TABLE audit.sync_jobs
  ADD CONSTRAINT sync_jobs_job_type_check
  CHECK (job_type IN (
    'webhook_fetch_order',
    'webhook_fetch_payment',
    'reference_data_refresh',
    'mini_rest_sweep',
    'hourly_rest_sweep',
    'export_reconcile',
    'historical_export_backfill',
    'order_detail_hydration',
    'repair_window',
    'data_quality_check'
  ));

CREATE TABLE IF NOT EXISTS mart.fact_line_item_modifiers (
  merchant_id text NOT NULL,
  order_id text NOT NULL,
  line_item_fingerprint text NOT NULL,
  line_item_modifier_fingerprint text NOT NULL,
  line_item_id text,
  business_date date NOT NULL,
  created_at_utc timestamptz,
  item_fingerprint text NOT NULL,
  modifier_id text,
  modifier_name text NOT NULL,
  modifier_amount_cents integer NOT NULL DEFAULT 0,
  quantity numeric(12, 3) NOT NULL DEFAULT 1,
  raw jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (
    merchant_id,
    order_id,
    line_item_fingerprint,
    line_item_modifier_fingerprint,
    business_date
  )
) PARTITION BY RANGE (business_date);

CREATE TABLE IF NOT EXISTS mart.fact_line_item_modifiers_default
  PARTITION OF mart.fact_line_item_modifiers DEFAULT;

CREATE INDEX IF NOT EXISTS fact_orders_created_recent_idx
  ON mart.fact_orders (merchant_id, created_at_utc DESC);

CREATE INDEX IF NOT EXISTS fact_payments_created_recent_idx
  ON mart.fact_payments (merchant_id, created_at_utc DESC);

CREATE INDEX IF NOT EXISTS fact_line_items_business_item_idx
  ON mart.fact_order_line_items (merchant_id, business_date, item_fingerprint);

CREATE INDEX IF NOT EXISTS fact_line_item_modifiers_name_idx
  ON mart.fact_line_item_modifiers (merchant_id, business_date, modifier_name);

DROP VIEW IF EXISTS audit.sync_health;

CREATE OR REPLACE VIEW audit.sync_health AS
SELECT
  m.merchant_id,
  (
    SELECT max(completed_at)
    FROM audit.sync_runs r
    WHERE r.merchant_id = m.merchant_id
      AND r.job_type = 'hourly_rest_sweep'
      AND r.status = 'completed'
  ) AS last_hourly_sweep_at,
  (
    SELECT max(completed_at)
    FROM audit.sync_runs r
    WHERE r.merchant_id = m.merchant_id
      AND r.job_type = 'export_reconcile'
      AND r.status = 'completed'
  ) AS last_export_reconcile_at,
  (
    SELECT count(*)::integer
    FROM audit.sync_jobs j
    WHERE j.merchant_id = m.merchant_id
      AND j.job_type = 'repair_window'
      AND j.status IN ('pending', 'running', 'failed')
  ) AS open_repair_count,
  (
    SELECT count(*)::integer
    FROM audit.sync_jobs j
    WHERE j.merchant_id = m.merchant_id
      AND j.status = 'failed'
  ) AS failed_job_count,
  (
    SELECT count(*)::integer
    FROM audit.data_quality_checks q
    WHERE q.merchant_id = m.merchant_id
      AND q.status = 'failed'
      AND q.created_at >= now() - interval '24 hours'
  ) AS dq_failed_count,
  (
    SELECT CASE
      WHEN count(*) = 0 THEN 0
      ELSE round((count(*) FILTER (WHERE status = 'completed')::numeric / count(*)::numeric) * 100, 2)
    END
    FROM audit.sync_jobs j
    WHERE j.merchant_id = m.merchant_id
      AND j.job_type = 'historical_export_backfill'
      AND j.status <> 'cancelled'
  ) AS historical_backfill_progress_pct,
  (
    SELECT count(*)::integer
    FROM audit.sync_jobs j
    WHERE j.merchant_id = m.merchant_id
      AND j.job_type = 'historical_export_backfill'
      AND j.status = 'pending'
  ) AS historical_pending_count,
  (
    SELECT count(*)::integer
    FROM audit.sync_jobs j
    WHERE j.merchant_id = m.merchant_id
      AND j.job_type = 'historical_export_backfill'
      AND j.status = 'running'
  ) AS historical_running_count,
  (
    SELECT count(*)::integer
    FROM audit.sync_jobs j
    WHERE j.merchant_id = m.merchant_id
      AND j.job_type = 'historical_export_backfill'
      AND j.status = 'completed'
  ) AS historical_completed_count,
  (
    SELECT count(*)::integer
    FROM audit.sync_jobs j
    WHERE j.merchant_id = m.merchant_id
      AND j.job_type = 'historical_export_backfill'
      AND j.status = 'failed'
  ) AS historical_failed_count,
  (
    SELECT extract(epoch FROM (received_at - event_ts))::integer
    FROM audit.webhook_inbox w
    WHERE w.merchant_id = m.merchant_id
      AND w.event_ts IS NOT NULL
    ORDER BY w.received_at DESC
    LIMIT 1
  ) AS webhook_lag_seconds,
  (
    SELECT count(*)::integer
    FROM audit.dirty_windows d
    WHERE d.merchant_id = m.merchant_id
      AND d.status IN ('pending', 'refreshing', 'failed')
  ) AS dirty_window_backlog,
  (
    SELECT min(created_time_utc)::date
    FROM raw.clover_orders o
    WHERE o.merchant_id = m.merchant_id
  ) AS raw_orders_earliest_date,
  (
    SELECT max(created_time_utc)::date
    FROM raw.clover_orders o
    WHERE o.merchant_id = m.merchant_id
  ) AS raw_orders_latest_date,
  (
    SELECT count(*)::integer
    FROM raw.clover_orders o
    WHERE o.merchant_id = m.merchant_id
  ) AS raw_orders_count,
  (
    SELECT min(created_time_utc)::date
    FROM raw.clover_payments p
    WHERE p.merchant_id = m.merchant_id
  ) AS raw_payments_earliest_date,
  (
    SELECT max(created_time_utc)::date
    FROM raw.clover_payments p
    WHERE p.merchant_id = m.merchant_id
  ) AS raw_payments_latest_date,
  (
    SELECT count(*)::integer
    FROM raw.clover_payments p
    WHERE p.merchant_id = m.merchant_id
  ) AS raw_payments_count,
  (
    SELECT min(business_date)
    FROM mart.fact_orders o
    WHERE o.merchant_id = m.merchant_id
  ) AS mart_orders_earliest_date,
  (
    SELECT max(business_date)
    FROM mart.fact_orders o
    WHERE o.merchant_id = m.merchant_id
  ) AS mart_orders_latest_date,
  (
    SELECT count(*)::integer
    FROM raw.clover_orders o
    WHERE o.merchant_id = m.merchant_id
      AND o.detail_score < 2
      AND EXISTS (
        SELECT 1
        FROM raw.clover_payments p
        WHERE p.merchant_id = o.merchant_id
          AND (p.payload #>> '{order,id}' = o.order_id OR p.payload->>'orderId' = o.order_id)
      )
  ) AS low_detail_paid_order_count
FROM (
  SELECT merchant_id FROM raw.clover_orders
  UNION
  SELECT merchant_id FROM raw.clover_payments
  UNION
  SELECT merchant_id FROM audit.sync_jobs
) m;
