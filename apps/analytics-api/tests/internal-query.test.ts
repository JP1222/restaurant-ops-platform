import { describe, expect, it } from "vitest";
import type { DbPool } from "../src/db.js";
import { internalQuery } from "../src/analytics/internal-query.js";

type Call = { sql: string; params?: unknown[] };

class RecordingPool {
  calls: Call[] = [];
  constructor(private readonly onQuery?: (sql: string) => unknown) {}
  async query(sql: string, params?: unknown[]) {
    this.calls.push({ sql, params });
    const override = this.onQuery?.(sql);
    if (override !== undefined) {
      return override;
    }
    return { rows: [{ count: 3 }], rowCount: 1 };
  }
  auditCalls() {
    return this.calls.filter((c) => c.sql.includes("INSERT INTO audit.ai_query_log"));
  }
}

describe("internalQuery", () => {
  it("runs the parameterized query and returns its result", async () => {
    const pool = new RecordingPool();
    const result = await internalQuery<{ count: number }>(pool as unknown as DbPool, {
      sql: "SELECT count(*)::integer AS count FROM mart.fact_orders WHERE merchant_id = $1",
      params: ["merchant1"],
      actor: "dq-check"
    });
    expect(result.rows[0]?.count).toBe(3);
  });

  it("writes an audit.ai_query_log row with actor='dq-check'", async () => {
    const pool = new RecordingPool();
    await internalQuery(pool as unknown as DbPool, {
      sql: "SELECT 1 AS count",
      params: [],
      actor: "dq-check",
      label: "dq:unknown_tender_type"
    });

    const audit = pool.auditCalls();
    expect(audit).toHaveLength(1);
    const params = audit[0]!.params!;
    expect(params[0]).toBe("dq-check"); // actor
    expect(params[1]).toBe("dq:unknown_tender_type"); // question/label
    expect(params[2]).toBe("SELECT 1 AS count"); // sql_text
    expect(params[5]).toBe(false); // rejected
  });

  it("records the raw/audit SQL text so DQ trends are visible in ai_query_log", async () => {
    const pool = new RecordingPool();
    const dqSql = `
      UPDATE audit.data_quality_checks SET status = 'failed' WHERE merchant_id = $1
    `;
    await internalQuery(pool as unknown as DbPool, {
      sql: dqSql,
      params: ["merchant1"],
      actor: "dq-check",
      label: "dq-fail-update:invalid_quantity"
    });
    expect(pool.auditCalls()[0]!.params![2]).toBe(dqSql);
  });

  it("logs a rejected row when the query throws, then rethrows", async () => {
    const pool = new RecordingPool((sql) => {
      if (sql.includes("BROKEN")) {
        throw new Error("relation does not exist");
      }
      return undefined;
    });

    await expect(
      internalQuery(pool as unknown as DbPool, {
        sql: "SELECT * FROM BROKEN",
        actor: "dq-check"
      })
    ).rejects.toThrow("relation does not exist");

    const audit = pool.auditCalls();
    expect(audit).toHaveLength(1);
    expect(audit[0]!.params![5]).toBe(true); // rejected
    expect(audit[0]!.params![6]).toBe("relation does not exist"); // rejection_reason
  });

  it("never lets an audit-log failure mask the real query result", async () => {
    const pool = new RecordingPool((sql) => {
      if (sql.includes("INSERT INTO audit.ai_query_log")) {
        throw new Error("audit table unavailable");
      }
      return undefined;
    });

    const result = await internalQuery<{ count: number }>(pool as unknown as DbPool, {
      sql: "SELECT count(*)::integer AS count FROM mart.fact_orders",
      actor: "dq-check"
    });
    expect(result.rows[0]?.count).toBe(3);
  });
});
