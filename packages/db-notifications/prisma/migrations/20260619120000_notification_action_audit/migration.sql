-- CreateTable
CREATE TABLE "notification_action_audit" (
    "id" TEXT NOT NULL,
    "notification_id" TEXT NOT NULL,
    "action_id" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "operator_id" TEXT NOT NULL,
    "operator_role" TEXT NOT NULL,
    "applied_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_action_audit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "notification_action_audit_idempotency_key_key" ON "notification_action_audit"("idempotency_key");

-- CreateIndex
CREATE INDEX "notification_action_audit_notification_id_idx" ON "notification_action_audit"("notification_id");
