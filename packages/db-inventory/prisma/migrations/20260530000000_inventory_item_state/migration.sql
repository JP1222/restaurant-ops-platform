-- Per-location stock state (ADR-0018, Phase 4 part 3). The brand catalog row
-- (inventory_items) keeps its on_hand/par/last_counted/flagged_86 columns as a
-- non-destructive fallback; the live per-store numbers now live here, keyed by
-- (location_id, item_id). Backfilled from the existing item columns for the
-- default location, so single-store reads/writes are byte-for-byte unchanged
-- until a second location starts writing its own state.
--
-- Forward-only. Rollback = DROP TABLE inventory_item_state: the item columns
-- still hold the default location's values, so the API falls back to them.

-- CreateTable
CREATE TABLE "inventory_item_state" (
    "location_id" TEXT NOT NULL,
    "item_id" TEXT NOT NULL,
    "on_hand" DOUBLE PRECISION NOT NULL,
    "par_min" DOUBLE PRECISION NOT NULL,
    "par_max" DOUBLE PRECISION NOT NULL,
    "last_counted" TEXT NOT NULL,
    "flagged_86" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "inventory_item_state_pkey" PRIMARY KEY ("location_id","item_id")
);

-- CreateIndex
CREATE INDEX "inventory_item_state_item_id_idx" ON "inventory_item_state"("item_id");

-- AddForeignKey
ALTER TABLE "inventory_item_state" ADD CONSTRAINT "inventory_item_state_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "inventory_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill the default location's state from the current item columns.
INSERT INTO "inventory_item_state" ("location_id", "item_id", "on_hand", "par_min", "par_max", "last_counted", "flagged_86", "createdAt", "updatedAt")
SELECT 'default-location', "id", "on_hand", "par_min", "par_max", "last_counted", "flagged_86", CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "inventory_items";
