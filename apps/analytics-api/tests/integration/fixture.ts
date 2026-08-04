import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { AppConfig } from "../../src/config.js";
import { createPool, type DbPool } from "../../src/db.js";
import { runMigrations } from "../../src/migrate.js";
import { startPostgres, truncateAll } from "../../../../test/containers/index.js";

// Resolved from this file's location (not cwd) so the raw-SQL runner finds the
// migrations regardless of where vitest is invoked from.
const MIGRATIONS_DIR = fileURLToPath(new URL("../../sql/migrations", import.meta.url));

/** Versions the runner should record, derived from the committed .sql files. */
export const MIGRATION_VERSIONS = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith(".sql"))
  .map((f) => f.replace(/\.sql$/, ""))
  .sort();

// analytics persists across these schemas (sql/migrations/001_init.sql). Wiped
// between assertions; the audit.schema_migrations ledger is preserved by
// truncateAll's default exclude.
const DATA_SCHEMAS = ["public", "raw", "staging", "mart", "meta", "audit"];

export interface AnalyticsItContext {
  pool: DbPool;
  /** Re-run the migration runner — used to assert idempotency. */
  migrate: () => Promise<void>;
  truncate: () => Promise<void>;
  stop: () => Promise<void>;
}

/**
 * Boot an ephemeral analytics database: throwaway Postgres -> the app's own
 * raw-SQL migration runner (no Prisma). Exercises the real `createPool` +
 * `runMigrations` the service boots with.
 */
export async function startAnalyticsItContext(): Promise<AnalyticsItContext> {
  const pg = await startPostgres();
  // createPool only reads config.databaseUrl; the cast avoids constructing the
  // full ~40-field analytics config just to open a pool in a test.
  const pool = createPool({ databaseUrl: pg.url } as unknown as AppConfig);

  // `stop()` kills the ephemeral container; Postgres then sends 57P01
  // (admin_shutdown) to any pooled connection still open. pg surfaces such
  // idle-client failures on the Pool's `error` event, and an `error` event with
  // no listener is rethrown as an *uncaught exception* — which vitest reports as
  // an "Unhandled Error" after the suite has already passed, flaking the exit
  // code (CI run 27073055711). Awaiting `pool.end()` before `pg.stop()` narrows
  // but cannot fully close the window (a socket can still error mid-shutdown), so
  // own the channel: once teardown begins the error is expected and swallowed;
  // before teardown an idle-client error is a genuine fault and is rethrown so
  // the suite still fails loudly.
  let tearingDown = false;
  pool.on("error", (err) => {
    if (tearingDown) return;
    throw err;
  });

  await runMigrations(pool, MIGRATIONS_DIR);

  return {
    pool,
    migrate: () => runMigrations(pool, MIGRATIONS_DIR),
    truncate: () =>
      truncateAll(
        (sql) => pool.query(sql).then((r) => r.rows as Array<Record<string, unknown>>),
        { schemas: DATA_SCHEMAS },
      ),
    stop: async () => {
      tearingDown = true;
      await pool.end();
      await pg.stop();
    },
  };
}
