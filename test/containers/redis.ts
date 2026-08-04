import { RedisContainer, type StartedRedisContainer } from "@testcontainers/redis";

import { assertDockerAvailable } from "./docker.js";

// Same tag as docker-compose.dev.yml's redis service.
const REDIS_IMAGE = "redis:7-alpine";

export interface StartedRedis {
  /** `redis://host:port` — feed straight to ioredis / BullMQ. */
  url: string;
  container: StartedRedisContainer;
  stop: () => Promise<void>;
}

/**
 * Boot an ephemeral Redis. Only kds-api needs this (BullMQ + pub/sub + rate
 * limiting); inventory-api and analytics-api integration tests use Postgres
 * alone.
 */
export async function startRedis(image = REDIS_IMAGE): Promise<StartedRedis> {
  await assertDockerAvailable();
  const container = await new RedisContainer(image).start();
  return {
    url: container.getConnectionUrl(),
    container,
    stop: () => container.stop().then(() => undefined),
  };
}
