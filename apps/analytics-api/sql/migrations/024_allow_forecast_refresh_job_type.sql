-- The scheduler's enqueueForecastRefresh (forecast scheduling) inserts
-- 'forecast_refresh' jobs, but the sync_jobs.job_type CHECK constraint was never
-- updated to allow it. Result: every scheduler tick after forecastRefreshHourUtc
-- (default 16:00 UTC) threw "new row for relation sync_jobs violates check
-- constraint sync_jobs_job_type_check", so the forecast never refreshed and the
-- scheduler error-looped for half of every UTC day. Re-add the constraint with
-- 'forecast_refresh' included. Forward-only; safe to re-run (DROP IF EXISTS).

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
    'data_quality_check',
    'forecast_refresh'
  ));
