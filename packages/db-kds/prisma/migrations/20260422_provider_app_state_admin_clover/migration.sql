CREATE TABLE "provider_app_states" (
    "id" TEXT NOT NULL,
    "provider" "OrderProvider" NOT NULL,
    "environment" "IntegrationEnvironment" NOT NULL,
    "latestWebhookVerificationCode" TEXT,
    "latestWebhookVerificationAt" TIMESTAMP(3),
    "lastSignedWebhookAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "provider_app_states_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "provider_app_states_provider_environment_key"
ON "provider_app_states"("provider", "environment");
