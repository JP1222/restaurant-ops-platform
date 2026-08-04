-- Phase 1 (ADR-0818, multi-tenant platform): add the denormalized `tenant_id`
-- seam to every tenant-owned CRM table and backfill the single implicit tenant
-- (the owner's brand, `tenant-default`, seeded in db-kds). See
-- docs/architecture/multi-tenant-architecture.md (Per-domain → db-crm) and
-- docs/multi-tenant-migration-roadmap.md (Phase 1).
--
-- COMPATIBILITY / ROLLBACK: purely ADDITIVE and zero-behavior-change. Each table
-- gains a NULLABLE `tenant_id` (a bare string — crm does not own the Tenant table,
-- Iron Law 1) + an index, then existing rows are backfilled to 'tenant-default'.
-- NOTHING reads tenant_id yet — no app code path changes. The CRM headline rework
-- (`@@unique([tenantId, phone_e164])`, slug, code — brand-global → tenant-global)
-- lands in a SEPARATE later migration, after every writer stamps a tenant context
-- (roadmap staging rule #3: never add a tenant-leading unique key in the same step
-- as the column). Rollback = drop the columns + indexes; no data on the existing
-- path is lost. Each UPDATE is idempotent (`WHERE tenant_id IS NULL`) and a no-op
-- on a fresh / empty database.

-- crm_customers
ALTER TABLE "crm_customers" ADD COLUMN "tenant_id" TEXT;
CREATE INDEX "crm_customers_tenant_id_idx" ON "crm_customers"("tenant_id");
UPDATE "crm_customers" SET "tenant_id" = 'tenant-default' WHERE "tenant_id" IS NULL;

-- crm_loyalty_accounts
ALTER TABLE "crm_loyalty_accounts" ADD COLUMN "tenant_id" TEXT;
CREATE INDEX "crm_loyalty_accounts_tenant_id_idx" ON "crm_loyalty_accounts"("tenant_id");
UPDATE "crm_loyalty_accounts" SET "tenant_id" = 'tenant-default' WHERE "tenant_id" IS NULL;

-- crm_points_ledger
ALTER TABLE "crm_points_ledger" ADD COLUMN "tenant_id" TEXT;
CREATE INDEX "crm_points_ledger_tenant_id_idx" ON "crm_points_ledger"("tenant_id");
UPDATE "crm_points_ledger" SET "tenant_id" = 'tenant-default' WHERE "tenant_id" IS NULL;

-- crm_rewards
ALTER TABLE "crm_rewards" ADD COLUMN "tenant_id" TEXT;
CREATE INDEX "crm_rewards_tenant_id_idx" ON "crm_rewards"("tenant_id");
UPDATE "crm_rewards" SET "tenant_id" = 'tenant-default' WHERE "tenant_id" IS NULL;

-- crm_reward_redemptions
ALTER TABLE "crm_reward_redemptions" ADD COLUMN "tenant_id" TEXT;
CREATE INDEX "crm_reward_redemptions_tenant_id_idx" ON "crm_reward_redemptions"("tenant_id");
UPDATE "crm_reward_redemptions" SET "tenant_id" = 'tenant-default' WHERE "tenant_id" IS NULL;

-- crm_referrals
ALTER TABLE "crm_referrals" ADD COLUMN "tenant_id" TEXT;
CREATE INDEX "crm_referrals_tenant_id_idx" ON "crm_referrals"("tenant_id");
UPDATE "crm_referrals" SET "tenant_id" = 'tenant-default' WHERE "tenant_id" IS NULL;

-- crm_dead_letter_jobs
ALTER TABLE "crm_dead_letter_jobs" ADD COLUMN "tenant_id" TEXT;
CREATE INDEX "crm_dead_letter_jobs_tenant_id_idx" ON "crm_dead_letter_jobs"("tenant_id");
UPDATE "crm_dead_letter_jobs" SET "tenant_id" = 'tenant-default' WHERE "tenant_id" IS NULL;
