import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { DbPool } from "./db.js";
import { withTransaction } from "./db.js";
import { createLogger } from "./lib/log.js";
import { AdvisoryNamespace, advisoryKey } from "./scheduler/advisory-lock.js";

const log = createLogger("migrate");

export async function runMigrations(pool: DbPool, migrationsDir = "sql/migrations") {
  const client = await pool.connect();
  const key = advisoryKey("rop-intelligence:migrations");
  try {
    await client.query("SET lock_timeout = '30s'");
    await client.query("SET statement_timeout = '30s'");
    await client.query("SELECT pg_advisory_lock($1, $2)", [AdvisoryNamespace.Migration, key]);
    await client.query("RESET statement_timeout");
    await runMigrationsUnlocked(pool, migrationsDir);
  } finally {
    await client.query("SELECT pg_advisory_unlock($1, $2)", [AdvisoryNamespace.Migration, key]).catch(() => undefined);
    client.release();
  }
}

async function runMigrationsUnlocked(pool: DbPool, migrationsDir = "sql/migrations") {
  await pool.query("CREATE SCHEMA IF NOT EXISTS audit");
  await pool.query(`
    CREATE TABLE IF NOT EXISTS audit.schema_migrations (
      version text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  const files = (await readdir(migrationsDir))
    .filter((file) => file.endsWith(".sql"))
    .sort();

  for (const file of files) {
    const version = file.replace(/\.sql$/, "");
    const existing = await pool.query(
      "SELECT 1 FROM audit.schema_migrations WHERE version = $1",
      [version]
    );
    if (existing.rowCount) {
      continue;
    }

    const sql = await readFile(join(migrationsDir, file), "utf8");
    await withTransaction(pool, async (client) => {
      await client.query(sql);
      await client.query(
        "INSERT INTO audit.schema_migrations(version) VALUES ($1) ON CONFLICT DO NOTHING",
        [version]
      );
    });
    log.info(`Applied migration ${version}`, { version });
  }
}
