import { describe, expect, it } from "vitest";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AppConfig } from "../src/config.js";
import type { DbPool } from "../src/db.js";
import { handleAdminAiSql, handleAdminDashboard } from "../src/http/dashboard.js";
import { fakeSyncTargets } from "./helpers/sync-targets.js";

type QueryCall = { sql: string; params?: unknown[] };

const baseConfig = {
  adminToken: "admin-secret",
  cloverMerchantId: "merchant1",
  storeTimezone: "America/Chicago",
  aiQueryRowLimit: 500,
  sqlStatementTimeoutMs: 30_000,
  backofficeBaseUrl: "https://app.example.test",
} as AppConfig;

describe("POST /admin/api/ai-sql", () => {
  it("rejects without a valid bearer token", async () => {
    const pool = new MockPool();
    const { req, res, body } = httpPair({ sql: "select 1 from mart.sales_daily_mv limit 1" });

    await handleAdminAiSql(req, res, pool as unknown as DbPool, baseConfig);

    expect(res.statusCode).toBe(401);
    expect(JSON.parse(body.value)).toEqual({ error: "unauthorized" });
    expect(pool.calls).toHaveLength(0);
  });

  it("rejects sql shorter than 20 chars", async () => {
    const pool = new MockPool();
    const { req, res, body } = httpPair(
      { sql: "select 1" },
      { authorization: "Bearer admin-secret" },
    );

    await handleAdminAiSql(req, res, pool as unknown as DbPool, baseConfig);

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(body.value)).toEqual({ error: "invalid_sql_length" });
    expect(pool.calls).toHaveLength(0);
  });

  it("rejects write SQL via the safe-query gate (400 with rejection reason)", async () => {
    const pool = new TransactionMockPool([{ rows: [], rowCount: 0 }]);
    const { req, res, body } = httpPair(
      { sql: "DELETE FROM mart.fact_orders WHERE merchant_id = 'x'", question: "test" },
      { authorization: "Bearer admin-secret" },
    );

    await handleAdminAiSql(req, res, pool as unknown as DbPool, baseConfig);

    expect(res.statusCode).toBe(400);
    const payload = JSON.parse(body.value) as { error: string; message: string };
    expect(payload.error).toBe("ai_sql_rejected");
    expect(payload.message.toLowerCase()).toMatch(/forbidden|write|select/);
  });

  it("rejects raw schema reads via the safe-query gate", async () => {
    const pool = new TransactionMockPool();
    const { req, res, body } = httpPair(
      { sql: "SELECT * FROM raw.clover_orders LIMIT 1" },
      { authorization: "Bearer admin-secret" },
    );

    await handleAdminAiSql(req, res, pool as unknown as DbPool, baseConfig);

    expect(res.statusCode).toBe(400);
    const payload = JSON.parse(body.value) as { error: string; message: string };
    expect(payload.error).toBe("ai_sql_rejected");
    expect(payload.message.toLowerCase()).toMatch(/mart|meta|schema/);
  });

  it("runs allowed read-only SELECT through safe-query and returns rows + row_count", async () => {
    const pool = new TransactionMockPool([
      { rows: [{ business_date: "2026-05-19", order_count: 12 }], rowCount: 1 },
    ]);
    const { req, res, body } = httpPair(
      {
        sql: "SELECT business_date, order_count FROM mart.sales_daily_mv LIMIT 10",
        question: "How many orders today?",
        user_id: "user-123",
      },
      { authorization: "Bearer admin-secret" },
    );

    await handleAdminAiSql(req, res, pool as unknown as DbPool, baseConfig);

    expect(res.statusCode).toBe(200);
    const payload = JSON.parse(body.value) as {
      rows: unknown[];
      row_count: number;
      row_limit: number;
    };
    expect(payload.row_count).toBe(1);
    expect(payload.row_limit).toBe(500);
    expect(payload.rows).toEqual([{ business_date: "2026-05-19", order_count: 12 }]);
    expect(pool.clientCalls.some((call) => call.sql.includes("SET TRANSACTION READ ONLY"))).toBe(
      true,
    );
    expect(pool.clientCalls.some((call) => call.sql.includes("ai_query_result"))).toBe(true);
    expect(pool.calls.some((call) => call.sql.includes("audit.ai_query_log"))).toBe(true);
  });

  it("returns 415 when Content-Type is not JSON", async () => {
    const pool = new MockPool();
    const req = Readable.from(["nonsense"]) as IncomingMessage;
    req.headers = { authorization: "Bearer admin-secret", "content-type": "text/plain" };
    const { res, body } = responsePair();

    await handleAdminAiSql(req, res, pool as unknown as DbPool, baseConfig);

    expect(res.statusCode).toBe(415);
    expect(JSON.parse(body.value)).toEqual({ error: "unsupported_media_type" });
    expect(pool.calls).toHaveLength(0);
  });

  it("is reachable through handleAdminDashboard POST routing", async () => {
    const pool = new MockPool();
    const { req, res, body } = httpPair(
      { sql: "select 1" },
      { authorization: "Bearer wrong-token" },
    );

    await handleAdminDashboard(
      req,
      res,
      pool as unknown as DbPool,
      baseConfig,
      new URL("http://localhost/admin/api/ai-sql"),
      fakeSyncTargets(),
    );

    expect(res.statusCode).toBe(401);
    expect(JSON.parse(body.value)).toEqual({ error: "unauthorized" });
  });
});

class MockPool {
  calls: QueryCall[] = [];

  constructor(protected readonly results: Array<{ rows?: unknown[]; rowCount?: number }> = []) {}

  async query(sql: string, params?: unknown[]) {
    this.calls.push({ sql, params });
    return this.results.shift() ?? { rows: [], rowCount: 0 };
  }
}

class TransactionMockPool extends MockPool {
  clientCalls: QueryCall[] = [];

  async connect() {
    const clientCalls = this.clientCalls;
    const results = this.results;
    return {
      async query(sql: string, params?: unknown[]) {
        clientCalls.push({ sql, params });
        if (sql.includes("ai_query_result")) {
          return results.shift() ?? { rows: [], rowCount: 0 };
        }
        return { rows: [], rowCount: 0 };
      },
      release() {},
    };
  }
}

function httpPair(payload: unknown, headers: Record<string, string> = {}) {
  const req = Readable.from([JSON.stringify(payload)]) as IncomingMessage;
  req.headers = {
    "content-type": "application/json",
    ...headers,
  };
  req.method = "POST";

  const { res, body } = responsePair();
  return { req, res, body };
}

function responsePair() {
  const body = { value: "" };
  const res = {
    statusCode: 0,
    headers: {} as Record<string, string>,
    setHeader(key: string, value: string) {
      this.headers[key] = value;
    },
    end(chunk = "") {
      body.value = chunk;
    },
  } as ServerResponse & { headers: Record<string, string> };

  return { res, body };
}
