CREATE TYPE "WebAdminRole" AS ENUM ('ADMIN');

CREATE TABLE "web_admin_accounts" (
    "id" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "role" "WebAdminRole" NOT NULL DEFAULT 'ADMIN',
    "passwordHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "web_admin_accounts_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "web_authn_credentials" (
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

CREATE UNIQUE INDEX "web_admin_accounts_username_key" ON "web_admin_accounts"("username");
CREATE UNIQUE INDEX "web_authn_credentials_credentialId_key" ON "web_authn_credentials"("credentialId");
CREATE INDEX "web_authn_credentials_accountId_createdAt_idx" ON "web_authn_credentials"("accountId", "createdAt");

ALTER TABLE "web_authn_credentials"
ADD CONSTRAINT "web_authn_credentials_accountId_fkey"
FOREIGN KEY ("accountId") REFERENCES "web_admin_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
