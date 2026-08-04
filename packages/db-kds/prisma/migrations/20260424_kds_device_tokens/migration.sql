-- CreateEnum
CREATE TYPE "KdsDeviceRole" AS ENUM ('KDS');

-- CreateTable
CREATE TABLE "kds_device_tokens" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "role" "KdsDeviceRole" NOT NULL DEFAULT 'KDS',
    "tokenHash" TEXT NOT NULL,
    "lastUsedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "kds_device_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "kds_device_tokens_tokenHash_key" ON "kds_device_tokens"("tokenHash");

-- CreateIndex
CREATE INDEX "kds_device_tokens_merchantId_revokedAt_idx" ON "kds_device_tokens"("merchantId", "revokedAt");

-- AddForeignKey
ALTER TABLE "kds_device_tokens" ADD CONSTRAINT "kds_device_tokens_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "clover_merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
