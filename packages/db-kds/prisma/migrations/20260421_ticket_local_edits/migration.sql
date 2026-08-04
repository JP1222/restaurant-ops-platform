CREATE TABLE "kds_ticket_overrides" (
    "id" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "orderLabel" TEXT NOT NULL,
    "channelLabel" TEXT,
    "fulfillmentTimeLabel" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "kds_ticket_overrides_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "kds_ticket_overrides_ticketId_key" ON "kds_ticket_overrides"("ticketId");
CREATE INDEX "kds_ticket_overrides_merchantId_updatedAt_idx" ON "kds_ticket_overrides"("merchantId", "updatedAt");

ALTER TABLE "kds_ticket_overrides"
ADD CONSTRAINT "kds_ticket_overrides_ticketId_fkey"
FOREIGN KEY ("ticketId") REFERENCES "kds_tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
