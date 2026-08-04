-- Labor-cost reference table (ADR-0033, Phase 4b).
--
-- inventory-api is the write-source for analytics' prime-cost labor leg: analytics is
-- read-only OLAP and Backoffice cannot write its mart (Iron Law 5), so labor cost —
-- like plate cost (ADR-0031) — originates here and analytics ingests it over HTTP into
-- mart.dim_labor_cost. Effective-dated: a wage change opens a new (location,
-- effective_from) row so past prime cost stays point-in-time correct. Location-scoped
-- like the rest of inventory; the read endpoint maps location -> the store's Clover
-- merchant id. daily_labor_cost_cents is the all-in labor bill modeled per operating
-- day (weekly bill / days open); double precision (sub-cent, like cost_cents).
--
-- Additive + safe on live data: a brand-new table, no existing-row impact. Rollback:
-- DROP TABLE "inventory_labor_costs".

-- CreateTable
CREATE TABLE "inventory_labor_costs" (
    "location_id" TEXT NOT NULL DEFAULT 'default-location',
    "effective_from" TEXT NOT NULL,
    "daily_labor_cost_cents" DOUBLE PRECISION NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "inventory_labor_costs_pkey" PRIMARY KEY ("location_id","effective_from")
);

-- CreateIndex
CREATE INDEX "inventory_labor_costs_location_id_idx" ON "inventory_labor_costs"("location_id");
