-- Cleanup: remove kitchen tickets for Clover orders that never reached PAID.
--
-- Background: prior to this migration, kds-api created a KdsTicket as soon as
-- a Clover order webhook arrived, regardless of paymentState. Online ordering
-- creates a Clover order BEFORE the customer pays via Hosted Checkout, so the
-- kitchen briefly saw unpaid orders and risked making food the customer had
-- not actually paid for. The application-level fix (sync-order.ts now skips
-- Clover orders in paymentState OPEN/OPEN_TENDER/LOCKED/PARTIALLY_PAID)
-- prevents new bad rows from being written, but historical rows must be cleared.
--
-- This migration is idempotent: if no unpaid tickets exist (fresh install or
-- already cleaned), zero rows are affected.
--
-- Important: REFUNDED / PARTIALLY_REFUNDED orders are NOT deleted. Those were
-- paid at some point, so the kitchen ticket is a legitimate historical record
-- of "we made this; customer refunded later." Only currently-unpaid states
-- are removed.
--
-- Demo and Deliverect providers are untouched. Their paymentState semantics
-- differ from Clover and they remain payment-gating-bypass by design.

-- Capture the IDs of tickets we'll delete once, to keep the cascading deletes
-- consistent in the unlikely event that paymentState changes mid-migration.
DELETE FROM "kds_ticket_items"
WHERE "ticketId" IN (
  SELECT "id" FROM "kds_tickets"
  WHERE "provider" = 'CLOVER'
    AND "paymentState" IN ('OPEN', 'OPEN_TENDER', 'LOCKED', 'PARTIALLY_PAID')
);

DELETE FROM "kds_ticket_overrides"
WHERE "ticketId" IN (
  SELECT "id" FROM "kds_tickets"
  WHERE "provider" = 'CLOVER'
    AND "paymentState" IN ('OPEN', 'OPEN_TENDER', 'LOCKED', 'PARTIALLY_PAID')
);

DELETE FROM "kds_ticket_events"
WHERE "ticketId" IN (
  SELECT "id" FROM "kds_tickets"
  WHERE "provider" = 'CLOVER'
    AND "paymentState" IN ('OPEN', 'OPEN_TENDER', 'LOCKED', 'PARTIALLY_PAID')
);

DELETE FROM "kds_tickets"
WHERE "provider" = 'CLOVER'
  AND "paymentState" IN ('OPEN', 'OPEN_TENDER', 'LOCKED', 'PARTIALLY_PAID');

DELETE FROM "clover_orders"
WHERE "provider" = 'CLOVER'
  AND "paymentState" IN ('OPEN', 'OPEN_TENDER', 'LOCKED', 'PARTIALLY_PAID');
