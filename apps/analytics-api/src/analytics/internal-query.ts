import type { QueryResult, QueryResultRow } from "pg";
import type { DbPool } from "../db.js";

// Internal SQL wrapper for trusted, code-authored queries that still want an
// audit trail (audit-2026-05-27 #178).
//
// `safe-query.ts` is the sandbox for UNTRUSTED, free-form AI SQL: it is
// read-only, forbids the raw/audit schemas, and inlines the statement. The
// data-quality checks in `quality/checks.ts` are different — they are
// hand-written, parameterized, and legitimately read raw.* / mart.* and write
// to audit.data_quality_checks. They were hitting `pool.query` directly, which
// left no audit-log entry (root AGENTS.md: even trusted SQL should be
// traceable). This wrapper closes that gap: it runs the parameterized query and
// records it in `audit.ai_query_log` with the supplied actor (e.g. "dq-check"),
// so `rejected_count` / DQ-check SQL trends are queryable from the same place
// as AI SQL.
//
// It deliberately does NOT re-validate the SQL the way safe-query does: callers
// are in-repo and parameterized. The value it adds is the audit row, not a
// sandbox.

export type InternalQueryOptions = {
  /** SQL statement. May read raw/audit/mart and may write to audit.*. */
  sql: string;
  /** Positional parameters ($1, $2, ...). */
  params?: unknown[];
  /** Who ran it — recorded as `actor` in audit.ai_query_log (e.g. "dq-check"). */
  actor: string;
  /** Optional human label recorded as `question` (e.g. the check name). */
  label?: string;
};

export async function internalQuery<T extends QueryResultRow = QueryResultRow>(
  pool: DbPool,
  options: InternalQueryOptions
): Promise<QueryResult<T>> {
  const startedAt = Date.now();
  let result: QueryResult<T> | undefined;
  let failure: unknown;
  try {
    result = await pool.query<T>(options.sql, options.params);
    return result;
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    // Record the statement regardless of success so failed DQ checks are
    // visible too. Logged via pool.query directly (NOT internalQuery) to avoid
    // unbounded recursion. Audit-log failures must never mask the real result,
    // so swallow them.
    await logInternalQuery(pool, options, {
      rowCount: result?.rowCount ?? null,
      elapsedMs: Date.now() - startedAt,
      failure
    }).catch(() => undefined);
  }
}

async function logInternalQuery(
  pool: DbPool,
  options: InternalQueryOptions,
  outcome: { rowCount: number | null; elapsedMs: number; failure: unknown }
): Promise<void> {
  const rejected = outcome.failure !== undefined;
  const rejectionReason = rejected
    ? outcome.failure instanceof Error
      ? outcome.failure.message
      : String(outcome.failure)
    : null;
  await pool.query(
    `
      INSERT INTO audit.ai_query_log (
        actor, question, sql_text, row_count, elapsed_ms, rejected, rejection_reason
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7)
    `,
    [
      options.actor,
      options.label ?? null,
      options.sql,
      outcome.rowCount,
      outcome.elapsedMs,
      rejected,
      rejectionReason
    ]
  );
}
