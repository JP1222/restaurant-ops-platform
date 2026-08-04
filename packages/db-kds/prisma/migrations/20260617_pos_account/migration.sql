-- Unified PosAccount/PosStore model (docs/square-onboarding.md + the Square
-- onboarding ADR). Introduces `pos_accounts` as the first-class POS credential
-- entity. A PosAccount (the token) fans out to one or more per-store rows
-- (`clover_merchants`, the "PosStore" binding) via clover_merchants.posAccountId.
-- Clover = an account that fans out to exactly one store (account == store);
-- Square = one account fanning out to N locations.
--
-- COMPATIBILITY / ROLLBACK: this migration is purely ADDITIVE. The legacy
-- credential columns on clover_merchants (accessToken, refreshToken,
-- tokenExpiresAt, refreshTokenExpiresAt, authStatus, region) are LEFT IN PLACE
-- and still populated, so the running Clover path keeps reading them unchanged
-- (dual-read). A later, separately-checkpointed migration drops them once all
-- readers move to PosAccount. Rolling this back is dropping pos_accounts + the
-- two new clover_merchants columns; no data on the existing path is lost.

-- CreateTable
CREATE TABLE "pos_accounts" (
    "id" TEXT NOT NULL,
    "provider" "OrderProvider" NOT NULL,
    "providerMerchantId" TEXT NOT NULL,
    "environment" "IntegrationEnvironment" NOT NULL DEFAULT 'PRODUCTION',
    "accessToken" TEXT NOT NULL,
    "refreshToken" TEXT,
    "tokenExpiresAt" TIMESTAMP(3),
    "refreshTokenExpiresAt" TIMESTAMP(3),
    "authStatus" "MerchantAuthStatus" NOT NULL DEFAULT 'PENDING',
    "region" TEXT NOT NULL DEFAULT 'US',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pos_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "pos_accounts_provider_providerMerchantId_environment_key" ON "pos_accounts"("provider", "providerMerchantId", "environment");

-- AlterTable
ALTER TABLE "clover_merchants" ADD COLUMN "providerStoreId" TEXT;
ALTER TABLE "clover_merchants" ADD COLUMN "posAccountId" TEXT;

-- CreateIndex
CREATE INDEX "clover_merchants_posAccountId_idx" ON "clover_merchants"("posAccountId");

-- AddForeignKey
ALTER TABLE "clover_merchants" ADD CONSTRAINT "clover_merchants_posAccountId_fkey" FOREIGN KEY ("posAccountId") REFERENCES "pos_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Backfill: one CLOVER PosAccount per existing CLOVER store row. Deterministic id
-- ('acct_' || merchant id) so the UPDATE below needs no join; the INSERT runs
-- before the UPDATE in the same migration transaction, so every linked
-- posAccountId already has its row (FK satisfied). The token is COPIED to the
-- account (not moved) — the legacy columns on clover_merchants remain
-- authoritative until a later migration. providerStoreId = the row id, which for
-- Clover is the merchantId. No-op on a fresh database.
--
-- The WHERE guard skips non-Clover store rows. clover_merchants has no `provider`
-- column, so we discriminate on the placeholder-token convention (ADR-0019):
-- non-API providers (e.g. Deliverect) store a sentinel `<provider>:webhook`
-- accessToken rather than a real OAuth token. Those rows are intentionally left
-- UNLINKED (posAccountId NULL) — they are not Clover accounts and must not be
-- backfilled as CLOVER; their own provider's PosAccount is created when that
-- provider's onboarding lands. Prod holds only Clover today, so in practice this
-- guard is a defensive no-op there, but it keeps a Deliverect-seeded dev DB clean.
INSERT INTO "pos_accounts" (
    "id", "provider", "providerMerchantId", "environment", "accessToken",
    "refreshToken", "tokenExpiresAt", "refreshTokenExpiresAt", "authStatus",
    "region", "createdAt", "updatedAt"
)
SELECT
    'acct_' || "id",
    'CLOVER'::"OrderProvider",
    "id",
    'PRODUCTION'::"IntegrationEnvironment",
    "accessToken",
    "refreshToken",
    "tokenExpiresAt",
    "refreshTokenExpiresAt",
    "authStatus",
    "region",
    now(),
    now()
FROM "clover_merchants"
WHERE "accessToken" NOT LIKE '%:webhook';

UPDATE "clover_merchants"
SET "posAccountId" = 'acct_' || "id",
    "providerStoreId" = "id"
WHERE "accessToken" NOT LIKE '%:webhook';
