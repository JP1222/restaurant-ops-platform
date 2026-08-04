-- Multi-location foundation (ADR-0018). Adds a POS-agnostic `locations` registry
-- and links each Clover POS binding up to its location. The FK column is nullable
-- during rollout; the backfill below creates one location per existing Clover
-- merchant (1:1 today) so the registry is immediately consistent. No KDS/analytics
-- operational table changes — those keep scoping by the Clover merchantId.

-- CreateTable
CREATE TABLE "locations" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'America/Chicago',
    "operatingHours" JSONB,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "locations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "locations_slug_key" ON "locations"("slug");

-- AlterTable
ALTER TABLE "clover_merchants" ADD COLUMN "locationId" TEXT;

-- CreateIndex
CREATE INDEX "clover_merchants_locationId_idx" ON "clover_merchants"("locationId");

-- AddForeignKey
ALTER TABLE "clover_merchants" ADD CONSTRAINT "clover_merchants_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Backfill: one location per existing Clover merchant (deterministic id/slug so
-- the link below needs no join). No-op on a fresh database with zero merchants.
INSERT INTO "locations" ("id", "name", "slug", "timezone", "active", "createdAt", "updatedAt")
SELECT
    'loc_' || "id",
    COALESCE(NULLIF("name", ''), 'Store ' || "id"),
    'store-' || lower("id"),
    'America/Chicago',
    true,
    now(),
    now()
FROM "clover_merchants";

UPDATE "clover_merchants" SET "locationId" = 'loc_' || "id";
