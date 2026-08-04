-- Cost dimension for profitability analytics (ADR-0031, Phase 1). inventory-api
-- owns "what a menu item costs to make" (plate cost = recipe BOM x ingredient
-- cost); analytics-api ingests it here over HTTP (Iron Laws 1 + 5: reads an
-- external source, writes only its own mart) and joins it to sales for margin.
--
-- Brand-level: a cup of milk costs the same at every location, so cost is NOT
-- merchant-scoped (unlike every other mart table). Keyed by (clover_item_id,
-- effective_from) so a price change opens a new effective-dated row and past
-- margins stay point-in-time correct.
--
-- plate_cost_cents is NUMERIC (not integer): item costs are per-usage Floats
-- (a cup is 5.2c), so a plate sums to a sub-cent value we must not truncate.
--
-- Join to sales: mart.fact_order_line_items.item_id IS the Clover item id, so
--   line_item.item_id = dim_item_cost.clover_item_id, taking the latest
--   effective_from <= business_date. Items with no row here are "cost unknown".

CREATE TABLE IF NOT EXISTS mart.dim_item_cost (
  clover_item_id   text NOT NULL,
  effective_from   date NOT NULL,
  plate_cost_cents numeric NOT NULL,
  currency         text NOT NULL DEFAULT 'USD',
  ingested_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (clover_item_id, effective_from)
);

CREATE INDEX IF NOT EXISTS dim_item_cost_latest_idx
  ON mart.dim_item_cost (clover_item_id, effective_from DESC);
