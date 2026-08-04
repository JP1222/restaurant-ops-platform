import { createPrismaClient, type PrismaClient } from "@rop/db-notifications";

import { loadConfig, type AppConfig } from "../config.js";

export interface AppServices {
  config: AppConfig;
  prisma: PrismaClient;
}

// notifications-api is the ONLY app that constructs the db-notifications client
// (Iron Law 1, ADR-0801 — eslint carve-out in eslint.config.mjs). Everyone else
// (the backoffice BFF included) calls this service over HTTP.
export function createServices(config: AppConfig = loadConfig()): AppServices {
  const prisma = createPrismaClient(config.notificationsDatabaseUrl);
  return { config, prisma };
}
