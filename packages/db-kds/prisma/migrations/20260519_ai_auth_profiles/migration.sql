-- CreateTable
CREATE TABLE "ai_auth_profiles" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "provider" TEXT NOT NULL DEFAULT 'openai-codex',
    "accountId" TEXT NOT NULL,
    "label" TEXT,
    "accessTokenCipher" BYTEA NOT NULL,
    "refreshTokenCipher" BYTEA NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "lastRefreshedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_auth_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ai_auth_profiles_userId_accountId_key" ON "ai_auth_profiles"("userId", "accountId");

-- CreateIndex
CREATE INDEX "ai_auth_profiles_userId_updatedAt_idx" ON "ai_auth_profiles"("userId", "updatedAt" DESC);
