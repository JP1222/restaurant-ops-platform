import { createPrismaClient, type PrismaClient } from "@rop/db-inventory";

import { loadConfig, type AppConfig } from "../config.js";
import { createNotificationsEmitter, type NotificationsEmitter } from "./notifications-client.js";

export interface AppServices {
  config: AppConfig;
  prisma: PrismaClient;
  // Producer emitter → notifications-api ingest. Optional so existing test
  // harnesses that build services as a literal keep working; routes fall back to
  // one built from config when absent, and tests can inject a fake to assert emits.
  notifications?: NotificationsEmitter;
}

export function createServices(config: AppConfig = loadConfig()): AppServices {
  // Multi-tenant RLS (ADR-0818 / #902 Phase 1): the app runs on the runtime role
  // when provisioned (the non-superuser, RLS-forced `yr_app`), else the owner URL.
  // Migrations always use the owner `inventoryDatabaseUrl`.
  const prisma = createPrismaClient(config.inventoryRuntimeDatabaseUrl ?? config.inventoryDatabaseUrl);
  const notifications = createNotificationsEmitter({
    baseUrl: config.notificationsApiUrl,
    token: config.notificationsInternalToken
  });
  return { config, prisma, notifications };
}
