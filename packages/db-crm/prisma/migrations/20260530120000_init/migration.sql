-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "CrmLedgerType" AS ENUM ('EARN', 'REDEEM', 'REVERSE', 'EXPIRE', 'ADJUST', 'BONUS');

-- CreateEnum
CREATE TYPE "CrmLedgerStatus" AS ENUM ('PENDING', 'AVAILABLE', 'REVERSED');

-- CreateEnum
CREATE TYPE "CrmRewardKind" AS ENUM ('FREE_ITEM', 'DISCOUNT', 'DOLLAR_CREDIT');

-- CreateEnum
CREATE TYPE "CrmRedemptionStatus" AS ENUM ('ISSUED', 'REDEEMED', 'EXPIRED', 'VOIDED');

-- CreateEnum
CREATE TYPE "CrmReferralStatus" AS ENUM ('PENDING', 'QUALIFIED', 'REWARDED', 'EXPIRED');

-- CreateTable
CREATE TABLE "crm_customers" (
    "id" TEXT NOT NULL,
    "phone_e164" TEXT NOT NULL,
    "display_name" TEXT,
    "email" TEXT,
    "birth_month" INTEGER,
    "marketing_sms_consent" BOOLEAN NOT NULL DEFAULT false,
    "fraud_hold" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "crm_customers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "crm_loyalty_accounts" (
    "id" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "balance_points" INTEGER NOT NULL DEFAULT 0,
    "pending_points" INTEGER NOT NULL DEFAULT 0,
    "lifetime_earned" INTEGER NOT NULL DEFAULT 0,
    "lifetime_redeemed" INTEGER NOT NULL DEFAULT 0,
    "lifetime_eligible_spend_cents" INTEGER NOT NULL DEFAULT 0,
    "last_activity_at" TIMESTAMP(3),
    "balance_version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "crm_loyalty_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "crm_points_ledger" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "merchant_id" TEXT NOT NULL,
    "location_id" TEXT,
    "type" "CrmLedgerType" NOT NULL,
    "points" INTEGER NOT NULL,
    "status" "CrmLedgerStatus" NOT NULL DEFAULT 'PENDING',
    "source" TEXT NOT NULL,
    "source_id" TEXT,
    "reverses_ledger_id" TEXT,
    "eligible_subtotal_cents" INTEGER,
    "occurred_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "crm_points_ledger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "crm_rewards" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "cost_points" INTEGER NOT NULL,
    "kind" "CrmRewardKind" NOT NULL,
    "value_cents" INTEGER NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "coupon_ttl_days" INTEGER NOT NULL DEFAULT 30,
    "min_lifetime_spend_cents" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "crm_rewards_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "crm_reward_redemptions" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "reward_id" TEXT NOT NULL,
    "ledger_id" TEXT,
    "code" TEXT NOT NULL,
    "status" "CrmRedemptionStatus" NOT NULL DEFAULT 'ISSUED',
    "cost_points" INTEGER NOT NULL,
    "issued_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "redeemed_at" TIMESTAMP(3),
    "redeemed_at_merchant_id" TEXT,

    CONSTRAINT "crm_reward_redemptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "crm_referrals" (
    "id" TEXT NOT NULL,
    "referrer_account_id" TEXT NOT NULL,
    "referred_phone_e164" TEXT NOT NULL,
    "status" "CrmReferralStatus" NOT NULL DEFAULT 'PENDING',
    "qualifying_order_source_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rewarded_at" TIMESTAMP(3),

    CONSTRAINT "crm_referrals_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "crm_customers_phone_e164_key" ON "crm_customers"("phone_e164");

-- CreateIndex
CREATE UNIQUE INDEX "crm_loyalty_accounts_customer_id_key" ON "crm_loyalty_accounts"("customer_id");

-- CreateIndex
CREATE INDEX "crm_points_ledger_account_id_status_idx" ON "crm_points_ledger"("account_id", "status");

-- CreateIndex
CREATE INDEX "crm_points_ledger_reverses_ledger_id_idx" ON "crm_points_ledger"("reverses_ledger_id");

-- CreateIndex
CREATE UNIQUE INDEX "crm_points_ledger_source_source_id_type_key" ON "crm_points_ledger"("source", "source_id", "type");

-- CreateIndex
CREATE UNIQUE INDEX "crm_rewards_slug_key" ON "crm_rewards"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "crm_reward_redemptions_ledger_id_key" ON "crm_reward_redemptions"("ledger_id");

-- CreateIndex
CREATE UNIQUE INDEX "crm_reward_redemptions_code_key" ON "crm_reward_redemptions"("code");

-- CreateIndex
CREATE INDEX "crm_reward_redemptions_account_id_idx" ON "crm_reward_redemptions"("account_id");

-- CreateIndex
CREATE INDEX "crm_referrals_referrer_account_id_idx" ON "crm_referrals"("referrer_account_id");

-- CreateIndex
CREATE INDEX "crm_referrals_referred_phone_e164_idx" ON "crm_referrals"("referred_phone_e164");

-- AddForeignKey
ALTER TABLE "crm_loyalty_accounts" ADD CONSTRAINT "crm_loyalty_accounts_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "crm_customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crm_points_ledger" ADD CONSTRAINT "crm_points_ledger_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "crm_loyalty_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crm_points_ledger" ADD CONSTRAINT "crm_points_ledger_reverses_ledger_id_fkey" FOREIGN KEY ("reverses_ledger_id") REFERENCES "crm_points_ledger"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "crm_reward_redemptions" ADD CONSTRAINT "crm_reward_redemptions_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "crm_loyalty_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crm_reward_redemptions" ADD CONSTRAINT "crm_reward_redemptions_reward_id_fkey" FOREIGN KEY ("reward_id") REFERENCES "crm_rewards"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crm_referrals" ADD CONSTRAINT "crm_referrals_referrer_account_id_fkey" FOREIGN KEY ("referrer_account_id") REFERENCES "crm_loyalty_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
