-- Item emoji icon (floor "edit item" / backoffice).
--
-- An operator-chosen emoji glyph that decorates the item in the catalog, a sibling
-- to the optional photo (inventory_item_images): both are the item's visual identity.
-- Unlike the photo bytes (kept in their own table so the hot dataset query stays
-- small), the icon is a tiny string, so it lives as a column on inventory_items and
-- rides inline in the dataset DTO. Display precedence is photo > icon > category glyph.
--
-- Additive + safe on live data: the column is new with a default, so every existing
-- row reads as "" (no icon). Rollback: drop the column.

-- AlterTable
ALTER TABLE "inventory_items" ADD COLUMN     "icon" TEXT NOT NULL DEFAULT '';
