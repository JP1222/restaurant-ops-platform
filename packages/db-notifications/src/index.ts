import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "../generated/client/index.js";

export * from "../generated/client/index.js";

// Prisma 7 uses driver adapters; the connection string comes from
// NOTIFICATIONS_DATABASE_URL (Iron Law 1 — the notifications domain owns its own
// database, separate from db-kds / db-inventory / db-crm; see ADR-0801). Only
// apps/notifications-api may construct this client (eslint-enforced); every other
// app reaches it over HTTP.
export function createPrismaClient(
  connectionString = process.env.NOTIFICATIONS_DATABASE_URL
): PrismaClient {
  if (!connectionString) {
    throw new Error("NOTIFICATIONS_DATABASE_URL is required to create a Prisma client");
  }
  return new PrismaClient({ adapter: new PrismaPg(connectionString) });
}
