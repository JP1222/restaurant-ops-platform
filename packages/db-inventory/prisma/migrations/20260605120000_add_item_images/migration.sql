-- Item photos (floor "edit item" / backoffice).
--
-- One optional row per item holding the raw image bytes + content type. Stored
-- in Postgres rather than object storage: single-merchant, low volume (a few
-- hundred items, one small resized photo each), and the suite has no S3/R2
-- infrastructure. Kept in its OWN table (not a column on inventory_items) so the
-- hot dataset query never loads image bytes — the dataset only learns an item
-- HAS a photo, then the browser fetches it lazily from
-- GET /api/inventory/items/:id/image.
--
-- ON DELETE CASCADE so a (rare) hard item delete can't orphan a blob; normal
-- item removal is a soft archive, which keeps the photo.
--
-- Additive + safe on live data: a brand-new table, no change to existing rows.
-- Rollback: drop the table.

-- CreateTable
CREATE TABLE "inventory_item_images" (
    "item_id" TEXT NOT NULL,
    "content_type" TEXT NOT NULL,
    "data" BYTEA NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "inventory_item_images_pkey" PRIMARY KEY ("item_id")
);

-- AddForeignKey
ALTER TABLE "inventory_item_images" ADD CONSTRAINT "inventory_item_images_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "inventory_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;
