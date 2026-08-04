import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../prisma/generated/client/index.js";

export * from "../prisma/generated/client/index.js";

export function createPrismaClient(connectionString = process.env.DATABASE_URL): PrismaClient {
  if (!connectionString) {
    throw new Error("DATABASE_URL is required to create a Prisma client");
  }
  return new PrismaClient({ adapter: new PrismaPg(connectionString) });
}
