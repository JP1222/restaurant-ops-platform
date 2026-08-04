// Shared Testcontainers helpers for integration tests. Generic primitives only
// — app-specific composition (which migrations to run, how to build the app)
// lives in each app's `tests/integration/fixture.ts`.
//
// See docs/LOCAL-DEV-GUIDE.md ("Writing an integration test") for the pattern,
// and ADR-0026 for why integration tests are split from the unit suite.
export { assertDockerAvailable } from "./docker.js";
export { startPostgres, type StartedPostgres } from "./postgres.js";
export { startRedis, type StartedRedis } from "./redis.js";
export { deployPrismaMigrations, runPackageScript, type PrismaPackage } from "./prisma.js";
export {
  truncateAll,
  prismaSqlRunner,
  type SqlRunner,
  type RawSqlCapable,
  type TruncateOptions,
} from "./truncate.js";
