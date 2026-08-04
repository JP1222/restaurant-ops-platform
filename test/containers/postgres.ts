import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";

import { assertDockerAvailable } from "./docker.js";

// Pin to the SAME image tag as docker-compose.dev.yml so the throwaway test
// database matches what `make dev` runs locally and what prod deploys.
const POSTGRES_IMAGE = "postgres:16-alpine";

export interface StartedPostgres {
  /** `postgresql://user:pass@host:port/db` — feed straight to Prisma / pg. */
  url: string;
  container: StartedPostgreSqlContainer;
  /** Tear the container down (call from `afterAll`). */
  stop: () => Promise<void>;
}

/**
 * Boot an ephemeral Postgres and hand back its connection URL. The caller owns
 * the lifecycle: `await startPostgres()` in `beforeAll`, `stop()` in `afterAll`.
 */
export async function startPostgres(image = POSTGRES_IMAGE): Promise<StartedPostgres> {
  await assertDockerAvailable();
  const container = await new PostgreSqlContainer(image).start();
  return {
    url: container.getConnectionUri(),
    container,
    stop: () => container.stop().then(() => undefined),
  };
}
