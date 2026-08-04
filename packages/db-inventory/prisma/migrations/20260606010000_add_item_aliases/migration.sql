-- Learned vendor-alias table (ADR-0586, extends ADR-0538 invoice scan).
--
-- Maps a vendor's PRINTED invoice line text to the canonical inventory_items row it
-- stands for, so a confirmed receive teaches the scanner to auto-match the same product
-- next time instead of re-running a stateless fuzzy guess. One item accumulates many
-- aliases (one per vendor wording); the quantity always lands on the one canonical item,
-- which is how the suite avoids the duplicate-SKU-per-vendor anti-pattern.
--
-- (vendor, normalized) is the unique match key the inventory-api writes and both web
-- matchers read (one shared normalizeAlias in @rop/contracts). vendor = "" means
-- vendor-agnostic. raw keeps the original printed text (audit / future price comparison);
-- brand/pack_descriptor hold the model's optional structured extraction without rewriting
-- the clean canonical item name; last_cost_cents the most recent per-vendor price; hits an
-- alias-trust signal. ON DELETE CASCADE matches the sibling item child tables
-- (inventory_item_state / inventory_item_images): a rare hard item delete can't orphan an
-- alias, while the normal soft archive keeps the item row and its aliases.
--
-- Additive + safe on live data: a brand-new table, no existing-row impact. Rollback:
-- DROP TABLE "inventory_item_aliases".

-- CreateTable
CREATE TABLE "inventory_item_aliases" (
    "id" TEXT NOT NULL,
    "item_id" TEXT NOT NULL,
    "vendor" TEXT NOT NULL DEFAULT '',
    "normalized" TEXT NOT NULL,
    "raw_description" TEXT NOT NULL,
    "brand" TEXT NOT NULL DEFAULT '',
    "pack_descriptor" TEXT NOT NULL DEFAULT '',
    "source" TEXT NOT NULL DEFAULT 'receive',
    "last_cost_cents" INTEGER,
    "hits" INTEGER NOT NULL DEFAULT 1,
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "inventory_item_aliases_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "inventory_item_aliases_vendor_normalized_key" ON "inventory_item_aliases"("vendor", "normalized");

-- CreateIndex
CREATE INDEX "inventory_item_aliases_item_id_idx" ON "inventory_item_aliases"("item_id");

-- AddForeignKey
ALTER TABLE "inventory_item_aliases" ADD CONSTRAINT "inventory_item_aliases_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "inventory_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;
