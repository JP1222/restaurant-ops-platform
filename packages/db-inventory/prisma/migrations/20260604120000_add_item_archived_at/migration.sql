-- Item soft-delete / archive (ADR catalog-management D1).
--
-- "Delete an item" is implemented as archive, never a hard DELETE. An item is
-- referenced by loose `sku` / `item_id` strings (recipe lines, recipe modifiers,
-- vendor quotes, PO lines, waste entries, stock movements) with NO foreign key —
-- the only FK-enforced inbound reference is inventory_item_state (ON DELETE CASCADE).
-- So a hard delete is not blocked by the DB and would silently orphan those rows,
-- breaking sales-sync depletion (which matches recipe.line.sku -> item) and history.
-- archived_at NULL = active; a timestamp = archived (excluded from the active
-- dataset, kept resolvable for history + recipe integrity).
--
-- Additive + safe on live data: the column is new (every existing row is NULL, i.e.
-- active). Rollback: drop the column.

-- AlterTable
ALTER TABLE "inventory_items" ADD COLUMN     "archived_at" TIMESTAMP(3);
