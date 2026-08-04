-- AlterTable: per-usage cost gains sub-cent precision (Int -> Float). Widening is
-- lossless; existing integer cents become their float equivalent (5 -> 5.0).
ALTER TABLE "inventory_items" ALTER COLUMN "cost_cents" SET DATA TYPE DOUBLE PRECISION;

-- AlterTable: purchase -> usage conversion. Defaults keep existing rows valid
-- (pack_qty 1 so a legacy cost_cents is unchanged when re-derived).
ALTER TABLE "inventory_items" ADD COLUMN     "pack_qty" DOUBLE PRECISION NOT NULL DEFAULT 1,
ADD COLUMN     "purchase_cost_cents" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "purchase_unit" TEXT NOT NULL DEFAULT '';
