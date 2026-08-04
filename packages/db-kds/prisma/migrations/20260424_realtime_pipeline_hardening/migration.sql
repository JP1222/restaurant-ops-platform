-- CreateEnum
CREATE TYPE "ProviderEventStatus" AS ENUM ('RECEIVED', 'QUEUED', 'PROCESSING', 'PROCESSED', 'FAILED', 'IGNORED');

-- CreateTable
CREATE TABLE "kds_provider_events" (
    "id" TEXT NOT NULL,
    "provider" "OrderProvider" NOT NULL,
    "merchantId" VARCHAR(32) NOT NULL,
    "sourceOrderId" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "topic" TEXT,
    "raw" JSONB NOT NULL,
    "status" "ProviderEventStatus" NOT NULL DEFAULT 'RECEIVED',
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "queuedAt" TIMESTAMP(3),
    "processingStartedAt" TIMESTAMP(3),
    "processedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "jobId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "kds_provider_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kds_realtime_states" (
    "merchantId" VARCHAR(32) NOT NULL,
    "seq" BIGINT NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "kds_realtime_states_pkey" PRIMARY KEY ("merchantId")
);

-- CreateTable
CREATE TABLE "kds_realtime_events" (
    "id" TEXT NOT NULL,
    "merchantId" VARCHAR(32) NOT NULL,
    "seq" BIGINT NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "kds_realtime_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "kds_provider_events_fingerprint_key" ON "kds_provider_events"("fingerprint");

-- CreateIndex
CREATE INDEX "kds_provider_events_status_receivedAt_idx" ON "kds_provider_events"("status", "receivedAt");

-- CreateIndex
CREATE INDEX "kds_provider_events_merchantId_provider_sourceOrderId_idx" ON "kds_provider_events"("merchantId", "provider", "sourceOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "kds_realtime_events_merchantId_seq_key" ON "kds_realtime_events"("merchantId", "seq");

-- CreateIndex
CREATE INDEX "kds_realtime_events_merchantId_createdAt_idx" ON "kds_realtime_events"("merchantId", "createdAt");

-- AddForeignKey
ALTER TABLE "kds_provider_events" ADD CONSTRAINT "kds_provider_events_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "clover_merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kds_realtime_states" ADD CONSTRAINT "kds_realtime_states_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "clover_merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kds_realtime_events" ADD CONSTRAINT "kds_realtime_events_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "clover_merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
