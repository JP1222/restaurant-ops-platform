import type { FastifyInstance } from "fastify";

import type { IngestNotificationRequest } from "@rop/contracts";
import { createPrismaClient, type PrismaClient } from "@rop/db-inventory";

import { buildApp } from "../../src/app.js";
import type { AppConfig } from "../../src/config.js";
import {
  deployPrismaMigrations,
  prismaSqlRunner,
  runPackageScript,
  startPostgres,
  truncateAll,
} from "../../../../test/containers/index.js";

export interface InventoryItContext {
  app: FastifyInstance;
  prisma: PrismaClient;
  /** Operator notifications the app emitted (producer signals: 86, low-stock, no-pack nudge). */
  emittedNotifications: IngestNotificationRequest[];
  /** Wipe all table data (keeps schema + migration ledger). */
  truncate: () => Promise<void>;
  /** Close the app (disconnects Prisma via its onClose hook) and drop the container. */
  stop: () => Promise<void>;
}

// Hermetic config: every field is explicit, nothing read from ambient env. The
// container URL is the only moving part. `test` mode keeps the write-guard in
// its dev-permissive branch so route writes don't need a bearer/crew session.
function testConfig(url: string): AppConfig {
  return {
    nodeEnv: "test",
    apiPort: 4100,
    inventoryDatabaseUrl: url,
    backofficeBaseUrl: "http://localhost:3001",
    crewBaseUrl: "http://localhost:3003",
  };
}

/**
 * Boot an ephemeral inventory stack: throwaway Postgres -> db-inventory
 * migrations -> demo seed -> a real Fastify app wired to the container via the
 * `buildApp(services)` injection seam. No app entrypoint is imported, so no
 * eager singleton ever reads `process.env`.
 */
export async function startInventoryItContext(): Promise<InventoryItContext> {
  const pg = await startPostgres();
  await deployPrismaMigrations("db-inventory", pg.url);
  // Seeded data is required: the dataset read throws without the waste-settings /
  // metrics singletons (apps/inventory-api/src/lib/serialize.ts assembleDataset).
  await runPackageScript("db-inventory", "seed", { INVENTORY_DATABASE_URL: pg.url });

  const prisma = createPrismaClient(pg.url);
  // Record producer emits in-process instead of POSTing to a notifications-api. `configured: true`
  // so `emit` actually runs; the route's fire-and-forget call resolves synchronously here, so the
  // payload is captured by the time `app.inject` returns.
  const emittedNotifications: IngestNotificationRequest[] = [];
  const app = await buildApp({
    config: testConfig(pg.url),
    prisma,
    notifications: {
      configured: true,
      emit: async (payload) => {
        emittedNotifications.push(payload);
      },
    },
  });
  await app.ready();

  return {
    app,
    prisma,
    emittedNotifications,
    truncate: () => truncateAll(prismaSqlRunner(prisma)),
    stop: async () => {
      await app.close();
      await pg.stop();
    },
  };
}
