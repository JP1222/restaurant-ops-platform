-- Per-vendor price intelligence (ADR-0586 Phase 2B): add a display label for the vendor to
-- the learned-alias row, so the price-comparison view can show "Sam's Club" instead of the
-- normalized match key "samsclub". The normalized `vendor` column stays the match key; this
-- is purely a human-readable companion captured from the raw vendor name at receive time.
--
-- Additive + safe on live data: a new NOT NULL column with a '' default, so existing rows
-- backfill to empty (the view falls back to the normalized key for those). Rollback:
-- ALTER TABLE "inventory_item_aliases" DROP COLUMN "vendor_label".

-- AlterTable
ALTER TABLE "inventory_item_aliases" ADD COLUMN "vendor_label" TEXT NOT NULL DEFAULT '';
