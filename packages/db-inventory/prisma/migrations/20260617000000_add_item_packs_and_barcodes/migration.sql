-- Inventory unit model (ADR-0737): a stable BASE unit per item, PACKS as named
-- (optionally vendor-scoped) conversion factors, and BARCODES mapping a code to an
-- (item, pack). Replaces the single global purchase_unit/pack_qty factor with a set of
-- packs, so case→bag→each and per-vendor pack variance (Vendor A case = 500, Vendor B
-- case = 480) and fixed-weight packs (8 oz vs 12 oz bag) all live on ONE item while
-- on_hand / par / cost / the movement ledger stay denominated in the base unit.
--
-- Additive + safe on live data:
--   * inventory_items gains unit_kind with a DEFAULT, so every existing row reads as
--     'count' (its implicit prior behavior) with no rewrite.
--   * Two brand-new tables — no existing-row impact.
--   * The legacy purchase_unit/pack_qty columns are RETAINED (still drive cost derivation
--     and serve as the implicit default pack + rollback cover); the backfill below seeds
--     one pack per item that has a real pack so the new model starts populated.
-- Rollback: DROP TABLE inventory_barcodes; DROP TABLE inventory_item_packs;
--           ALTER TABLE inventory_items DROP COLUMN unit_kind.  The legacy single-factor
--           path (purchase_unit/pack_qty + the ADR-0592 client conversion) still works.

-- AlterTable: the base unit's kind (count | weight | volume).
ALTER TABLE "inventory_items" ADD COLUMN "unit_kind" TEXT NOT NULL DEFAULT 'count';

-- CreateTable: packs (named conversion factors to the base unit, optionally per-vendor).
CREATE TABLE "inventory_item_packs" (
    "id" TEXT NOT NULL,
    "item_id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "base_qty_per_pack" DOUBLE PRECISION NOT NULL,
    "vendor" TEXT NOT NULL DEFAULT '',
    "contains_label" TEXT NOT NULL DEFAULT '',
    "contains_qty" DOUBLE PRECISION,
    "is_purchase_default" BOOLEAN NOT NULL DEFAULT false,
    "sort" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "inventory_item_packs_pkey" PRIMARY KEY ("id")
);

-- CreateTable: barcodes (UPC/GTIN or printed internal code -> item, optionally a pack).
CREATE TABLE "inventory_barcodes" (
    "code" TEXT NOT NULL,
    "item_id" TEXT NOT NULL,
    "pack_id" TEXT,
    "source" TEXT NOT NULL DEFAULT 'manufacturer',
    "label" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "inventory_barcodes_pkey" PRIMARY KEY ("code")
);

-- CreateIndex
CREATE UNIQUE INDEX "inventory_item_packs_item_id_vendor_label_key" ON "inventory_item_packs"("item_id", "vendor", "label");

-- CreateIndex
CREATE INDEX "inventory_item_packs_item_id_idx" ON "inventory_item_packs"("item_id");

-- CreateIndex
CREATE INDEX "inventory_barcodes_item_id_idx" ON "inventory_barcodes"("item_id");

-- AddForeignKey
ALTER TABLE "inventory_item_packs" ADD CONSTRAINT "inventory_item_packs_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "inventory_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_barcodes" ADD CONSTRAINT "inventory_barcodes_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "inventory_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill: seed one default purchase pack per item that has a real multi-unit pack
-- (pack_qty > 1), from the legacy purchase_unit/pack_qty. Items with pack_qty <= 1 (each
-- bought singly) need no pack — the base unit suffices. One row per item (vendor = ''),
-- so the (item_id, vendor, label) unique index can't collide.
INSERT INTO "inventory_item_packs"
    ("id", "item_id", "label", "base_qty_per_pack", "vendor", "contains_label", "is_purchase_default", "sort", "createdAt", "updatedAt")
SELECT
    gen_random_uuid()::text,
    "id",
    CASE WHEN coalesce(btrim("purchase_unit"), '') = '' THEN 'Case' ELSE "purchase_unit" END,
    "pack_qty",
    '',
    '',
    true,
    0,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
FROM "inventory_items"
WHERE "pack_qty" > 1;
