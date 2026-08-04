-- The per-vendor "last paid" price mirrors the per-usage cost model: a per-usage cost is
-- sub-cent (a 6000-ct napkin case at $28.75 is 0.479c each), so widen last_cost_cents from
-- whole-cent INTEGER to DOUBLE PRECISION (Float), matching inventory_items.cost_cents.
-- Integer -> double precision is a lossless widening; existing whole-cent values are preserved.
ALTER TABLE "inventory_item_aliases"
  ALTER COLUMN "last_cost_cents" SET DATA TYPE DOUBLE PRECISION;
