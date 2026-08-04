-- Settings hardening, audit-2026-05-27 wave 2 (issues #177 + #159).
--
-- Two changes, one migration:
--   #177  optimistic last-write-wins -> add app_setting.version (Int, default 0).
--   #159  immutable change log       -> new app_setting_audit table.
--
-- Compatibility / rollback:
--   * app_setting.version has a column-level DEFAULT 0, so every existing row
--     backfills in place — no separate data step, no downtime. Rollback is a
--     plain DROP COLUMN (no dependent objects).
--   * app_setting_audit is purely additive (new table); dropping it has no
--     effect on the live app_setting value. The write path tolerates the table
--     being empty (first write after deploy logs from oldValue=NULL).

-- #177: optimistic-concurrency counter on the existing settings row.
ALTER TABLE "app_setting" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 0;

-- #159: append-only audit log. changedByUsername is denormalized so deleting an
-- admin account (db-auth, a separate schema) never breaks audit reads.
CREATE TABLE "app_setting_audit" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL DEFAULT 'default-merchant',
    "key" TEXT NOT NULL,
    "oldValue" TEXT,
    "newValue" TEXT,
    "changedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "changedBy" TEXT,
    "changedByUsername" TEXT,

    CONSTRAINT "app_setting_audit_pkey" PRIMARY KEY ("id")
);

-- Hot read path: "history of this key, newest first".
CREATE INDEX "app_setting_audit_merchantId_key_changedAt_idx" ON "app_setting_audit"("merchantId", "key", "changedAt" DESC);

-- Cross-key recent-activity feed.
CREATE INDEX "app_setting_audit_changedAt_idx" ON "app_setting_audit"("changedAt" DESC);
