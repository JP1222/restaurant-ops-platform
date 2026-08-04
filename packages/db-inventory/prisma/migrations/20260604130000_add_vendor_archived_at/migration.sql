-- Vendor soft-delete / archive (ADR catalog-management D2).
--
-- Same rationale as inventory_items.archived_at: a vendor is referenced by NAME
-- string from inventory_items.vendor and inventory_purchase_orders.vendor, and by id
-- from inventory_vendor_quotes.vendor_id — none FK-enforced. So "delete a vendor" is
-- archive, not a hard DELETE, to keep those references resolvable. archived_at NULL =
-- active; a timestamp = archived (excluded from the active dataset).
--
-- Additive + safe on live data: the column is new (every existing row is NULL, i.e.
-- active). Rollback: drop the column.

-- AlterTable
ALTER TABLE "inventory_vendors" ADD COLUMN     "archived_at" TIMESTAMP(3);
