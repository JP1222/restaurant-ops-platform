-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "inventory_categories" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "inventory_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_items" (
    "id" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "unit" TEXT NOT NULL,
    "on_hand" DOUBLE PRECISION NOT NULL,
    "par_min" DOUBLE PRECISION NOT NULL,
    "par_max" DOUBLE PRECISION NOT NULL,
    "cost_cents" INTEGER NOT NULL,
    "vendor" TEXT NOT NULL,
    "shelf_days" INTEGER NOT NULL,
    "last_counted" TEXT NOT NULL,
    "flagged_86" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "inventory_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_recipes" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "sell_cents" INTEGER NOT NULL,
    "sold_today" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "inventory_recipes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_recipe_lines" (
    "id" TEXT NOT NULL,
    "recipe_id" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "qty" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "inventory_recipe_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_vendors" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "contact" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "account" TEXT NOT NULL,
    "terms" TEXT NOT NULL,
    "min_order_cents" INTEGER NOT NULL,
    "cutoff" TEXT NOT NULL,
    "delivery_days" TEXT[],
    "categories" TEXT[],
    "fill_rate" DOUBLE PRECISION NOT NULL,
    "on_time" DOUBLE PRECISION NOT NULL,
    "price_stability" DOUBLE PRECISION NOT NULL,
    "credits_90d" INTEGER NOT NULL,
    "spend_30d" INTEGER NOT NULL,
    "trend_4w" INTEGER[],
    "preferred" BOOLEAN NOT NULL DEFAULT false,
    "tags" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "inventory_vendors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_vendor_quotes" (
    "id" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "vendor_id" TEXT NOT NULL,
    "cents" INTEGER NOT NULL,
    "primary" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "inventory_vendor_quotes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_purchase_orders" (
    "id" TEXT NOT NULL,
    "vendor" TEXT NOT NULL,
    "placed" TEXT NOT NULL,
    "expected" TEXT NOT NULL,
    "lines" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "total_cents" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "inventory_purchase_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_count_records" (
    "id" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "who" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "items" INTEGER NOT NULL,
    "variance_pct" DOUBLE PRECISION,
    "variance_cents" INTEGER,
    "status" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inventory_count_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_waste_reasons" (
    "id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "color" TEXT NOT NULL,
    "needs_photo_over_cents" INTEGER NOT NULL,

    CONSTRAINT "inventory_waste_reasons_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_waste_entries" (
    "id" TEXT NOT NULL,
    "at" TEXT NOT NULL,
    "who" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "qty" DOUBLE PRECISION NOT NULL,
    "reason" TEXT NOT NULL,
    "notes" TEXT NOT NULL,
    "photo" BOOLEAN NOT NULL DEFAULT false,
    "approved" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inventory_waste_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_activity_entries" (
    "id" TEXT NOT NULL,
    "at" TEXT NOT NULL,
    "who" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "what" TEXT NOT NULL,
    "note" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inventory_activity_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_waste_settings" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "photo_required_over_cents" INTEGER NOT NULL,
    "manager_approval_over_cents" INTEGER NOT NULL,

    CONSTRAINT "inventory_waste_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_metrics" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "cogs_trend" INTEGER[],
    "net_sales_trend" INTEGER[],
    "cogs_target_pct" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "inventory_metrics_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "inventory_items_sku_key" ON "inventory_items"("sku");

-- CreateIndex
CREATE INDEX "inventory_items_category_idx" ON "inventory_items"("category");

-- CreateIndex
CREATE INDEX "inventory_recipe_lines_recipe_id_idx" ON "inventory_recipe_lines"("recipe_id");

-- CreateIndex
CREATE INDEX "inventory_vendor_quotes_sku_idx" ON "inventory_vendor_quotes"("sku");

-- CreateIndex
CREATE INDEX "inventory_waste_entries_sku_idx" ON "inventory_waste_entries"("sku");

-- AddForeignKey
ALTER TABLE "inventory_items" ADD CONSTRAINT "inventory_items_category_fkey" FOREIGN KEY ("category") REFERENCES "inventory_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_recipe_lines" ADD CONSTRAINT "inventory_recipe_lines_recipe_id_fkey" FOREIGN KEY ("recipe_id") REFERENCES "inventory_recipes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

