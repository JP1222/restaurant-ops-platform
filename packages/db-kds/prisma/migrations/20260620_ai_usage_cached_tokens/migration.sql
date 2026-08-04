-- Track cache-hit input tokens on the AI usage ledger so cost estimates can price
-- cached tokens at the provider's (much cheaper) cache-hit rate instead of the full
-- input rate. Backfills existing rows to 0 (no cache info known for past events).
ALTER TABLE "ai_usage_events" ADD COLUMN "cachedInputTokens" INTEGER NOT NULL DEFAULT 0;
