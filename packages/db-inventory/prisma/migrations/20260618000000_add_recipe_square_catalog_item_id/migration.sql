-- Square sibling of clover_item_id (store #2; docs/square-onboarding.md). The
-- sales-driven depletion join (ADR-0028) resolves a sold line by clover_item_id →
-- square_catalog_item_id → name, so a Square store's sales deplete stock the same
-- way Clover's do. Holds the BARE Square CatalogObject id (the sold-items feed's
-- square_catalog_item_id); synced rows namespace the recipe id as `square:{id}`.
--
-- Additive + safe on live data: a nullable column, so every existing recipe reads
-- as NULL (its prior behavior — Clover/manual recipes match by clover_item_id or
-- name). Postgres treats NULLs as distinct in a unique index, so the many NULL
-- rows coexist; uniqueness only binds the non-null Square ids (one recipe per
-- Square item). Rollback: DROP INDEX "inventory_recipes_square_catalog_item_id_key";
--                         ALTER TABLE "inventory_recipes" DROP COLUMN "square_catalog_item_id".

-- AlterTable
ALTER TABLE "inventory_recipes" ADD COLUMN     "square_catalog_item_id" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "inventory_recipes_square_catalog_item_id_key" ON "inventory_recipes"("square_catalog_item_id");
