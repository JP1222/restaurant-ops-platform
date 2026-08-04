-- Phase 1 (ADR-0818, multi-tenant platform): stamp a denormalized `tenant_id`
-- onto every db-inventory table — the column Phase-3 RLS will key on. See
-- docs/architecture/multi-tenant-architecture.md + docs/multi-tenant-migration-roadmap.md.
--
-- COMPATIBILITY / ROLLBACK: purely ADDITIVE + zero-behavior-change. Each table
-- gets a NULLABLE `tenantId` backfilled to the single implicit tenant
-- ('tenant-default'). NOTHING reads tenant_id yet. No FK (db-inventory is its own
-- Postgres; Iron Law 1 — no cross-DB FK to db-kds's Tenant), no per-table index
-- (lands with Phase-3 RLS). The brand-local UNIQUE reworks the architecture doc
-- calls for (InventoryItem.sku, InventoryEmployee.pinLookup, InventoryItemAlias,
-- InventoryRecipe.clover/squareCatalogObjectId, InventoryLaborCost PK) are
-- DEFERRED to Phase 2 — they change Prisma compound-key accessors + need
-- coordinated inventory-api code changes, so they are NOT a zero-behavior add.
-- A later migration sets NOT NULL once writers stamp it. Rollback = drop columns.
--
-- NOTE: inventory_item_cost_history is INSERTed by a DB trigger; existing rows are
-- backfilled here, but new trigger rows carry NULL tenant_id until the trigger is
-- updated (Phase 2). Harmless while nothing reads tenant_id.

-- InventoryCategory
ALTER TABLE "inventory_categories" ADD COLUMN "tenantId" TEXT;
UPDATE "inventory_categories" SET "tenantId" = 'tenant-default' WHERE "tenantId" IS NULL;

-- InventoryItem
ALTER TABLE "inventory_items" ADD COLUMN "tenantId" TEXT;
UPDATE "inventory_items" SET "tenantId" = 'tenant-default' WHERE "tenantId" IS NULL;

-- InventoryItemPack
ALTER TABLE "inventory_item_packs" ADD COLUMN "tenantId" TEXT;
UPDATE "inventory_item_packs" SET "tenantId" = 'tenant-default' WHERE "tenantId" IS NULL;

-- InventoryBarcode
ALTER TABLE "inventory_barcodes" ADD COLUMN "tenantId" TEXT;
UPDATE "inventory_barcodes" SET "tenantId" = 'tenant-default' WHERE "tenantId" IS NULL;

-- InventoryItemCostHistory
ALTER TABLE "inventory_item_cost_history" ADD COLUMN "tenantId" TEXT;
UPDATE "inventory_item_cost_history" SET "tenantId" = 'tenant-default' WHERE "tenantId" IS NULL;

-- InventoryItemAlias
ALTER TABLE "inventory_item_aliases" ADD COLUMN "tenantId" TEXT;
UPDATE "inventory_item_aliases" SET "tenantId" = 'tenant-default' WHERE "tenantId" IS NULL;

-- InventoryItemImage
ALTER TABLE "inventory_item_images" ADD COLUMN "tenantId" TEXT;
UPDATE "inventory_item_images" SET "tenantId" = 'tenant-default' WHERE "tenantId" IS NULL;

-- InventoryItemState
ALTER TABLE "inventory_item_state" ADD COLUMN "tenantId" TEXT;
UPDATE "inventory_item_state" SET "tenantId" = 'tenant-default' WHERE "tenantId" IS NULL;

-- InventoryRecipe
ALTER TABLE "inventory_recipes" ADD COLUMN "tenantId" TEXT;
UPDATE "inventory_recipes" SET "tenantId" = 'tenant-default' WHERE "tenantId" IS NULL;

-- InventoryRecipeLine
ALTER TABLE "inventory_recipe_lines" ADD COLUMN "tenantId" TEXT;
UPDATE "inventory_recipe_lines" SET "tenantId" = 'tenant-default' WHERE "tenantId" IS NULL;

-- InventoryRecipeModifier
ALTER TABLE "inventory_recipe_modifiers" ADD COLUMN "tenantId" TEXT;
UPDATE "inventory_recipe_modifiers" SET "tenantId" = 'tenant-default' WHERE "tenantId" IS NULL;

-- InventoryVendor
ALTER TABLE "inventory_vendors" ADD COLUMN "tenantId" TEXT;
UPDATE "inventory_vendors" SET "tenantId" = 'tenant-default' WHERE "tenantId" IS NULL;

-- InventoryVendorQuote
ALTER TABLE "inventory_vendor_quotes" ADD COLUMN "tenantId" TEXT;
UPDATE "inventory_vendor_quotes" SET "tenantId" = 'tenant-default' WHERE "tenantId" IS NULL;

-- InventoryPurchaseOrder
ALTER TABLE "inventory_purchase_orders" ADD COLUMN "tenantId" TEXT;
UPDATE "inventory_purchase_orders" SET "tenantId" = 'tenant-default' WHERE "tenantId" IS NULL;

-- InventoryPoLine
ALTER TABLE "inventory_po_lines" ADD COLUMN "tenantId" TEXT;
UPDATE "inventory_po_lines" SET "tenantId" = 'tenant-default' WHERE "tenantId" IS NULL;

-- InventoryCountRecord
ALTER TABLE "inventory_count_records" ADD COLUMN "tenantId" TEXT;
UPDATE "inventory_count_records" SET "tenantId" = 'tenant-default' WHERE "tenantId" IS NULL;

-- InventoryWasteReason
ALTER TABLE "inventory_waste_reasons" ADD COLUMN "tenantId" TEXT;
UPDATE "inventory_waste_reasons" SET "tenantId" = 'tenant-default' WHERE "tenantId" IS NULL;

-- InventoryWasteEntry
ALTER TABLE "inventory_waste_entries" ADD COLUMN "tenantId" TEXT;
UPDATE "inventory_waste_entries" SET "tenantId" = 'tenant-default' WHERE "tenantId" IS NULL;

-- InventoryActivityEntry
ALTER TABLE "inventory_activity_entries" ADD COLUMN "tenantId" TEXT;
UPDATE "inventory_activity_entries" SET "tenantId" = 'tenant-default' WHERE "tenantId" IS NULL;

-- InventoryWasteSettings
ALTER TABLE "inventory_waste_settings" ADD COLUMN "tenantId" TEXT;
UPDATE "inventory_waste_settings" SET "tenantId" = 'tenant-default' WHERE "tenantId" IS NULL;

-- InventorySecuritySetting
ALTER TABLE "inventory_security_settings" ADD COLUMN "tenantId" TEXT;
UPDATE "inventory_security_settings" SET "tenantId" = 'tenant-default' WHERE "tenantId" IS NULL;

-- InventoryMetrics
ALTER TABLE "inventory_metrics" ADD COLUMN "tenantId" TEXT;
UPDATE "inventory_metrics" SET "tenantId" = 'tenant-default' WHERE "tenantId" IS NULL;

-- InventoryEmployee
ALTER TABLE "inventory_employees" ADD COLUMN "tenantId" TEXT;
UPDATE "inventory_employees" SET "tenantId" = 'tenant-default' WHERE "tenantId" IS NULL;

-- InventoryStockMovement
ALTER TABLE "inventory_stock_movements" ADD COLUMN "tenantId" TEXT;
UPDATE "inventory_stock_movements" SET "tenantId" = 'tenant-default' WHERE "tenantId" IS NULL;

-- InventoryReceiptScan
ALTER TABLE "inventory_receipt_scans" ADD COLUMN "tenantId" TEXT;
UPDATE "inventory_receipt_scans" SET "tenantId" = 'tenant-default' WHERE "tenantId" IS NULL;

-- InventoryLaborCost
ALTER TABLE "inventory_labor_costs" ADD COLUMN "tenantId" TEXT;
UPDATE "inventory_labor_costs" SET "tenantId" = 'tenant-default' WHERE "tenantId" IS NULL;

-- InventoryDepletionCursor
ALTER TABLE "inventory_depletion_cursor" ADD COLUMN "tenantId" TEXT;
UPDATE "inventory_depletion_cursor" SET "tenantId" = 'tenant-default' WHERE "tenantId" IS NULL;
