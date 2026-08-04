-- Phase 2 (ADR-0818, multi-tenant platform): TenantMembership — which tenant(s)
-- an admin account belongs to and its role within each (the *tenant* axis of
-- access). See docs/architecture/multi-tenant-architecture.md and
-- docs/multi-tenant-migration-roadmap.md (Phase 2). RBAC lineage: ADR-0029.
--
-- COMPATIBILITY / ROLLBACK: purely ADDITIVE and zero-behavior-change. Adds the
-- `tenant_memberships` table and backfills one membership per existing account
-- onto the single implicit tenant (`tenant-default`, seeded by the Phase-1
-- db-kds migration) carrying the account's current role. NOTHING reads
-- memberships yet — the cookie session derives access exactly as today;
-- `WebAdminAccount.role` stays the live source of truth until the next Phase-2
-- step (the fail-closed, membership-validated session rewrite, landed behind a
-- flag + dual-read). Rollback = drop this table; no data on the existing path is
-- lost. The backfill is a no-op on a fresh database (zero accounts → zero rows).
--
-- `tenantId` is a BARE string with NO foreign key: db-auth does not own the
-- Tenant table (it lives in db-kds; Iron Law 1), mirroring db-crm / db-inventory.

-- CreateTable
CREATE TABLE "tenant_memberships" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "role" "WebAdminRole" NOT NULL DEFAULT 'OWNER',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tenant_memberships_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "tenant_memberships_tenantId_idx" ON "tenant_memberships"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_memberships_accountId_tenantId_key" ON "tenant_memberships"("accountId", "tenantId");

-- AddForeignKey
ALTER TABLE "tenant_memberships" ADD CONSTRAINT "tenant_memberships_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "web_admin_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill: every existing admin account -> one membership of the single
-- implicit tenant, carrying its current global role. `gen_random_uuid()` is
-- built into PostgreSQL 13+; the membership id is opaque (the `@default(cuid())`
-- in the schema only applies to client-created rows). Idempotent: the
-- (accountId, tenantId) unique makes a re-run a no-op.
INSERT INTO "tenant_memberships" ("id", "accountId", "tenantId", "role", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, "id", 'tenant-default', "role", now(), now()
FROM "web_admin_accounts"
ON CONFLICT ("accountId", "tenantId") DO NOTHING;
