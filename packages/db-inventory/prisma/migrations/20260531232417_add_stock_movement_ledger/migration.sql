-- CreateTable
CREATE TABLE "inventory_stock_movements" (
    "id" TEXT NOT NULL,
    "location_id" TEXT NOT NULL DEFAULT 'default-location',
    "item_id" TEXT NOT NULL,
    "delta" DOUBLE PRECISION NOT NULL,
    "reason" TEXT NOT NULL,
    "source_ref" TEXT,
    "actor" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inventory_stock_movements_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "inventory_stock_movements_location_id_item_id_idx" ON "inventory_stock_movements"("location_id", "item_id");

-- CreateIndex
CREATE INDEX "inventory_stock_movements_source_ref_idx" ON "inventory_stock_movements"("source_ref");
