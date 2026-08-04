import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "../generated/client/index.js";

export * from "../generated/client/index.js";

// Prisma 7 uses driver adapters; the connection string comes from
// INVENTORY_DATABASE_URL (Iron Law 1 — inventory owns its own database).
export function createPrismaClient(
  connectionString = process.env.INVENTORY_DATABASE_URL
): PrismaClient {
  if (!connectionString) {
    throw new Error("INVENTORY_DATABASE_URL is required to create a Prisma client");
  }
  return new PrismaClient({ adapter: new PrismaPg(connectionString) });
}
