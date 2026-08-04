-- Rename inventory_recipes.square_catalog_item_id -> square_catalog_object_id (store #2;
-- docs/square-onboarding.md). The column holds the Square ITEM_VARIATION CatalogObject id
-- (what an order line references), NOT the parent ITEM id — the live-verification finding
-- that the depletion id-join was keyed on the wrong granularity. The value was corrected
-- to the variation id in the prior change; this renames the column to match, so the name
-- can never again imply "item id" and re-introduce the item-vs-variation confusion.
--
-- Metadata-only + safe: a column + unique-index RENAME (no table rewrite, no data change);
-- the column was added one migration earlier and store #2 is not live, so there is nothing
-- to backfill. The analytics sold-items feed's wire field stays `square_catalog_item_id`
-- (unchanged) — only this recipe-side column renames; inventory-api's analytics-client
-- bridges the wire name to the renamed property.
--
-- Rollback: ALTER TABLE "inventory_recipes" RENAME COLUMN "square_catalog_object_id" TO "square_catalog_item_id";
--           ALTER INDEX "inventory_recipes_square_catalog_object_id_key" RENAME TO "inventory_recipes_square_catalog_item_id_key";

-- AlterTable
ALTER TABLE "inventory_recipes" RENAME COLUMN "square_catalog_item_id" TO "square_catalog_object_id";

-- AlterIndex
ALTER INDEX "inventory_recipes_square_catalog_item_id_key" RENAME TO "inventory_recipes_square_catalog_object_id_key";
