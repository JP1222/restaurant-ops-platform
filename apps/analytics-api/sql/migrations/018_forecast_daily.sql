-- Demand-forecast write tables (ADR-0032).
--
-- The forecaster is a SEPARATE compute surface, not part of the read pipeline: it
-- READS the sales marts and WRITES these tables, run as its own on-demand/job process
-- so the read-only OLAP model never becomes stateful (Iron Law 5). These are plain
-- tables (NOT materialized views): the forecaster owns and overwrites them.
--
-- mart.forecast_daily: one row per (merchant, future date, metric) with the point
-- forecast and an ~80% prediction band (lo/hi). metric is 'net_sales_cents' |
-- 'order_count'. NUMERIC because a seasonal mean is sub-cent / fractional.
--
-- mart.forecast_backtest: the model's OWN honest accuracy (MAPE/WAPE on held-out
-- history) per (merchant, metric) -- the only forecast-quality number we ever display.
-- No vendor accuracy figure is ever stored or shown (ADR-0032 / forecasting.md).

CREATE TABLE IF NOT EXISTS mart.forecast_daily (
  merchant_id  text NOT NULL,
  target_date  date NOT NULL,
  metric       text NOT NULL,
  value        numeric NOT NULL,
  lo           numeric NOT NULL,
  hi           numeric NOT NULL,
  generated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (merchant_id, target_date, metric)
);

CREATE INDEX IF NOT EXISTS forecast_daily_lookup_idx
  ON mart.forecast_daily (merchant_id, metric, target_date);

CREATE TABLE IF NOT EXISTS mart.forecast_backtest (
  merchant_id  text NOT NULL,
  metric       text NOT NULL,
  mape         numeric,
  wape         numeric,
  sample_count integer NOT NULL,
  generated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (merchant_id, metric)
);
