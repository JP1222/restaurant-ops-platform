ALTER TABLE "clover_merchants"
ADD COLUMN "refreshTokenExpiresAt" TIMESTAMP(3),
ADD COLUMN "recoveryToken" TEXT;
