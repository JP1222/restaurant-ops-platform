import { describe, expect, it } from "vitest";
import type { ServerResponse } from "node:http";
import type { DbPool } from "../src/db.js";
import { handleReady } from "../src/http/health.js";
import { Heartbeat } from "../src/scheduler/heartbeat.js";

describe("service heartbeats", () => {
  it("writes component heartbeats with a stable component name", async () => {
    const pool = new QueuePool();
    const heartbeat = new Heartbeat(pool as unknown as DbPool, "scheduler");

    await heartbeat.write();

    expect(pool.calls[0]!.sql).toContain("INSERT INTO audit.service_heartbeats");
    expect(pool.calls[0]!.params?.[0]).toBe("scheduler");
    expect(String(pool.calls[0]!.params?.[1])).toContain("scheduler-");
  });

  it("marks readiness unhealthy when any required heartbeat is missing", async () => {
    const pool = new QueuePool([
      { rows: [{ "?column?": 1 }] },
      { rows: [{ fresh: false, missing: ["scheduler"] }] },
      { rows: [{ fresh: true }] }
    ]);
    const { res, body } = response();

    await handleReady(res, pool as unknown as DbPool);

    expect(res.statusCode).toBe(503);
    expect(pool.calls[1]!.sql).toContain("realtime-runner");
    expect(pool.calls[1]!.sql).toContain("export-runner");
    expect(pool.calls[1]!.sql).toContain("hydration-runner");
    expect(pool.calls[1]!.sql).toContain("repair-runner");
    expect(JSON.parse(body.value)).toMatchObject({
      ok: false,
      heartbeatFresh: false,
      hourlyFresh: true,
      missingHeartbeats: ["scheduler"]
    });
  });
});

class QueuePool {
  calls: Array<{ sql: string; params?: unknown[] }> = [];
  constructor(private readonly results: Array<{ rows?: unknown[]; rowCount?: number }> = []) {}

  async query(sql: string, params?: unknown[]) {
    this.calls.push({ sql, params });
    return this.results.shift() ?? { rows: [], rowCount: 0 };
  }
}

function response() {
  const body = { value: "" };
  const res = {
    statusCode: 0,
    setHeader() {},
    end(chunk: string) {
      body.value = chunk;
    }
  } as unknown as ServerResponse;
  return { res, body };
}
