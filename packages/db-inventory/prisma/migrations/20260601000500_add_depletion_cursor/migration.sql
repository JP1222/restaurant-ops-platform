-- CreateTable
CREATE TABLE "inventory_depletion_cursor" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "cursor" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "inventory_depletion_cursor_pkey" PRIMARY KEY ("id")
);

