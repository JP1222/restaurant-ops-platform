import type { FastifyInstance } from "fastify";
import { ActualCogsInputsResponseSchema } from "@rop/contracts";

import type { AppServices } from "../lib/services.js";
import { listActualCogsWindows } from "../lib/actual-cogs-store.js";

export async function registerActualCogsRoutes(app: FastifyInstance, services: AppServices) {
  const { prisma, config } = services;

  // Count-based actual-COGS windows for analytics' mart.dim_actual_cogs ingest
  // (ADR-0031 yield-variance lens). Open read, exactly like GET /api/labor-costs and
  // GET /api/recipes/plate-costs: analytics pulls this over the internal network with no
  // bearer. Each window is stamped with the store's configured Clover merchant id.
  app.get("/api/actual-cogs-inputs", async () => {
    const snapshots = await listActualCogsWindows(prisma, config.cloverMerchantId);
    return ActualCogsInputsResponseSchema.parse({ snapshots });
  });
}
