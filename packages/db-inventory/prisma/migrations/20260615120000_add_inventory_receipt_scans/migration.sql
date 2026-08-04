-- Archived receipt/invoice scans (receipt-archive).
--
-- One row per CONFIRMED ad-hoc receive that carried a scanned image: the original
-- invoice photo (stored in Cloudflare R2 — only the object KEY lives here) plus an
-- immutable jsonb snapshot of the confirmed lines. `ref` is the receive's
-- idempotency anchor, the same value that fans out into
-- inventory_stock_movements.source_ref as `adhoc:<ref>:<i>`, so the archive row and
-- the movements it explains share one key.
--
-- Unlike inventory_item_images (bounded item photos → raw BYTEA in Postgres),
-- receipts are append-only and unbounded over time, so the bytes go to object
-- storage and Postgres keeps only the key. image_key / content_type are NULLABLE:
-- archiving the image is best-effort (a confirmed receive matters more than its
-- photo), so an R2 upload failure still records the log row with a NULL key.
--
-- Additive + safe on live data: a brand-new table, no change to existing rows, no
-- backfill. The (location_id, ref) unique index makes a replayed receive a no-op
-- upsert. Rollback: drop the table.

-- CreateTable
CREATE TABLE "inventory_receipt_scans" (
    "id" TEXT NOT NULL,
    "location_id" TEXT NOT NULL DEFAULT 'default-location',
    "ref" TEXT NOT NULL,
    "vendor" TEXT,
    "invoice_date" TEXT,
    "who" TEXT NOT NULL,
    "image_key" TEXT,
    "content_type" TEXT,
    "line_count" INTEGER NOT NULL,
    "total_cents" INTEGER NOT NULL,
    "lines" JSONB NOT NULL,
    "captured_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inventory_receipt_scans_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "inventory_receipt_scans_location_id_ref_key" ON "inventory_receipt_scans"("location_id", "ref");

-- CreateIndex
CREATE INDEX "inventory_receipt_scans_location_id_captured_at_idx" ON "inventory_receipt_scans"("location_id", "captured_at");
