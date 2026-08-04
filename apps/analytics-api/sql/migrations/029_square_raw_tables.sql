-- 029_square_raw_tables.sql
-- Square Phase 4 (analytics ingest): raw landing tables for the Square Connect API.
-- Mirrors raw.clover_orders / clover_payments / clover_refunds so the provider-aware
-- raw→mart transform (PR-D) can read them with the same shape.
--
-- DELIBERATELY SIMPLER than the Clover raw tables: Square has NO bulk-export API,
-- so there is a SINGLE ingest source (REST SearchOrders/SearchPayments/SearchRefunds,
-- always full-detail). Therefore these tables OMIT Clover's raw_export_id FK (no
-- raw.square_exports table) and the detail-protection columns (detail_score /
-- detail_source / source_priority / last_detail_fetch_at, migration 005) — those
-- exist only to stop Clover's low-detail bulk export from overwriting high-detail
-- REST rows. `source` is always 'rest' for Square.
--
-- merchant_id for a Square store is the synthetic PosStore id `square:{location_id}`.
-- The mart fact/dim/MV schema is UNCHANGED by this migration — it only adds raw
-- landing tables. The Square pipeline stays inert until a sync_targets row with
-- provider='square' exists.

CREATE TABLE IF NOT EXISTS raw.square_orders (
  merchant_id text NOT NULL,
  order_id text NOT NULL,
  payload jsonb NOT NULL,
  source text NOT NULL DEFAULT 'rest',
  window_start timestamptz,
  window_end timestamptz,
  created_time_utc timestamptz,
  modified_time_utc timestamptz,
  imported_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (merchant_id, order_id)
);

CREATE INDEX IF NOT EXISTS square_orders_created_idx
  ON raw.square_orders (merchant_id, created_time_utc);

CREATE INDEX IF NOT EXISTS square_orders_payload_gin_idx
  ON raw.square_orders USING gin (payload);

CREATE TABLE IF NOT EXISTS raw.square_payments (
  merchant_id text NOT NULL,
  payment_id text NOT NULL,
  order_id text,
  payload jsonb NOT NULL,
  source text NOT NULL DEFAULT 'rest',
  window_start timestamptz,
  window_end timestamptz,
  created_time_utc timestamptz,
  imported_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (merchant_id, payment_id)
);

CREATE INDEX IF NOT EXISTS square_payments_created_idx
  ON raw.square_payments (merchant_id, created_time_utc);

CREATE INDEX IF NOT EXISTS square_payments_payload_gin_idx
  ON raw.square_payments USING gin (payload);

CREATE TABLE IF NOT EXISTS raw.square_refunds (
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

CREATE INDEX IF NOT EXISTS square_refunds_created_idx
  ON raw.square_refunds (merchant_id, created_time_utc);
