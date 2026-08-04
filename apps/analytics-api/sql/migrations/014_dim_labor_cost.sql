-- Labor cost dimension for prime-cost analytics (ADR-0033, Phase 4a). Prime cost
-- = food cost + labor cost: the two controllable costs a limited-service operator
-- actually steers (NRA benchmark: prime <= 65% of sales). Phase 2 landed the food
-- leg (dim_item_cost / cost_daily_mv); this adds the labor leg.
--
-- This store has two long-term employees and no external payroll/scheduling
-- system, so labor is deliberately NOT modeled as a timecard ingest. It is the
-- same SHAPE as plate cost (dim_item_cost, ADR-0031): a slow-changing,
-- effective-dated cost REFERENCE the SQL joins against -- not a live feed. A wage
-- change opens a new effective-dated row, so past prime-cost stays point-in-time
-- correct (latest effective_from <= business_date wins).
--
-- Unlike dim_item_cost (brand-level -- a cup of milk costs the same at every
-- location, so it is NOT merchant-scoped), labor is per-location: different
-- stores staff and pay differently. So this dimension IS merchant-scoped, keyed
-- (merchant_id, effective_from), matching cost_daily_mv's grain for the join.
--
-- daily_labor_cost_cents is the all-in labor cost MODELED per operating day
-- (e.g. a weekly wage bill / days open). NUMERIC, not integer: a weekly figure
-- spread across days is sub-cent and must not truncate (same reasoning as
-- dim_item_cost.plate_cost_cents).
--
-- The editing path (Backoffice -> an originating write service -> here, since
-- analytics is read-only OLAP and Backoffice never writes to it -- Iron Law #5)
-- is deferred to Phase 4b. Until a row exists for a merchant, the downstream MV
-- leaves labor_cost NULL (never 0), so the dashboard's Labor / Prime cards stay
-- in their honest "not connected" state instead of showing a fabricated number.

CREATE TABLE IF NOT EXISTS mart.dim_labor_cost (
  merchant_id            text NOT NULL,
  effective_from         date NOT NULL,
  daily_labor_cost_cents numeric NOT NULL,
  currency               text NOT NULL DEFAULT 'USD',
  note                   text,
  ingested_at            timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (merchant_id, effective_from)
);

CREATE INDEX IF NOT EXISTS dim_labor_cost_latest_idx
  ON mart.dim_labor_cost (merchant_id, effective_from DESC);
