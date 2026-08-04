-- AlterTable
ALTER TABLE "inventory_recipes" ADD COLUMN     "clover_item_id" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "inventory_recipes_clover_item_id_key" ON "inventory_recipes"("clover_item_id");

