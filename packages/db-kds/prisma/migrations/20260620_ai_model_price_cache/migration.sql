-- Cached AI model price table, synced from LiteLLM's public price map by the
-- Settings → AI "Refresh prices" action and the weekly cron. A single row
-- (id = 'litellm') holds the provider-filtered catalog as JSON so the Usage &
-- cost estimate can price any selected model without a code change. The cost
-- read path falls back to the committed price table when this is empty.
CREATE TABLE "ai_model_price_cache" (
    "id" TEXT NOT NULL,
    "prices" JSONB NOT NULL,
    "modelCount" INTEGER NOT NULL DEFAULT 0,
    "source" TEXT NOT NULL DEFAULT 'litellm',
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_model_price_cache_pkey" PRIMARY KEY ("id")
);
