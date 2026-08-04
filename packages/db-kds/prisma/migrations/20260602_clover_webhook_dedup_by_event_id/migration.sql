-- Clover webhook dedup by eventId (GH #129).
--
-- Clover delivers webhooks at-least-once. The previous L1 dedup keyed on a
-- content fingerprint `(merchantId, topic, orderId, modifiedTime)`. When
-- `modifiedTime` was null or identical across rapid resends, two genuinely
-- distinct deliveries collapsed and the second was silently dropped. This
-- migration moves the L1 unique constraint onto the payload's stable `eventId`
-- (which the ingest layer already synthesizes from the fingerprint components
-- when the payload carries no eventId), so identical re-deliveries still
-- collapse but distinct events never do.
--
-- COMPATIBILITY / CHECKPOINT:
--   * `clover_webhook_events.eventId` has been populated on every insert since
--     the table was created (NOT NULL since 20260420_init), so no backfill is
--     required.
--   * Pre-existing rows that share `(merchantId, eventId)` would block the new
--     UNIQUE index. Such rows are duplicate deliveries by definition, so the
--     DELETE below collapses each duplicate group to its earliest `createdAt`
--     (ties broken by `id`) BEFORE the index is created. This is the same
--     "keep the first delivery" semantics the runtime dedup enforces, so it is
--     safe and idempotent on existing data.
--   * `fingerprint` is intentionally kept as a (now non-unique) column: the L2
--     dedup layer (`kds_provider_events.fingerprint`) and the webhook ingest
--     path still write/read it. Only its uniqueness moves to `(merchantId,
--     eventId)`.
--
-- ROLLBACK: drop the new unique index and re-create the fingerprint unique
-- index. Safe because `fingerprint` values were unique under the prior
-- constraint and are still written unchanged.

-- Collapse any pre-existing duplicate (merchantId, eventId) deliveries,
-- keeping the earliest persisted row per group.
DELETE FROM "clover_webhook_events" a
USING "clover_webhook_events" b
WHERE a."merchantId" = b."merchantId"
  AND a."eventId" = b."eventId"
  AND (
    a."createdAt" > b."createdAt"
    OR (a."createdAt" = b."createdAt" AND a."id" > b."id")
  );

-- DropIndex
DROP INDEX "clover_webhook_events_fingerprint_key";

-- CreateIndex
CREATE UNIQUE INDEX "clover_webhook_events_merchantId_eventId_key" ON "clover_webhook_events"("merchantId", "eventId");
