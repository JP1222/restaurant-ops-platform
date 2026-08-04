-- Lean per-call AI usage ledger backing the Settings → AI Assistant "Usage & cost"
-- view (design handoff Phase C). One row per AI model call — chat, invoice
-- vision-scan, receipt matcher, emoji suggest — tagged by `feature` + `modelId`
-- with token counts, so spend can be aggregated by model + feature. Distinct from
-- ai_messages (conversation CONTENT, chat-only): this is content-free analytics.
--
-- COMPATIBILITY / ROLLBACK: purely ADDITIVE — a new standalone table with no FK
-- into existing tables. Nothing reads it until the /api/ai/usage endpoint ships,
-- and writes are fire-and-forget (a failure here never fails the underlying AI
-- call). Rolling back is `DROP TABLE "ai_usage_events"`; no existing data is touched.

-- CreateTable
CREATE TABLE "ai_usage_events" (
    "id" TEXT NOT NULL,
    "feature" TEXT NOT NULL,
    "modelId" TEXT NOT NULL,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_usage_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ai_usage_events_createdAt_idx" ON "ai_usage_events"("createdAt");
