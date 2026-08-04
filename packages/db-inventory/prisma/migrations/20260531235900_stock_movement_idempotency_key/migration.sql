-- CreateIndex
CREATE UNIQUE INDEX "inventory_stock_movements_reason_source_ref_item_id_key" ON "inventory_stock_movements"("reason", "source_ref", "item_id");

