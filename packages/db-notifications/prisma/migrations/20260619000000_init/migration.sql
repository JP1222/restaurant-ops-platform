-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "NotificationSeverity" AS ENUM ('crit', 'warn', 'info');

-- CreateEnum
CREATE TYPE "NotificationCategory" AS ENUM ('sales', 'inv', 'dev', 'cost', 'intg');

-- CreateEnum
CREATE TYPE "NotificationMinSeverity" AS ENUM ('all', 'warn', 'crit');

-- CreateTable
CREATE TABLE "notifications" (
    "id" TEXT NOT NULL,
    "severity" "NotificationSeverity" NOT NULL,
    "category" "NotificationCategory" NOT NULL,
    "category_label" TEXT NOT NULL,
    "icon" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "detail" TEXT NOT NULL,
    "action_label" TEXT NOT NULL,
    "action_icon" TEXT NOT NULL,
    "action_href" TEXT NOT NULL,
    "ai" JSONB,
    "location_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_states" (
    "id" TEXT NOT NULL,
    "notification_id" TEXT NOT NULL,
    "operator_id" TEXT NOT NULL,
    "read" BOOLEAN NOT NULL DEFAULT false,
    "snoozed_until" TIMESTAMP(3),
    "dismissed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notification_states_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_prefs" (
    "operator_id" TEXT NOT NULL,
    "quiet" BOOLEAN NOT NULL DEFAULT true,
    "quiet_from" TEXT NOT NULL DEFAULT '10:00 PM',
    "quiet_to" TEXT NOT NULL DEFAULT '7:00 AM',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notification_prefs_pkey" PRIMARY KEY ("operator_id")
);

-- CreateTable
CREATE TABLE "notification_category_prefs" (
    "id" TEXT NOT NULL,
    "operator_id" TEXT NOT NULL,
    "category" "NotificationCategory" NOT NULL,
    "inapp" BOOLEAN NOT NULL DEFAULT true,
    "email" BOOLEAN NOT NULL DEFAULT false,
    "push" BOOLEAN NOT NULL DEFAULT false,
    "min_severity" "NotificationMinSeverity" NOT NULL DEFAULT 'all',

    CONSTRAINT "notification_category_prefs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "notifications_created_at_idx" ON "notifications"("created_at");

-- CreateIndex
CREATE INDEX "notification_states_operator_id_idx" ON "notification_states"("operator_id");

-- CreateIndex
CREATE UNIQUE INDEX "notification_states_notification_id_operator_id_key" ON "notification_states"("notification_id", "operator_id");

-- CreateIndex
CREATE UNIQUE INDEX "notification_category_prefs_operator_id_category_key" ON "notification_category_prefs"("operator_id", "category");

-- AddForeignKey
ALTER TABLE "notification_states" ADD CONSTRAINT "notification_states_notification_id_fkey" FOREIGN KEY ("notification_id") REFERENCES "notifications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_category_prefs" ADD CONSTRAINT "notification_category_prefs_operator_id_fkey" FOREIGN KEY ("operator_id") REFERENCES "notification_prefs"("operator_id") ON DELETE CASCADE ON UPDATE CASCADE;

