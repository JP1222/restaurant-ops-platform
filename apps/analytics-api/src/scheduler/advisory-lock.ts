import { createHash } from "node:crypto";
import type { DbClient, DbPool } from "../db.js";
import { withTransaction } from "../db.js";

export const AdvisoryNamespace = {
  Migration: 1,
  MerchantWindow: 2,
  MerchantGlobal: 3,
  MartRefresh: 4
} as const;

export function advisoryKey(input: string): number {
  const buffer = createHash("sha256").update(input).digest();
  return buffer.readInt32BE(0);
}

export async function tryAdvisoryXactLock(client: DbClient, namespace: number, key: number) {
  const result = await client.query<{ locked: boolean }>(
    "SELECT pg_try_advisory_xact_lock($1, $2) AS locked",
    [namespace, key]
  );
  return result.rows[0]?.locked === true;
}

export async function withAdvisoryTransaction<T>(
  pool: DbPool,
  namespace: number,
  key: number,
  task: (client: DbClient) => Promise<T>
) {
  return withTransaction(pool, async (client) => {
    const locked = await tryAdvisoryXactLock(client, namespace, key);
    if (!locked) {
      return null;
    }
    return task(client);
  });
}

export async function withSessionAdvisoryLock<T>(
  pool: DbPool,
  namespace: number,
  key: number,
  task: () => Promise<T>
) {
  const client = await pool.connect();
  try {
    const result = await client.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock($1, $2) AS locked",
      [namespace, key]
    );
    if (result.rows[0]?.locked !== true) {
      return null;
    }
    return await task();
  } finally {
    await client.query("SELECT pg_advisory_unlock($1, $2)", [namespace, key]).catch(() => undefined);
    client.release();
  }
}
