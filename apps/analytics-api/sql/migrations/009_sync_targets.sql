-- Multi-location: which stores analytics syncs (ADR-0018 / ADR-0019).
-- Analytics owns its own Postgres and cannot import db-kds (Iron Law 1), so the
-- list of stores to sync lives here rather than being read from the KDS DB.
-- `provider` is forward-compat for a non-Clover POS (ADR-0019); only 'clover'
-- ingest exists today. Rows are seeded from CLOVER_MERCHANT_ID/CLOVER_TOKEN env
-- on first boot when the table is empty (bootstrap fallback), and upserted by
-- backoffice via POST /admin/api/sync-targets when a store's POS is connected.

CREATE SCHEMA IF NOT EXISTS config;

CREATE TABLE IF NOT EXISTS config.sync_targets (
  merchant_id    text PRIMARY KEY,
  provider       text NOT NULL DEFAULT 'clover',
  token          text NOT NULL,
  store_timezone text NOT NULL DEFAULT 'America/Chicago',
  active         boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sync_targets_active_idx ON config.sync_targets (active) WHERE active;
