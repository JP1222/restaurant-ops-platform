import { createPrismaClient as createAuthPrismaClient, type PrismaClient as AuthPrismaClient } from "@rop/db-auth";
import { createPrismaClient, type PrismaClient as KdsPrismaClient } from "@rop/db-kds";
import type { FastifyInstance } from "fastify";
import { Redis } from "ioredis";

import { buildApp } from "../../src/app.js";
import { ConfigSchema } from "../../src/config.js";
import { createServices, type AppServices } from "../../src/lib/services.js";
import { deployPrismaMigrations, startPostgres, startRedis } from "../../../../test/containers/index.js";

export interface KdsItContext {
  prismaKds: KdsPrismaClient;
  prismaAuth: AuthPrismaClient;
  redis: Redis;
  stop: () => Promise<void>;
}

/**
 * Boot the kds-api backing stack: ONE Postgres carrying BOTH the db-kds and
 * db-auth schemas (ADR-0015 — they share one physical database, applied as two
 * separate `migrate deploy` runs in the production order) plus a real Redis
 * (kds-api's pub/sub + queue + rate-limiter transport).
 *
 * Deliberately wires the clients directly rather than booting `buildApp` /
 * `createServices`: the unique thing to prove here is the shared-database
 * mechanic and the Redis helper. The full-app HTTP variant lives in
 * `startKdsHttpItContext` below.
 */
export async function startKdsItContext(): Promise<KdsItContext> {
  const pg = await startPostgres();
  await deployPrismaMigrations("db-kds", pg.url);
  await deployPrismaMigrations("db-auth", pg.url);

  const prismaKds = createPrismaClient(pg.url);
  const prismaAuth = createAuthPrismaClient(pg.url);

  const redisStarted = await startRedis();
  const redis = new Redis(redisStarted.url);

  return {
    prismaKds,
    prismaAuth,
    redis,
    stop: async () => {
      redis.disconnect();
      await Promise.allSettled([prismaKds.$disconnect(), prismaAuth.$disconnect()]);
      await Promise.allSettled([redisStarted.stop(), pg.stop()]);
    },
  };
}

export interface KdsHttpItContext {
  app: FastifyInstance;
  services: AppServices;
  stop: () => Promise<void>;
}

/**
 * Boot the FULL kds-api Fastify app over real infrastructure: one Postgres
 * (db-kds + db-auth, ADR-0015) + one Redis, wired through the real
 * `createServices` -> `buildApp` path. `buildApp` runs `initializeAppServices`
 * (hub.start() psubscribes Redis, route registration, etc.), so this exercises
 * the actual boot sequence — not a stub.
 *
 * Teardown is clean: RealtimeHub.start only psubscribes (no timers), and
 * `app.close()`'s onClose hook closes the BullMQ queue, quits both Redis
 * connections, and disconnects Prisma.
 */
export async function startKdsHttpItContext(
  configOverrides: Record<string, unknown> = {}
): Promise<KdsHttpItContext> {
  const pg = await startPostgres();
  await deployPrismaMigrations("db-kds", pg.url);
  await deployPrismaMigrations("db-auth", pg.url);
  const redisStarted = await startRedis();

  // ConfigSchema applies defaults for every field except the two required URLs.
  // `configOverrides` lets a suite boot a non-default config (e.g.
  // multiTenantMode: "enforce") without forking this fixture.
  const config = ConfigSchema.parse({
    databaseUrl: pg.url,
    redisUrl: redisStarted.url,
    nodeEnv: "test",
    ...configOverrides,
  });
  const services = createServices(config);
  const app = await buildApp(services);
  await app.ready();

  return {
    app,
    services,
    stop: async () => {
      await app.close();
      await Promise.allSettled([redisStarted.stop(), pg.stop()]);
    },
  };
}
