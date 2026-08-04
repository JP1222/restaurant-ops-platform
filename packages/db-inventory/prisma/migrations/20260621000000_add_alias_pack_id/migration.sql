-- ADR-882: learned vendor aliases remember the specific pack (size), not just the item.
-- A confirmed receive that booked a line into a known InventoryItemPack records its id here, so
-- the next scan of that exact vendor wording auto-resolves to the right size. Nullable + additive:
-- legacy aliases and item-level (no-pack) lines keep a NULL and resolve at item level as before.
ALTER TABLE "inventory_item_aliases" ADD COLUMN "pack_id" TEXT;
