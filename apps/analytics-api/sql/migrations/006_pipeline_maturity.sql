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
    'reconciliation_check',
    'repair_window',
    'data_quality_check'
  ));

CREATE TABLE IF NOT EXISTS audit.sync_windows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id text NOT NULL,
  window_type text NOT NULL,
  window_start timestamptz NOT NULL,
  window_end timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'completed', 'warning', 'failed')),
  stage_status jsonb NOT NULL DEFAULT '{}'::jsonb,
  job_id uuid,
  rows_read integer NOT NULL DEFAULT 0,
  rows_written integer NOT NULL DEFAULT 0,
  dirty_window_count integer NOT NULL DEFAULT 0,
  raw_export_ids uuid[] NOT NULL DEFAULT '{}',
  reconciliation_ids uuid[] NOT NULL DEFAULT '{}',
  last_error text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (merchant_id, window_type, window_start, window_end)
);

CREATE INDEX IF NOT EXISTS sync_windows_status_idx
  ON audit.sync_windows (merchant_id, window_type, status, window_start);

CREATE INDEX IF NOT EXISTS sync_windows_updated_idx
  ON audit.sync_windows (updated_at DESC);

ALTER TABLE audit.sync_runs
  ADD COLUMN IF NOT EXISTS input_window tstzrange,
  ADD COLUMN IF NOT EXISTS output_tables text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE audit.data_quality_checks
  ADD COLUMN IF NOT EXISTS first_seen_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_seen_at timestamptz,
  ADD COLUMN IF NOT EXISTS resolved_at timestamptz;

UPDATE audit.data_quality_checks
SET first_seen_at = COALESCE(first_seen_at, created_at),
    last_seen_at = COALESCE(last_seen_at, created_at),
    resolved_at = CASE
      WHEN status = 'passed' THEN COALESCE(resolved_at, created_at)
      ELSE resolved_at
    END
WHERE first_seen_at IS NULL
   OR last_seen_at IS NULL
   OR (status = 'passed' AND resolved_at IS NULL);

CREATE INDEX IF NOT EXISTS data_quality_checks_open_idx
  ON audit.data_quality_checks (merchant_id, check_name, first_seen_at DESC)
  WHERE resolved_at IS NULL;

CREATE INDEX IF NOT EXISTS reconciliation_results_status_idx
  ON audit.reconciliation_results (merchant_id, status, business_date DESC);

CREATE OR REPLACE FUNCTION audit.raw_amount(payload jsonb, key text)
RETURNS bigint
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN payload ? key AND (payload->>key) ~ '^-?[0-9]+(\.[0-9]+)?$'
      THEN trunc((payload->>key)::numeric)::bigint
    ELSE 0
  END
$$;

CREATE OR REPLACE FUNCTION audit.raw_tender_label(payload jsonb)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT lower(concat_ws(
    ' ',
    payload #>> '{tender,label}',
    payload #>> '{tender,name}',
    payload #>> '{cardTransaction,type}',
    payload->>'tenderType',
    payload->>'cardType',
    payload->>'type'
  ))
$$;

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
    SELECT max(created_at)
    FROM audit.reconciliation_results rr
    WHERE rr.merchant_id = m.merchant_id
      AND rr.status = 'passed'
  ) AS last_reconciliation_passed_at,
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
      AND q.resolved_at IS NULL
  ) AS dq_failed_count,
  (
    SELECT count(*)::integer
    FROM audit.data_quality_checks q
    WHERE q.merchant_id = m.merchant_id
      AND q.resolved_at IS NULL
  ) AS open_dq_issue_count,
  (
    SELECT CASE
      WHEN count(*) = 0 THEN 0
      ELSE round((count(*) FILTER (WHERE status IN ('completed', 'warning'))::numeric / count(*)::numeric) * 100, 2)
    END
    FROM audit.sync_windows w
    WHERE w.merchant_id = m.merchant_id
      AND w.window_type = 'historical_export_backfill'
  ) AS historical_backfill_progress_pct,
  (
    SELECT count(*)::integer
    FROM audit.sync_windows w
    WHERE w.merchant_id = m.merchant_id
      AND w.window_type = 'historical_export_backfill'
      AND w.status = 'pending'
  ) AS historical_pending_count,
  (
    SELECT count(*)::integer
    FROM audit.sync_windows w
    WHERE w.merchant_id = m.merchant_id
      AND w.window_type = 'historical_export_backfill'
      AND w.status = 'running'
  ) AS historical_running_count,
  (
    SELECT count(*)::integer
    FROM audit.sync_windows w
    WHERE w.merchant_id = m.merchant_id
      AND w.window_type = 'historical_export_backfill'
      AND w.status IN ('completed', 'warning')
  ) AS historical_completed_count,
  (
    SELECT count(*)::integer
    FROM audit.sync_windows w
    WHERE w.merchant_id = m.merchant_id
      AND w.window_type = 'historical_export_backfill'
      AND w.status = 'failed'
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
  ) AS low_detail_paid_order_count,
  (
    SELECT max(completed_at) < now() - interval '90 minutes'
    FROM audit.sync_runs r
    WHERE r.merchant_id = m.merchant_id
      AND r.job_type = 'hourly_rest_sweep'
      AND r.status = 'completed'
  ) AS hourly_sweep_stale,
  (
    SELECT max(completed_at) < now() - interval '24 hours'
    FROM audit.sync_runs r
    WHERE r.merchant_id = m.merchant_id
      AND r.job_type = 'export_reconcile'
      AND r.status = 'completed'
  ) AS export_reconcile_stale
FROM (
  SELECT merchant_id FROM raw.clover_orders
  UNION
  SELECT merchant_id FROM raw.clover_payments
  UNION
  SELECT merchant_id FROM audit.sync_jobs
  UNION
  SELECT merchant_id FROM audit.sync_windows
) m;
