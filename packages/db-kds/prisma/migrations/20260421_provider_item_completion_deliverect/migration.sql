-- CreateEnum
CREATE TYPE "OrderProvider" AS ENUM ('CLOVER', 'DELIVERECT', 'DEMO');

-- CreateEnum
CREATE TYPE "IntegrationEnvironment" AS ENUM ('STAGING', 'PRODUCTION');

-- AlterTable
ALTER TABLE "clover_orders"
ADD COLUMN "provider" "OrderProvider" NOT NULL DEFAULT 'CLOVER';

-- AlterTable
ALTER TABLE "kds_tickets"
ADD COLUMN "provider" "OrderProvider" NOT NULL DEFAULT 'CLOVER',
ADD COLUMN "sourceOrderId" TEXT;

UPDATE "kds_tickets"
SET "sourceOrderId" = "cloverOrderId"
WHERE "sourceOrderId" IS NULL;

ALTER TABLE "kds_tickets"
ALTER COLUMN "sourceOrderId" SET NOT NULL;

-- AlterTable
ALTER TABLE "kds_ticket_items"
ADD COLUMN "providerLineItemId" TEXT,
ADD COLUMN "itemKey" TEXT,
ADD COLUMN "completed" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "completedAt" TIMESTAMP(3),
ADD COLUMN "completedBy" TEXT;

UPDATE "kds_ticket_items"
SET "providerLineItemId" = "cloverLineItemId"
WHERE "providerLineItemId" IS NULL AND "cloverLineItemId" IS NOT NULL;

UPDATE "kds_ticket_items"
SET "itemKey" = COALESCE("providerLineItemId", "cloverLineItemId", "id")
WHERE "itemKey" IS NULL;

ALTER TABLE "kds_ticket_items"
ALTER COLUMN "itemKey" SET NOT NULL;

-- CreateTable
CREATE TABLE "kds_provider_configs" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "provider" "OrderProvider" NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "environment" "IntegrationEnvironment" NOT NULL DEFAULT 'STAGING',
    "externalLocationId" TEXT,
    "providerLocationId" TEXT,
    "channelLinkId" TEXT,
    "apiToken" TEXT,
    "hmacSecret" TEXT,
    "registerWebhookStatus" TEXT,
    "ordersWebhookStatus" TEXT,
    "lastRegisterWebhookAt" TIMESTAMP(3),
    "lastOrderWebhookAt" TIMESTAMP(3),
    "config" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "kds_provider_configs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "clover_orders_merchantId_provider_createdAt_idx" ON "clover_orders"("merchantId", "provider", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "kds_tickets_merchantId_provider_sourceOrderId_key" ON "kds_tickets"("merchantId", "provider", "sourceOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "kds_ticket_items_ticketId_itemKey_key" ON "kds_ticket_items"("ticketId", "itemKey");

-- CreateIndex
CREATE UNIQUE INDEX "kds_provider_configs_merchantId_provider_key" ON "kds_provider_configs"("merchantId", "provider");

-- CreateIndex
CREATE INDEX "kds_provider_configs_provider_channelLinkId_idx" ON "kds_provider_configs"("provider", "channelLinkId");

-- CreateIndex
CREATE INDEX "kds_provider_configs_provider_externalLocationId_idx" ON "kds_provider_configs"("provider", "externalLocationId");

-- AddForeignKey
ALTER TABLE "kds_provider_configs"
ADD CONSTRAINT "kds_provider_configs_merchantId_fkey"
FOREIGN KEY ("merchantId") REFERENCES "clover_merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
