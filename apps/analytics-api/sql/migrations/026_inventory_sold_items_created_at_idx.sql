-- The inventory sold-items depletion feed (src/http/inventory-feed.ts, ADR-0028)
-- filters `created_at_utc >= since` and orders by `created_at_utc ASC`, but
-- mart.fact_order_line_items is RANGE-partitioned by business_date with indexes
-- only on (merchant_id, business_date, ...). With no created_at_utc index and no
-- business_date predicate to prune partitions, the planner scanned all 100
-- partitions and sorted an unindexed column — ~15s on 239k rows, which tripped
-- the inventory-api sync-sales 15s fetch timeout (500). After this index the
-- per-partition lookup is an index scan (EXPLAIN: ~2ms for a since=now poll).
--
-- Partial on `refunded = false` to match the query exactly (refunded lines never
-- depleted stock, so the feed excludes them). Created on the partitioned parent,
-- which cascades the index to every existing + future partition. IF NOT EXISTS so
-- this is a no-op where it was already applied by hand during the 2026-06-16
-- rollout. Forward-only, like all migrations here.
CREATE INDEX IF NOT EXISTS fact_line_items_merchant_created_idx
  ON mart.fact_order_line_items (merchant_id, created_at_utc)
  WHERE refunded = false;
