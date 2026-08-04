-- AppSetting schema V2 (issue #245): multi-tenant scaffolding.
-- Adds merchantId column with column-level DEFAULT so existing rows backfill
-- without a separate data step, then promotes the primary key from `key`
-- alone to the composite (merchantId, key). The default value
-- 'default-merchant' is the single hardcoded tenant until a future
-- multi-tenant ADR (see apps/backoffice-web/lib/settings/tenancy.ts).

-- AddColumn (existing rows get 'default-merchant')
ALTER TABLE "app_setting" ADD COLUMN "merchantId" TEXT NOT NULL DEFAULT 'default-merchant';

-- DropPrimaryKey (old single-column PK on key)
ALTER TABLE "app_setting" DROP CONSTRAINT "app_setting_pkey";

-- AddPrimaryKey (new composite PK enforces (merchantId, key) uniqueness)
ALTER TABLE "app_setting" ADD CONSTRAINT "app_setting_pkey" PRIMARY KEY ("merchantId", "key");
