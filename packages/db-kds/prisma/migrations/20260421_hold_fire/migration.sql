ALTER TYPE "KdsTicketStatus" ADD VALUE 'ON_HOLD';

ALTER TYPE "KdsAction" ADD VALUE 'HOLD';

ALTER TYPE "KdsAction" ADD VALUE 'FIRE';

ALTER TABLE "kds_tickets"
ADD COLUMN "heldAt" TIMESTAMP(3),
ADD COLUMN "holdUntil" TIMESTAMP(3);

CREATE INDEX "kds_tickets_merchantId_holdUntil_idx" ON "kds_tickets"("merchantId", "holdUntil");
