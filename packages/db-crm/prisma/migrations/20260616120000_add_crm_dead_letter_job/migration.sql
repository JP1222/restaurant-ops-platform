-- CreateTable
CREATE TABLE "crm_dead_letter_jobs" (
    "id" TEXT NOT NULL,
    "merchant_id" TEXT,
    "job_type" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMP(3),

    CONSTRAINT "crm_dead_letter_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "crm_dead_letter_jobs_created_at_idx" ON "crm_dead_letter_jobs"("created_at");
