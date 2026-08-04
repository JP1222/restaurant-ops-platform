-- Location-scope the stock-movement idempotency key (ADR-0018 Phase 4).
--
-- Per-location idempotency: the sales-depletion feed (and PO receive / count
-- adjust) is merchant-wide, so the SAME (reason, source_ref, item_id) must be
-- applicable once PER LOCATION — a Clover line item legitimately depletes each
-- store independently, and a PO line received in location A must not block
-- location B's receive. The old key `(reason, source_ref, item_id)` collapsed
-- those into one row across all stores, silently corrupting a second store's
-- stock. Add `location_id` to the key so each location keeps its own idempotent
-- depletion/receive history.
--
-- Compatibility / rollback:
-- * Additive to the key: `(location_id, reason, source_ref, item_id)` is a
--   superset of the old `(reason, source_ref, item_id)`. Prod is single-location
--   today (every row's location_id = 'default-location'), so no existing row pair
--   can violate the new (stricter-keyed but functionally-equivalent-for-one-store)
--   constraint — this migration is safe to deploy on live data with zero conflicts.
-- * Reversible: drop the new index and recreate the old one. That is only safe
--   while data remains single-location; once a second store writes movements that
--   share a (reason, source_ref, item_id) with the first store, the old narrow
--   unique can no longer be recreated (that is exactly the corruption this fixes).

-- DropIndex
DROP INDEX "inventory_stock_movements_reason_source_ref_item_id_key";

-- CreateIndex
CREATE UNIQUE INDEX "inventory_stock_movements_location_id_reason_source_ref_ite_key" ON "inventory_stock_movements"("location_id", "reason", "source_ref", "item_id");
