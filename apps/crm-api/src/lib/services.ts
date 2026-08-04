import { createPrismaClient, type PrismaClient } from "@rop/db-crm";

import { loadConfig, type AppConfig } from "../config.js";

export interface AppServices {
  config: AppConfig;
  prisma: PrismaClient;
}

// crm-api is the ONLY app that constructs the db-crm client (Iron Law 1,
// ADR-0021 — eslint carve-out in eslint.config.mjs). Everyone else calls this
// service over HTTP.
export function createServices(config: AppConfig = loadConfig()): AppServices {
  const prisma = createPrismaClient(config.crmDatabaseUrl);
  return { config, prisma };
}
