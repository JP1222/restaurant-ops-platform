-- CreateTable
CREATE TABLE "inventory_recipe_modifiers" (
    "id" TEXT NOT NULL,
    "recipe_id" TEXT NOT NULL,
    "group_name" TEXT NOT NULL,
    "option_name" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "qty_delta" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "inventory_recipe_modifiers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "inventory_recipe_modifiers_recipe_id_idx" ON "inventory_recipe_modifiers"("recipe_id");

-- AddForeignKey
ALTER TABLE "inventory_recipe_modifiers" ADD CONSTRAINT "inventory_recipe_modifiers_recipe_id_fkey" FOREIGN KEY ("recipe_id") REFERENCES "inventory_recipes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
