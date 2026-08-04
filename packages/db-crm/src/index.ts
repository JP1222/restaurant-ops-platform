import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "../generated/client/index.js";

export * from "../generated/client/index.js";

// Prisma 7 uses driver adapters; the connection string comes from
// CRM_DATABASE_URL (Iron Law 1 — the loyalty/CRM domain owns its own database,
// separate from postgres-kds; see ADR-0021). Only apps/crm-api may construct
// this client (eslint-enforced); every other app calls crm-api over HTTP.
export function createPrismaClient(
  connectionString = process.env.CRM_DATABASE_URL
): PrismaClient {
  if (!connectionString) {
    throw new Error("CRM_DATABASE_URL is required to create a Prisma client");
  }
  return new PrismaClient({ adapter: new PrismaPg(connectionString) });
}
