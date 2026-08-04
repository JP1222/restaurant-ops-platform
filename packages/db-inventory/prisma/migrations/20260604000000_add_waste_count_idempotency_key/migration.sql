-- Waste / count idempotency keys (ADR-0028).
--
-- recordWaste and applyCounts were not deduplicated: a retried or double-submitted
-- waste/count (flaky network, double-tap) re-ran the transaction and re-applied the
-- on_hand delta. receivePurchaseOrder was already idempotent via its
-- (location_id, reason, source_ref, item_id) stock-movement key; these two flows have
-- no natural source_ref, so they take a client-supplied idempotency_key instead. The
-- store short-circuits a replay to the prior result; this unique index is the DB
-- backstop against a concurrent double-submit race.
--
-- Additive + safe on live data: the column is new (every existing row is NULL), and
-- the unique index is location-scoped with NULLs treated as distinct by Postgres, so
-- legacy / keyless rows never collide. Rollback: drop the two indexes + columns.

-- AlterTable
ALTER TABLE "inventory_count_records" ADD COLUMN     "idempotency_key" TEXT;

-- AlterTable
ALTER TABLE "inventory_waste_entries" ADD COLUMN     "idempotency_key" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "inventory_count_records_location_id_idempotency_key_key" ON "inventory_count_records"("location_id", "idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_waste_entries_location_id_idempotency_key_key" ON "inventory_waste_entries"("location_id", "idempotency_key");
