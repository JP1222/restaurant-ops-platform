import type { FastifyInstance, FastifyRequest } from "fastify";
import { LaborCostSaveSchema, LaborCostsResponseSchema } from "@rop/contracts";

import type { AppServices } from "../lib/services.js";
import * as store from "../lib/inventory-store.js";
import { listLaborCostSnapshots, saveLaborCost } from "../lib/labor-cost-store.js";

// The store a labor-cost write applies to: the trusted backoffice BFF's `?location=`
// query, else the single-store default. Unlike the inventory routes there is no crew
// actor — labor cost is bearer-only manager config (see the admin guard in app.ts).
function locationFrom(request: FastifyRequest): string {
  const raw = (request.query as { location?: unknown } | undefined)?.location;
  return typeof raw === "string" && raw.length > 0 ? raw : store.DEFAULT_LOCATION_ID;
}

export async function registerLaborCostRoutes(app: FastifyInstance, services: AppServices) {
  const { prisma, config } = services;

  // Labor-cost snapshots for analytics-api's mart.dim_labor_cost ingest (ADR-0033
  // Phase 4b). Open read, exactly like GET /api/recipes/plate-costs: reads are open and
  // analytics pulls this over the internal network with no bearer. Each row is stamped
  // with the store's configured Clover merchant id (the analytics join key).
  app.get("/api/labor-costs", async () => {
    const snapshots = await listLaborCostSnapshots(prisma, config.cloverMerchantId);
    return LaborCostsResponseSchema.parse({ snapshots });
  });

  // Operator labor-cost editor (backoffice BFF -> here). Under /api/admin so the
  // app-level admin guard applies: bearer-only, never a crew session — a logged-in cook
  // cannot set labor cost. merchant_id is NOT taken from the body; it is stamped at read
  // time from the configured store (see GET above), so a single-store dashboard read
  // (which defaults to that merchant) always finds the row. Upserts the effective-dated
  // row; a wage change at a new effective_from keeps history point-in-time correct.
  app.put("/api/admin/labor-costs", async (request, reply) => {
    const parsed = LaborCostSaveSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid labor cost", details: parsed.error.issues });
    }
    const row = await saveLaborCost(prisma, parsed.data, locationFrom(request));
    return reply.code(200).send({
      labor_cost: {
        effective_from: row.effectiveFrom,
        daily_labor_cost_cents: row.dailyLaborCostCents,
        currency: row.currency,
        note: row.note
      }
    });
  });
}
