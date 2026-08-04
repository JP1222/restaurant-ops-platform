-- Actual COGS dimension (ADR-0031, yield-variance lens). The inventory write-source
-- (apps/inventory-api GET /api/actual-cogs-inputs) computes count-based actual COGS per
-- between-count window = beginning + received - ending inventory value, valued at current
-- item cost; analytics ingests those windows here (Iron Law 5: analytics is read-only
-- OLAP, the originating service owns the write). It pairs with the theoretical
-- (sales-side) COGS already in cost_daily_mv (migration 012): their delta, joined per
-- window in cost_variance_daily_mv (migration 020), is yield variance.
--
-- MERCHANT-scoped like dim_labor_cost (counts + costs are a store's own physical
-- inventory). Keyed by the window's two count dates (period_start, period_end), so a
-- re-sync of the same window is an idempotent upsert. period_start / period_end are bare
-- store-local calendar dates (the inventory count dates), directly comparable to
-- business_date in cost_daily_mv. The *_value_cents are NUMERIC (item costs are sub-cent,
-- like plate cost) so a window total never truncates.

CREATE TABLE IF NOT EXISTS mart.dim_actual_cogs (
  merchant_id           text NOT NULL,
  period_start          date NOT NULL,
  period_end            date NOT NULL,
  beginning_value_cents numeric NOT NULL,
  received_value_cents  numeric NOT NULL,
  ending_value_cents    numeric NOT NULL,
  actual_cogs_cents     numeric NOT NULL,
  ingested_at           timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (merchant_id, period_start, period_end)
);

CREATE INDEX IF NOT EXISTS dim_actual_cogs_latest_idx
  ON mart.dim_actual_cogs (merchant_id, period_end DESC);
