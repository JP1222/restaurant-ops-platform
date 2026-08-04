import pg from "pg";
import type { AppConfig } from "./config.js";
import { createLogger, errorMessage } from "./lib/log.js";

const { Pool, types } = pg;

// Keep Postgres `date` columns (OID 1082) as the raw "YYYY-MM-DD" string they are
// on the wire. node-postgres' default parser turns a bare calendar date into a JS
// Date at the *process* timezone's midnight, which JSON.stringify then serializes
// to a UTC instant (e.g. "2026-06-15T00:00:00.000Z" on this UTC container). That
// synthetic instant silently shifts the calendar day across the store-timezone
// boundary, corrupting every downstream `business_date` consumer — weekday
// derivation, is_current_day, and the Today subtitle all break. A `date` has no
// time or zone; readers here either use it in SQL, compare it as a string, or
// format it through luxon, all of which want the plain calendar date.
types.setTypeParser(types.builtins.DATE, (value) => value);

const log = createLogger("db");

export function createPool(config: AppConfig) {
  const pool = new Pool({
    connectionString: config.databaseUrl,
    application_name: "rop-intelligence"
  });

  // A pg.Pool is an EventEmitter. When an *idle* pooled connection dies for a
  // backend reason (Postgres restart/failover, a server-side idle reaper, or
  // 57P01 admin_shutdown), the Pool emits 'error' — and Node rethrows an
  // 'error' event that has no listener as an uncaught exception, which would
  // take down the whole analytics-api process. This listener lets pg discard
  // the dead client and recycle the connection on the next checkout, so a
  // transient DB blip degrades to a logged line instead of a crash. We log and
  // return: swallowing silently would hide a real outage, and process.exit
  // would do the crash we're trying to prevent.
  pool.on("error", handlePoolError);

  return pool;
}

function handlePoolError(error: Error): void {
  // pg/network errors carry a string `code` (SQLSTATE like "57P01", or a libuv
  // code like "ECONNRESET"); surface it as structured context so Loki can split
  // expected failovers from genuine faults. The message is redacted in the
  // logger, so a connection-string echo can't leak here.
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { code?: unknown }).code)
      : undefined;
  log.error(`idle pooled client error: ${errorMessage(error)}`, code ? { code } : undefined);
}

export type DbPool = pg.Pool;
export type DbClient = pg.PoolClient | pg.Client;

export async function withTransaction<T>(pool: DbPool, task: (client: pg.PoolClient) => Promise<T>) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await task(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

