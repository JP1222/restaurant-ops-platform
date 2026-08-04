-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "MerchantAuthStatus" AS ENUM ('PENDING', 'ACTIVE', 'REVOKED', 'ERROR');

-- CreateEnum
CREATE TYPE "SyncStatus" AS ENUM ('PENDING', 'SYNCED', 'FAILED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "KdsTicketStatus" AS ENUM ('NEW', 'ACKNOWLEDGED', 'IN_PROGRESS', 'READY', 'COMPLETED');

-- CreateEnum
CREATE TYPE "KdsAction" AS ENUM ('ACKNOWLEDGE', 'START', 'READY', 'COMPLETE', 'BUMP', 'RECALL', 'SYNC');

-- CreateEnum
CREATE TYPE "KdsEventSource" AS ENUM ('SYSTEM', 'USER', 'WEBHOOK', 'RECONCILIATION');

-- CreateTable
CREATE TABLE "clover_merchants" (
    "id" VARCHAR(32) NOT NULL,
    "name" TEXT,
    "employeeId" TEXT,
    "accessToken" TEXT NOT NULL,
    "refreshToken" TEXT,
    "tokenExpiresAt" TIMESTAMP(3),
    "authStatus" "MerchantAuthStatus" NOT NULL DEFAULT 'PENDING',
    "region" TEXT NOT NULL DEFAULT 'US',
    "appInstalledAt" TIMESTAMP(3),
    "lastWebhookAt" TIMESTAMP(3),
    "lastSyncAt" TIMESTAMP(3),
    "lastReconciledAt" TIMESTAMP(3),
    "webhookStatus" TEXT,
    "kdsPin" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "clover_merchants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clover_orders" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "raw" JSONB NOT NULL,
    "normalized" JSONB,
    "clientCreatedAt" TIMESTAMP(3),
    "modifiedAt" TIMESTAMP(3),
    "orderState" TEXT,
    "orderType" TEXT,
    "source" TEXT,
    "paymentState" TEXT,
    "total" INTEGER,
    "currency" TEXT,
    "syncStatus" "SyncStatus" NOT NULL DEFAULT 'PENDING',
    "lastEventId" TEXT,
    "lastEventAt" TIMESTAMP(3),
    "lastSyncedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "clover_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kds_tickets" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "cloverOrderId" TEXT NOT NULL,
    "orderLabel" TEXT,
    "status" "KdsTicketStatus" NOT NULL DEFAULT 'NEW',
    "priority" INTEGER NOT NULL DEFAULT 0,
    "lastActor" TEXT,
    "lastAction" "KdsAction",
    "searchText" TEXT,
    "note" TEXT,
    "source" TEXT,
    "orderType" TEXT,
    "paymentState" TEXT,
    "acknowledgedAt" TIMESTAMP(3),
    "inProgressAt" TIMESTAMP(3),
    "readyAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "bumpedAt" TIMESTAMP(3),
    "recalledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "kds_tickets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kds_ticket_items" (
    "id" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "cloverLineItemId" TEXT,
    "itemId" TEXT,
    "name" TEXT NOT NULL,
    "alternateName" TEXT,
    "note" TEXT,
    "modifiers" JSONB,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "refunded" BOOLEAN NOT NULL DEFAULT false,
    "printed" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "kds_ticket_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kds_ticket_events" (
    "id" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "action" "KdsAction" NOT NULL,
    "source" "KdsEventSource" NOT NULL,
    "actor" TEXT,
    "payload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "kds_ticket_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kds_screen_sessions" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "screenName" TEXT NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "muted" BOOLEAN NOT NULL DEFAULT false,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "kds_screen_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kds_filters" (
    "merchantId" TEXT NOT NULL,
    "allowedOrderTypes" JSONB,
    "blockedSources" JSONB,
    "paymentStates" JSONB,
    "createdAfterMinutes" INTEGER,
    "searchText" TEXT,
    "includeCompleted" BOOLEAN NOT NULL DEFAULT false,
    "soundEnabled" BOOLEAN NOT NULL DEFAULT true,
    "screenPinEnabled" BOOLEAN NOT NULL DEFAULT false,
    "boardSettings" JSONB,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "kds_filters_pkey" PRIMARY KEY ("merchantId")
);

-- CreateTable
CREATE TABLE "clover_webhook_events" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "topic" TEXT,
    "orderId" TEXT,
    "modifiedTime" TIMESTAMP(3),
    "raw" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "clover_webhook_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dead_letter_jobs" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT,
    "jobType" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "dead_letter_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "clover_orders_merchantId_modifiedAt_idx" ON "clover_orders"("merchantId", "modifiedAt");

-- CreateIndex
CREATE INDEX "clover_orders_merchantId_createdAt_idx" ON "clover_orders"("merchantId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "kds_tickets_cloverOrderId_key" ON "kds_tickets"("cloverOrderId");

-- CreateIndex
CREATE INDEX "kds_tickets_merchantId_status_updatedAt_idx" ON "kds_tickets"("merchantId", "status", "updatedAt");

-- CreateIndex
CREATE INDEX "kds_ticket_items_ticketId_idx" ON "kds_ticket_items"("ticketId");

-- CreateIndex
CREATE INDEX "kds_ticket_events_ticketId_createdAt_idx" ON "kds_ticket_events"("ticketId", "createdAt");

-- CreateIndex
CREATE INDEX "kds_ticket_events_merchantId_createdAt_idx" ON "kds_ticket_events"("merchantId", "createdAt");

-- CreateIndex
CREATE INDEX "kds_screen_sessions_merchantId_lastSeenAt_idx" ON "kds_screen_sessions"("merchantId", "lastSeenAt");

-- CreateIndex
CREATE UNIQUE INDEX "clover_webhook_events_fingerprint_key" ON "clover_webhook_events"("fingerprint");

-- CreateIndex
CREATE INDEX "clover_webhook_events_merchantId_createdAt_idx" ON "clover_webhook_events"("merchantId", "createdAt");

-- CreateIndex
CREATE INDEX "clover_webhook_events_merchantId_orderId_idx" ON "clover_webhook_events"("merchantId", "orderId");

-- CreateIndex
CREATE INDEX "dead_letter_jobs_merchantId_createdAt_idx" ON "dead_letter_jobs"("merchantId", "createdAt");

-- AddForeignKey
ALTER TABLE "clover_orders" ADD CONSTRAINT "clover_orders_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "clover_merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kds_tickets" ADD CONSTRAINT "kds_tickets_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "clover_merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kds_tickets" ADD CONSTRAINT "kds_tickets_cloverOrderId_fkey" FOREIGN KEY ("cloverOrderId") REFERENCES "clover_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kds_ticket_items" ADD CONSTRAINT "kds_ticket_items_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "kds_tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kds_ticket_events" ADD CONSTRAINT "kds_ticket_events_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "kds_tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kds_screen_sessions" ADD CONSTRAINT "kds_screen_sessions_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "clover_merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kds_filters" ADD CONSTRAINT "kds_filters_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "clover_merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clover_webhook_events" ADD CONSTRAINT "clover_webhook_events_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "clover_merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dead_letter_jobs" ADD CONSTRAINT "dead_letter_jobs_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "clover_merchants"("id") ON DELETE SET NULL ON UPDATE CASCADE;
