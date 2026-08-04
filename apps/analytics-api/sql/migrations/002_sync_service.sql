CREATE TABLE IF NOT EXISTS audit.webhook_verifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL,
  raw_event jsonb NOT NULL DEFAULT '{}'::jsonb,
  received_at timestamptz NOT NULL DEFAULT now(),
  used_at timestamptz
);

CREATE TABLE IF NOT EXISTS audit.webhook_inbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id text NOT NULL,
  object_id text NOT NULL,
  object_type text NOT NULL,
  event_type text NOT NULL,
  event_ts timestamptz,
  raw_event jsonb NOT NULL DEFAULT '{}'::jsonb,
  dedupe_key text NOT NULL UNIQUE,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processed', 'ignored', 'failed')),
  error_message text
);

CREATE INDEX IF NOT EXISTS webhook_inbox_status_idx
  ON audit.webhook_inbox (status, received_at);

CREATE TABLE IF NOT EXISTS audit.sync_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_type text NOT NULL CHECK (job_type IN (
    'webhook_fetch_order',
    'webhook_fetch_payment',
    'reference_data_refresh',
    'mini_rest_sweep',
    'hourly_rest_sweep',
    'export_reconcile',
    'historical_export_backfill',
    'repair_window',
    'data_quality_check'
  )),
  merchant_id text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'completed', 'failed', 'skipped', 'cancelled')),
  priority integer NOT NULL DEFAULT 100,
  window_start timestamptz,
  window_end timestamptz,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  dedupe_key text,
  attempt_count integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 5,
  run_after timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  locked_by text,
  started_at timestamptz,
  completed_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS sync_jobs_dedupe_key_idx
  ON audit.sync_jobs (dedupe_key)
  WHERE dedupe_key IS NOT NULL AND status IN ('pending', 'running');

CREATE INDEX IF NOT EXISTS sync_jobs_pending_idx
  ON audit.sync_jobs (status, priority, run_after, created_at)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS sync_jobs_merchant_type_status_idx
  ON audit.sync_jobs (merchant_id, job_type, status, created_at);

CREATE TABLE IF NOT EXISTS audit.sync_runs (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  job_id uuid,
  job_type text NOT NULL,
  merchant_id text NOT NULL,
  status text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  elapsed_ms integer,
  rows_read integer NOT NULL DEFAULT 0,
  rows_written integer NOT NULL DEFAULT 0,
  dirty_window_count integer NOT NULL DEFAULT 0,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

CREATE TABLE IF NOT EXISTS audit.sync_runs_default
  PARTITION OF audit.sync_runs DEFAULT;

CREATE INDEX IF NOT EXISTS sync_runs_job_type_created_idx
  ON audit.sync_runs (job_type, merchant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS audit.sync_cursors (
  merchant_id text NOT NULL,
  resource text NOT NULL,
  strategy text NOT NULL,
  cursor_value timestamptz,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (merchant_id, resource, strategy)
);

CREATE TABLE IF NOT EXISTS audit.dirty_windows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id text NOT NULL,
  business_date_start date NOT NULL,
  business_date_end date NOT NULL,
  utc_start timestamptz NOT NULL,
  utc_end timestamptz NOT NULL,
  reason text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'refreshing', 'refreshed', 'failed')),
  priority integer NOT NULL DEFAULT 100,
  claimed_at timestamptz,
  claim_token uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  refreshed_at timestamptz,
  error_message text
);

CREATE INDEX IF NOT EXISTS dirty_windows_pending_idx
  ON audit.dirty_windows (status, priority, business_date_start, created_at)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS dirty_windows_claim_token_idx
  ON audit.dirty_windows (claim_token)
  WHERE claim_token IS NOT NULL;

CREATE TABLE IF NOT EXISTS audit.reconciliation_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id text NOT NULL,
  business_date date NOT NULL,
  status text NOT NULL CHECK (status IN ('passed', 'failed')),
  order_count_delta integer NOT NULL DEFAULT 0,
  payment_total_delta_cents bigint NOT NULL DEFAULT 0,
  net_sales_delta_cents bigint NOT NULL DEFAULT 0,
  tax_delta_cents bigint NOT NULL DEFAULT 0,
  tip_delta_cents bigint NOT NULL DEFAULT 0,
  refund_delta_cents bigint NOT NULL DEFAULT 0,
  cash_delta_cents bigint NOT NULL DEFAULT 0,
  credit_card_delta_cents bigint NOT NULL DEFAULT 0,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS reconciliation_results_date_idx
  ON audit.reconciliation_results (merchant_id, business_date DESC, created_at DESC);

CREATE TABLE IF NOT EXISTS audit.data_quality_checks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id text NOT NULL,
  check_name text NOT NULL,
  status text NOT NULL CHECK (status IN ('passed', 'failed')),
  severity text NOT NULL DEFAULT 'warning' CHECK (severity IN ('info', 'warning', 'critical')),
  window_start timestamptz,
  window_end timestamptz,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS data_quality_checks_latest_idx
  ON audit.data_quality_checks (merchant_id, check_name, created_at DESC);

CREATE TABLE IF NOT EXISTS audit.service_heartbeats (
  component text PRIMARY KEY,
  instance_id text NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  details jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS audit.refresh_state (
  key text PRIMARY KEY,
  updated_at timestamptz NOT NULL DEFAULT now(),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb
);

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
  ) AS dirty_window_backlog
FROM (
  SELECT merchant_id FROM raw.clover_orders
  UNION
  SELECT merchant_id FROM raw.clover_payments
  UNION
  SELECT merchant_id FROM audit.sync_jobs
) m;
