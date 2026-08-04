import { createPrismaClient, type PrismaClient } from "@rop/db-auth";

import {
  deployPrismaMigrations,
  prismaSqlRunner,
  startPostgres,
  truncateAll,
} from "../../../../test/containers/index.js";

export interface AuthItContext {
  prisma: PrismaClient;
  /** Wipe accounts + credentials between tests (keeps the migration ledger). */
  truncate: () => Promise<void>;
  stop: () => Promise<void>;
}

/**
 * Boot an ephemeral db-auth Postgres: throwaway container -> db-auth migrations
 * -> a real Prisma client. Library-level (no Fastify) — exercises the auth
 * persistence helpers against real tables, the gap the old `describe.skip`
 * placeholder marked.
 */
export async function startAuthItContext(): Promise<AuthItContext> {
  const pg = await startPostgres();
  await deployPrismaMigrations("db-auth", pg.url);
  const prisma = createPrismaClient(pg.url);

  return {
    prisma,
    truncate: () => truncateAll(prismaSqlRunner(prisma)),
    stop: async () => {
      await prisma.$disconnect();
      await pg.stop();
    },
  };
}
