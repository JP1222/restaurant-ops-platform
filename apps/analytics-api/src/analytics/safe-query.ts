import type { DbPool } from "../db.js";
import { withTransaction } from "../db.js";

type SafeQueryOptions = {
  sql: string;
  rowLimit: number;
  statementTimeoutMs: number;
  actor?: string;
  question?: string;
};

const FORBIDDEN_SQL = /\b(insert|update|delete|drop|alter|create|truncate|grant|revoke|copy|call|execute|merge|refresh|vacuum|analyze)\b/i;
const FORBIDDEN_SCHEMA = /\b(raw|audit|staging)\s*\./i;

export async function runSafeAiQuery(pool: DbPool, options: SafeQueryOptions) {
  const validation = validateAiSql(options.sql);
  if (!validation.ok) {
    await logAiQuery(pool, options, true, validation.reason);
    throw new Error(validation.reason);
  }

  const startedAt = Date.now();
  const result = await withTransaction(pool, async (client) => {
    await client.query("SET TRANSACTION READ ONLY");
    await client.query("SET LOCAL search_path = mart, meta, public");
    await client.query(`SET LOCAL statement_timeout = ${Math.trunc(options.statementTimeoutMs)}`);
    return client.query(
      `SELECT * FROM (${options.sql}) AS ai_query_result LIMIT ${Math.trunc(options.rowLimit)}`
    );
  });

  await logAiQuery(pool, options, false, null, result.rowCount ?? 0, Date.now() - startedAt);
  return result.rows;
}

export function validateAiSql(sql: string): { ok: true } | { ok: false; reason: string } {
  const trimmed = sql.trim();
  if (trimmed.includes(";")) {
    return { ok: false, reason: "AI SQL must contain exactly one statement and no semicolon." };
  }
  if (!/^(select|with)\b/i.test(trimmed)) {
    return { ok: false, reason: "AI SQL must be a SELECT or WITH query." };
  }
  if (FORBIDDEN_SQL.test(trimmed)) {
    return { ok: false, reason: "AI SQL contains a forbidden write or DDL keyword." };
  }
  if (FORBIDDEN_SCHEMA.test(trimmed)) {
    return { ok: false, reason: "AI SQL may only query mart/meta schemas." };
  }
  return { ok: true };
}

async function logAiQuery(
  pool: DbPool,
  options: SafeQueryOptions,
  rejected: boolean,
  rejectionReason: string | null,
  rowCount?: number,
  elapsedMs?: number
) {
  await pool.query(
    `
      INSERT INTO audit.ai_query_log (
        actor, question, sql_text, row_count, elapsed_ms, rejected, rejection_reason
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7)
    `,
    [
      options.actor ?? null,
      options.question ?? null,
      options.sql,
      rowCount ?? null,
      elapsedMs ?? null,
      rejected,
      rejectionReason
    ]
  );
}

