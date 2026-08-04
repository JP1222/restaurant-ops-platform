-- Persist the per-line agreed unit cost on PO lines (2026-06-12 inventory audit
-- P1: PO edit/cancel). Until now `unit_cost_cents` from the create payload only
-- fed the order-total computation and was discarded, so an edit flow had nothing
-- to prefill except today's catalog cost — which silently re-prices the order.
--
-- Additive + nullable: zero-downtime, no backfill (NULL = legacy line, the UI
-- falls back to the item's current cost and the stored PO total stays the source
-- of truth for old orders). Rollback = drop the column.
ALTER TABLE "inventory_po_lines" ADD COLUMN "unit_cost_cents" DOUBLE PRECISION;
