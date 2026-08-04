-- Multi-location (ADR-0018): scope the store-level operational inventory tables
-- by location. Additive + backfilled via a column default, so existing
-- single-store data is preserved and behavior is unchanged until the
-- inventory-api begins filtering by location (follow-up). Brand-level catalog
-- tables (items, recipes, vendors, categories, waste reasons, settings, metrics)
-- stay shared. The InventoryItem catalog/per-store-state split + recipe price
-- overrides are a separate change — they touch the @rop/contracts DTO.

ALTER TABLE "inventory_purchase_orders" ADD COLUMN "location_id" TEXT NOT NULL DEFAULT 'default-location';
ALTER TABLE "inventory_po_lines" ADD COLUMN "location_id" TEXT NOT NULL DEFAULT 'default-location';
ALTER TABLE "inventory_count_records" ADD COLUMN "location_id" TEXT NOT NULL DEFAULT 'default-location';
ALTER TABLE "inventory_waste_entries" ADD COLUMN "location_id" TEXT NOT NULL DEFAULT 'default-location';
ALTER TABLE "inventory_activity_entries" ADD COLUMN "location_id" TEXT NOT NULL DEFAULT 'default-location';
ALTER TABLE "inventory_employees" ADD COLUMN "location_id" TEXT NOT NULL DEFAULT 'default-location';

CREATE INDEX "inventory_purchase_orders_location_id_idx" ON "inventory_purchase_orders"("location_id");
CREATE INDEX "inventory_po_lines_location_id_idx" ON "inventory_po_lines"("location_id");
CREATE INDEX "inventory_count_records_location_id_idx" ON "inventory_count_records"("location_id");
CREATE INDEX "inventory_waste_entries_location_id_idx" ON "inventory_waste_entries"("location_id");
CREATE INDEX "inventory_activity_entries_location_id_idx" ON "inventory_activity_entries"("location_id");
CREATE INDEX "inventory_employees_location_id_idx" ON "inventory_employees"("location_id");
