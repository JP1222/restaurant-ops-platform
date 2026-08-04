CREATE TABLE "kds_realtime_receipts" (
  "id" TEXT NOT NULL,
  "eventId" TEXT NOT NULL,
  "merchantId" TEXT NOT NULL,
  "ticketId" TEXT NOT NULL,
  "providerEventId" TEXT,
  "webhookReceivedAt" TIMESTAMP(3),
  "realtimePublishedAt" TIMESTAMP(3),
  "browserReceivedAt" TIMESTAMP(3) NOT NULL,
  "renderCommittedAt" TIMESTAMP(3) NOT NULL,
  "webhookToRenderMs" INTEGER,
  "realtimeToBrowserMs" INTEGER,
  "browserRenderMs" INTEGER,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "kds_realtime_receipts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "kds_realtime_receipts_eventId_key" ON "kds_realtime_receipts"("eventId");
CREATE INDEX "kds_realtime_receipts_merchantId_createdAt_idx" ON "kds_realtime_receipts"("merchantId", "createdAt");
CREATE INDEX "kds_realtime_receipts_providerEventId_idx" ON "kds_realtime_receipts"("providerEventId");

ALTER TABLE "kds_realtime_receipts"
  ADD CONSTRAINT "kds_realtime_receipts_merchantId_fkey"
  FOREIGN KEY ("merchantId") REFERENCES "clover_merchants"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
