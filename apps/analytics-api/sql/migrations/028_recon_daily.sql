-- P4 external correctness (data-completeness roadmap). The internal recon
-- (raw vs mart) only proves the transform was faithful — both sides trace to the
-- SAME Clover bulk export, so a day whose export was incomplete passes with
-- delta 0. This ledger holds a SECOND opinion: a control total reconstructed
-- from the Clover REST /payments path (a different code path from the bulk
-- export the mart is promoted from), diffed against mart.fact_payments.
--
-- v1 reconciles GROSS successful-payment total + txn count, bucketed by payment
-- createdTime in store tz (mirrors normalizePayment exactly, so it can't drift
-- from the mart's success/rounding/tz semantics and false-fire). It catches
-- export/source incompleteness — NOT a normalize bug (both paths share that).
-- Refunds + adjacent-day boundary roll-up are P4b.

CREATE TABLE IF NOT EXISTS audit.recon_daily (
  merchant_id         text NOT NULL,
  business_date       date NOT NULL,
  control_gross_cents bigint NOT NULL,
  control_txn_count   integer NOT NULL,
  mart_gross_cents    bigint NOT NULL,
  mart_txn_count      integer NOT NULL,
  delta_gross_cents   bigint NOT NULL,
  delta_txn_count     integer NOT NULL,
  tolerance_cents     bigint NOT NULL,
  status              text NOT NULL CHECK (
    status IN ('ok', 'warn', 'fail', 'source_unavailable', 'boundary_suspect')
  ),
  source_detail       jsonb NOT NULL DEFAULT '{}'::jsonb,
  reconstructed_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (merchant_id, business_date)
);

CREATE INDEX IF NOT EXISTS recon_daily_status_idx
  ON audit.recon_daily (merchant_id, status, business_date DESC);

-- Allow the new external_recon job type. Mirrors migration 024's pattern
-- (DROP IF EXISTS + re-add the full set). Forward-only; safe to re-run.
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
    'forecast_refresh',
    'external_recon'
  ));
