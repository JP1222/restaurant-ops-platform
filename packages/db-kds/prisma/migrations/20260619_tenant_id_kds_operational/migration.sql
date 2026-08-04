-- Phase 1 (ADR-0818, multi-tenant platform): stamp `tenant_id` onto the db-kds
-- POS/KDS OPERATIONAL tables — the denormalized cross-tenant scope column that
-- Phase-3 RLS will key on (single-column compare, no JOIN). See
-- docs/architecture/multi-tenant-architecture.md + docs/multi-tenant-migration-roadmap.md.
--
-- COMPATIBILITY / ROLLBACK: purely ADDITIVE + zero-behavior-change. Each table
-- gets a NULLABLE `tenantId` backfilled to the single implicit tenant
-- ('tenant-default', seeded in 20260619_tenant_entity). NOTHING reads tenant_id
-- yet. No FK (denormalized copy; the canonical chain is merchant -> Location ->
-- Tenant) and no per-table index here — the index lands with the Phase-3 RLS
-- migration once query patterns are known, to avoid a single-value index on hot
-- write tables while there is one tenant. A later migration sets NOT NULL once
-- writers stamp it (Phase 2). Rollback = drop the columns. Backfill is a no-op
-- on a fresh DB.
--
-- Deferred to follow-up migrations: the AppSetting/AppSettingAudit scope-sentinel
-- (needs a PK rework, not a plain column), the ai_conversations/ai_messages
-- tables, and provider_app_states (kept tenant-nullable / global).

-- PosAccount
ALTER TABLE "pos_accounts" ADD COLUMN "tenantId" TEXT;
UPDATE "pos_accounts" SET "tenantId" = 'tenant-default' WHERE "tenantId" IS NULL;

-- CloverMerchant
ALTER TABLE "clover_merchants" ADD COLUMN "tenantId" TEXT;
UPDATE "clover_merchants" SET "tenantId" = 'tenant-default' WHERE "tenantId" IS NULL;

-- KdsDeviceToken
ALTER TABLE "kds_device_tokens" ADD COLUMN "tenantId" TEXT;
UPDATE "kds_device_tokens" SET "tenantId" = 'tenant-default' WHERE "tenantId" IS NULL;

-- CloverOrder
ALTER TABLE "clover_orders" ADD COLUMN "tenantId" TEXT;
UPDATE "clover_orders" SET "tenantId" = 'tenant-default' WHERE "tenantId" IS NULL;

-- KdsTicket
ALTER TABLE "kds_tickets" ADD COLUMN "tenantId" TEXT;
UPDATE "kds_tickets" SET "tenantId" = 'tenant-default' WHERE "tenantId" IS NULL;

-- KdsTicketOverride
ALTER TABLE "kds_ticket_overrides" ADD COLUMN "tenantId" TEXT;
UPDATE "kds_ticket_overrides" SET "tenantId" = 'tenant-default' WHERE "tenantId" IS NULL;

-- KdsTicketItem
ALTER TABLE "kds_ticket_items" ADD COLUMN "tenantId" TEXT;
UPDATE "kds_ticket_items" SET "tenantId" = 'tenant-default' WHERE "tenantId" IS NULL;

-- KdsProviderConfig
ALTER TABLE "kds_provider_configs" ADD COLUMN "tenantId" TEXT;
UPDATE "kds_provider_configs" SET "tenantId" = 'tenant-default' WHERE "tenantId" IS NULL;

-- KdsTicketEvent
ALTER TABLE "kds_ticket_events" ADD COLUMN "tenantId" TEXT;
UPDATE "kds_ticket_events" SET "tenantId" = 'tenant-default' WHERE "tenantId" IS NULL;

-- KdsScreenSession
ALTER TABLE "kds_screen_sessions" ADD COLUMN "tenantId" TEXT;
UPDATE "kds_screen_sessions" SET "tenantId" = 'tenant-default' WHERE "tenantId" IS NULL;

-- KdsFilter
ALTER TABLE "kds_filters" ADD COLUMN "tenantId" TEXT;
UPDATE "kds_filters" SET "tenantId" = 'tenant-default' WHERE "tenantId" IS NULL;

-- CloverWebhookEvent
ALTER TABLE "clover_webhook_events" ADD COLUMN "tenantId" TEXT;
UPDATE "clover_webhook_events" SET "tenantId" = 'tenant-default' WHERE "tenantId" IS NULL;

-- KdsProviderEvent
ALTER TABLE "kds_provider_events" ADD COLUMN "tenantId" TEXT;
UPDATE "kds_provider_events" SET "tenantId" = 'tenant-default' WHERE "tenantId" IS NULL;

-- KdsRealtimeState
ALTER TABLE "kds_realtime_states" ADD COLUMN "tenantId" TEXT;
UPDATE "kds_realtime_states" SET "tenantId" = 'tenant-default' WHERE "tenantId" IS NULL;

-- KdsRealtimeEvent
ALTER TABLE "kds_realtime_events" ADD COLUMN "tenantId" TEXT;
UPDATE "kds_realtime_events" SET "tenantId" = 'tenant-default' WHERE "tenantId" IS NULL;

-- KdsRealtimeReceipt
ALTER TABLE "kds_realtime_receipts" ADD COLUMN "tenantId" TEXT;
UPDATE "kds_realtime_receipts" SET "tenantId" = 'tenant-default' WHERE "tenantId" IS NULL;

-- DeadLetterJob
ALTER TABLE "dead_letter_jobs" ADD COLUMN "tenantId" TEXT;
UPDATE "dead_letter_jobs" SET "tenantId" = 'tenant-default' WHERE "tenantId" IS NULL;
