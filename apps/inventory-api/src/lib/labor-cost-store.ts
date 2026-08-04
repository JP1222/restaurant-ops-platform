import type { LaborCostSave, LaborCostSnapshot } from "@rop/contracts";
import type { PrismaClient } from "@rop/db-inventory";

import { DEFAULT_LOCATION_ID } from "./inventory-store.js";

// Upsert an effective-dated labor-cost row for a location (ADR-0033 Phase 4b). A wage
// change recorded at the same effective_from overwrites that row; a new effective_from
// opens a new row, so historical prime cost stays point-in-time correct (the analytics
// MV picks the latest effective_from <= business_date).
export async function saveLaborCost(
  prisma: PrismaClient,
  body: LaborCostSave,
  locationId: string = DEFAULT_LOCATION_ID
) {
  return prisma.inventoryLaborCost.upsert({
    where: { locationId_effectiveFrom: { locationId, effectiveFrom: body.effective_from } },
    create: {
      locationId,
      effectiveFrom: body.effective_from,
      dailyLaborCostCents: body.daily_labor_cost_cents,
      currency: body.currency,
      note: body.note ?? null
    },
    update: {
      dailyLaborCostCents: body.daily_labor_cost_cents,
      currency: body.currency,
      note: body.note ?? null
    }
  });
}

// All effective-dated labor rows as analytics-shaped snapshots, stamped with the
// store's Clover merchant id — the key analytics' mart.dim_labor_cost joins on. Returns
// [] when no merchant is configured: nothing maps to the mart, so analytics ingests
// nothing rather than writing rows under a guessed key. Single-merchant today — every
// location maps to the one configured merchant; per-location merchant mapping is the
// multi-location follow-up (ADR-0018).
export async function listLaborCostSnapshots(
  prisma: PrismaClient,
  merchantId: string | undefined
): Promise<LaborCostSnapshot[]> {
  if (!merchantId) {
    return [];
  }
  const rows = await prisma.inventoryLaborCost.findMany({ orderBy: { effectiveFrom: "asc" } });
  return rows.map((row) => ({
    merchant_id: merchantId,
    daily_labor_cost_cents: row.dailyLaborCostCents,
    currency: row.currency,
    effective_from: row.effectiveFrom,
    note: row.note
  }));
}
