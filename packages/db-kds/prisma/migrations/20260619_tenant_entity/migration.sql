-- Phase 1 (ADR-0818, multi-tenant platform): introduce the Tenant entity — the
-- top-level cross-tenant isolation unit (a restaurant business; Toast's
-- "Management Group") — and backfill the single implicit tenant (the owner's
-- brand). See docs/architecture/multi-tenant-architecture.md and
-- docs/multi-tenant-migration-roadmap.md (Phase 1).
--
-- COMPATIBILITY / ROLLBACK: purely ADDITIVE and zero-behavior-change. Adds a new
-- `tenants` table + a NULLABLE `locations.tenantId` backfilled to the seeded
-- default tenant. NOTHING reads tenant_id yet — no app code path changes. A
-- later, separately-checkpointed migration sets `locations.tenantId` NOT NULL
-- once every reader/writer carries a tenant context (Phase 2). Rollback = drop
-- the FK + `locations.tenantId` + the `tenants` table + the `TenantStatus` type;
-- no data on the existing path is lost. The backfill is a single-tenant UPDATE
-- and a no-op on a fresh database (zero locations → zero rows touched).

-- CreateEnum
CREATE TYPE "TenantStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'OFFBOARDING', 'ARCHIVED');

-- CreateTable
CREATE TABLE "tenants" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "status" "TenantStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tenants_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tenants_slug_key" ON "tenants"("slug");

-- AlterTable
ALTER TABLE "locations" ADD COLUMN "tenantId" TEXT;

-- CreateIndex
CREATE INDEX "locations_tenantId_idx" ON "locations"("tenantId");

-- AddForeignKey
ALTER TABLE "locations" ADD CONSTRAINT "locations_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Seed the single implicit tenant (the owner's brand) and backfill existing
-- locations onto it. The INSERT runs before the UPDATE in this migration's
-- transaction, so the FK added above is satisfied. Idempotent: ON CONFLICT DO
-- NOTHING + the `WHERE "tenantId" IS NULL` guard make a re-run a no-op.
INSERT INTO "tenants" ("id", "name", "slug", "status", "createdAt", "updatedAt")
VALUES ('tenant-default', 'Example Kitchen', 'restaurant-ops-platform', 'ACTIVE', now(), now())
ON CONFLICT ("id") DO NOTHING;

UPDATE "locations" SET "tenantId" = 'tenant-default' WHERE "tenantId" IS NULL;
