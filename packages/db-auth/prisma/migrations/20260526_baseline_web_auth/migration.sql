-- Idempotent baseline for db-auth (see ADR-0015).
--
-- This migration runs cleanly in two deployment shapes:
--   1. Existing environments where db-kds's `20260422_web_auth_passkeys`
--      already created these tables. Every statement here is a no-op due
--      to the IF NOT EXISTS / pg_catalog guards.
--   2. Fresh clones (CI ephemeral Postgres, new dev machines) where the
--      tables don't yet exist. The statements create them.
--
-- The db-kds `20260422_web_auth_passkeys` migration folder is intentionally
-- retained as historical truth; db-kds's schema no longer claims these
-- tables, but its `_prisma_migrations` row stays valid so `migrate deploy`
-- doesn't trip on a missing entry.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE t.typname = 'WebAdminRole' AND n.nspname = 'public'
  ) THEN
    CREATE TYPE "WebAdminRole" AS ENUM ('ADMIN');
  END IF;
END$$;

CREATE TABLE IF NOT EXISTS "web_admin_accounts" (
    "id" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "role" "WebAdminRole" NOT NULL DEFAULT 'ADMIN',
    "passwordHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "web_admin_accounts_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "web_authn_credentials" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "credentialId" TEXT NOT NULL,
    "webauthnUserId" TEXT NOT NULL,
    "publicKey" BYTEA NOT NULL,
    "counter" INTEGER NOT NULL DEFAULT 0,
    "deviceType" TEXT NOT NULL,
    "backedUp" BOOLEAN NOT NULL DEFAULT false,
    "transports" JSONB,
    "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "web_authn_credentials_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "web_admin_accounts_username_key" ON "web_admin_accounts"("username");
CREATE UNIQUE INDEX IF NOT EXISTS "web_authn_credentials_credentialId_key" ON "web_authn_credentials"("credentialId");
CREATE INDEX IF NOT EXISTS "web_authn_credentials_accountId_createdAt_idx" ON "web_authn_credentials"("accountId", "createdAt");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'web_authn_credentials_accountId_fkey'
  ) THEN
    ALTER TABLE "web_authn_credentials"
    ADD CONSTRAINT "web_authn_credentials_accountId_fkey"
    FOREIGN KEY ("accountId") REFERENCES "web_admin_accounts"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END$$;
