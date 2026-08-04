import type { DbClient, DbPool } from "../db.js";

const SYNC_RUNS_PARTITION_PATTERN = /^sync_runs_(\d{4})m(\d{2})$/;

export async function maintainSyncRunsPartitions(pool: DbPool, now = new Date()) {
  await ensureSyncRunsMonthlyPartitions(pool, now);
  await dropOldSyncRunsPartitions(pool, daysAgo(now, 90));
}

export async function ensureSyncRunsMonthlyPartitions(pool: DbPool, now = new Date()) {
  const current = monthString(now);
  const next = nextMonth(current);
  await ensureSyncRunsMonthlyPartition(pool, current);
  await ensureSyncRunsMonthlyPartition(pool, next);
}

export async function ensureSyncRunsMonthlyPartition(pool: DbPool, month: string) {
  assertMonth(month);
  const partitionName = `sync_runs_${month.replace("-", "m")}`;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("LOCK TABLE audit.sync_runs, audit.sync_runs_default IN SHARE MODE");

    if (await isAttachedSyncRunsPartition(client, partitionName)) {
      await client.query("COMMIT");
      return;
    }

    await client.query(`
      CREATE TABLE IF NOT EXISTS audit.${quoteIdent(partitionName)}
      (LIKE audit.sync_runs INCLUDING DEFAULTS INCLUDING CONSTRAINTS INCLUDING INDEXES)
    `);

    await client.query(`
      INSERT INTO audit.${quoteIdent(partitionName)}
      SELECT *
      FROM audit.sync_runs_default
      WHERE created_at >= '${month}-01'
        AND created_at < '${nextMonth(month)}-01'
      ON CONFLICT DO NOTHING
    `);

    await client.query(`
      DELETE FROM audit.sync_runs_default
      WHERE created_at >= '${month}-01'
        AND created_at < '${nextMonth(month)}-01'
    `);

    await client.query(`
      ALTER TABLE audit.sync_runs
      ATTACH PARTITION audit.${quoteIdent(partitionName)}
      FOR VALUES FROM ('${month}-01') TO ('${nextMonth(month)}-01')
    `);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function dropOldSyncRunsPartitions(pool: DbPool, cutoff: Date) {
  const result = await pool.query<{ relname: string }>(
    `
      SELECT c.relname
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'audit'
        AND c.relkind = 'r'
        AND c.relname ~ '^sync_runs_[0-9]{4}m[0-9]{2}$'
    `
  );

  const dropped: string[] = [];
  for (const row of result.rows) {
    const month = partitionMonth(row.relname);
    if (!month) {
      continue;
    }
    const partitionEnd = new Date(`${nextMonth(month)}-01T00:00:00.000Z`);
    if (partitionEnd <= cutoff) {
      await pool.query(`DROP TABLE IF EXISTS audit.${quoteIdent(row.relname)}`);
      dropped.push(row.relname);
    }
  }
  return dropped;
}

export function monthString(date: Date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function nextMonth(month: string) {
  assertMonth(month);
  const [yearRaw, monthRaw] = month.split("-");
  const date = new Date(Date.UTC(Number(yearRaw), Number(monthRaw) - 1, 1));
  date.setUTCMonth(date.getUTCMonth() + 1);
  return monthString(date);
}

function partitionMonth(relname: string) {
  const match = SYNC_RUNS_PARTITION_PATTERN.exec(relname);
  if (!match) {
    return null;
  }
  const [, year, month] = match;
  return `${year}-${month}`;
}

function daysAgo(now: Date, days: number) {
  return new Date(now.getTime() - days * 24 * 60 * 60_000);
}

async function isAttachedSyncRunsPartition(client: Pick<DbClient, "query">, partitionName: string) {
  const result = await client.query<{ exists: boolean }>(
    `
      SELECT EXISTS (
        SELECT 1
        FROM pg_inherits i
        JOIN pg_class child ON child.oid = i.inhrelid
        JOIN pg_class parent ON parent.oid = i.inhparent
        JOIN pg_namespace n ON n.oid = child.relnamespace
        WHERE n.nspname = 'audit'
          AND child.relname = $1
          AND parent.relname = 'sync_runs'
      ) AS exists
    `,
    [partitionName]
  );
  return result.rows[0]?.exists === true;
}

function assertMonth(month: string) {
  if (!/^\d{4}-\d{2}$/.test(month)) {
    throw new Error(`Invalid month: ${month}`);
  }
}

function quoteIdent(value: string) {
  return `"${value.replaceAll('"', '""')}"`;
}
