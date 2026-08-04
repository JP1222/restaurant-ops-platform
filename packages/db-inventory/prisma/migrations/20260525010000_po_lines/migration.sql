-- CreateTable
CREATE TABLE "inventory_po_lines" (
    "id" TEXT NOT NULL,
    "po_id" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "qty_ordered" DOUBLE PRECISION NOT NULL,
    "qty_received" DOUBLE PRECISION NOT NULL DEFAULT 0,

    CONSTRAINT "inventory_po_lines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "inventory_po_lines_po_id_idx" ON "inventory_po_lines"("po_id");

-- AddForeignKey
ALTER TABLE "inventory_po_lines" ADD CONSTRAINT "inventory_po_lines_po_id_fkey" FOREIGN KEY ("po_id") REFERENCES "inventory_purchase_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;
