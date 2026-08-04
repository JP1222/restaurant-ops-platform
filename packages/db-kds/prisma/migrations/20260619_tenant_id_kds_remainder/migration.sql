-- Phase 1 (ADR-0818, multi-tenant platform): finish db-kds `tenant_id` coverage
-- for the AI bounded-exception tables + the provider webhook-bookkeeping table.
-- See docs/architecture/multi-tenant-architecture.md + docs/multi-tenant-migration-roadmap.md.
--
-- COMPATIBILITY / ROLLBACK: purely ADDITIVE + zero-behavior-change. Nullable
-- `tenantId` columns; nothing reads them yet. The AI tables backfill to the
-- single implicit tenant ('tenant-default', seeded in 20260619_tenant_entity).
-- `provider_app_states` is INTENTIONALLY left NULL/global (a shared
-- marketplace-app webhook record is not tenant-owned; per the architecture doc it
-- is gated in the auth layer, never RLS) — so no backfill. Rollback = drop the
-- columns. No FK / no index here (denormalized; index lands with Phase-3 RLS).
--
-- NOTE: the AppSetting / AppSettingAudit scope-sentinel is intentionally NOT here
-- — it needs a PRIMARY-KEY rework (@@id([tenantId, merchantId, key])) coordinated
-- with the settings-resolver code, which is Phase 2 work, not a zero-behavior add.

-- AiConversation
ALTER TABLE "ai_conversations" ADD COLUMN "tenantId" TEXT;
UPDATE "ai_conversations" SET "tenantId" = 'tenant-default' WHERE "tenantId" IS NULL;

-- AiMessage
ALTER TABLE "ai_messages" ADD COLUMN "tenantId" TEXT;
UPDATE "ai_messages" SET "tenantId" = 'tenant-default' WHERE "tenantId" IS NULL;

-- AiUsageEvent
ALTER TABLE "ai_usage_events" ADD COLUMN "tenantId" TEXT;
UPDATE "ai_usage_events" SET "tenantId" = 'tenant-default' WHERE "tenantId" IS NULL;

-- ProviderAppState — tenant-nullable + global; intentionally NOT backfilled.
ALTER TABLE "provider_app_states" ADD COLUMN "tenantId" TEXT;
