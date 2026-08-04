import { describe, expect, it } from "vitest";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AppConfig } from "../src/config.js";
import type { DbPool } from "../src/db.js";
import { handleCloverWebhook, parseWebhookPayload } from "../src/http/webhooks.js";

type QueryCall = { sql: string; params?: unknown[] };

class MockPool {
  calls: QueryCall[] = [];
  constructor(private readonly results: Array<{ rows?: unknown[]; rowCount?: number }> = []) {}

  async query(sql: string, params?: unknown[]) {
    this.calls.push({ sql, params });
    return this.results.shift() ?? { rows: [], rowCount: 0 };
  }
}

const config = {
  cloverMerchantId: "merchant1",
  cloverWebhookAuthCode: "secret-token",
  webhookVerificationMaxPerHour: 20
} as AppConfig;

describe("Clover webhook parsing", () => {
  it("splits batched merchant updates and creates stable dedupe keys", () => {
    const updates = parseWebhookPayload({
      appId: "app",
      merchants: {
        merchant1: [
          { objectId: "O:order1", type: "CREATE", ts: Date.UTC(2026, 3, 26, 12) },
          { objectId: "P:payment1", type: "UPDATE", ts: Date.UTC(2026, 3, 26, 12, 1) }
        ],
        merchant2: [
          { objectId: "E:employee1", type: "UPDATE", ts: Date.UTC(2026, 3, 26, 12, 2) }
        ]
      }
    });

    expect(updates.map((update) => [update.merchantId, update.objectType, update.objectId])).toEqual([
      ["merchant1", "O", "order1"],
      ["merchant1", "P", "payment1"],
      ["merchant2", "E", "employee1"]
    ]);
    expect(new Set(updates.map((update) => update.dedupeKey)).size).toBe(3);
  });

  it("stores normal webhook updates in inbox without enqueueing jobs", async () => {
    const pool = new MockPool();
    const { req, res, body } = httpPair({
      appId: "app",
      merchants: {
        merchant1: [{ objectId: "O:order1", type: "CREATE", ts: Date.UTC(2026, 3, 26, 12) }],
        otherMerchant: [{ objectId: "P:payment1", type: "UPDATE", ts: Date.UTC(2026, 3, 26, 12) }]
      }
    }, { "x-clover-auth": "secret-token" });

    await handleCloverWebhook(req, res, pool as unknown as DbPool, config);

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(body.value)).toEqual({ ok: true, received: 2 });
    expect(pool.calls).toHaveLength(1);
    expect(pool.calls[0]!.sql).toContain("INSERT INTO audit.webhook_inbox");
    expect(pool.calls[0]!.sql).not.toContain("audit.sync_jobs");
    expect(pool.calls[0]!.params).toContain("pending");
    expect(pool.calls[0]!.params).toContain("ignored");
  });

  it("rejects missing or different-length webhook auth without throwing", async () => {
    const pool = new MockPool();
    const { req, res, body } = httpPair({
      merchants: {
        merchant1: [{ objectId: "O:order1", type: "CREATE", ts: Date.now() }]
      }
    }, { "x-clover-auth": "bad" });

    await handleCloverWebhook(req, res, pool as unknown as DbPool, config);

    expect(res.statusCode).toBe(401);
    expect(JSON.parse(body.value).error).toBe("invalid Clover webhook auth");
    expect(pool.calls).toHaveLength(0);
  });

  it("stores verification codes once", async () => {
    const pool = new MockPool([
      { rows: [{ exists: false }] },
      { rows: [{ count: 0 }] },
      { rows: [], rowCount: 1 },
      { rows: [{ exists: true }] }
    ]);

    const first = httpPair({ verificationCode: "verify-123" });
    await handleCloverWebhook(first.req, first.res, pool as unknown as DbPool, config);
    const second = httpPair({ verificationCode: "verify-123" });
    await handleCloverWebhook(second.req, second.res, pool as unknown as DbPool, config);

    expect(first.res.statusCode).toBe(200);
    expect(second.res.statusCode).toBe(200);
    expect(pool.calls.filter((call) => call.sql.includes("INSERT INTO audit.webhook_verifications"))).toHaveLength(1);
    expect(pool.calls.some((call) => call.sql.includes("ON CONFLICT (code) DO NOTHING"))).toBe(true);
  });

  it("rejects invalid or excessive verification code traffic", async () => {
    const tooLong = httpPair({ verificationCode: "x".repeat(256) });
    const noQueryPool = new MockPool();
    await handleCloverWebhook(tooLong.req, tooLong.res, noQueryPool as unknown as DbPool, config);
    expect(tooLong.res.statusCode).toBe(400);
    expect(noQueryPool.calls).toHaveLength(0);

    const cappedPool = new MockPool([
      { rows: [{ exists: false }] },
      { rows: [{ count: 20 }] }
    ]);
    const capped = httpPair({ verificationCode: "verify-456" });
    await handleCloverWebhook(capped.req, capped.res, cappedPool as unknown as DbPool, config);
    expect(capped.res.statusCode).toBe(429);
  });
});

function httpPair(payload: unknown, headers: Record<string, string> = {}) {
  const req = Readable.from([JSON.stringify(payload)]) as IncomingMessage;
  req.headers = {
    "content-type": "application/json",
    ...headers
  };

  const body = { value: "" };
  const res = {
    statusCode: 0,
    headers: {} as Record<string, string>,
    setHeader(key: string, value: string) {
      this.headers[key] = value;
    },
    end(chunk: string) {
      body.value = chunk;
    }
  } as ServerResponse & { headers: Record<string, string> };

  return { req, res, body };
}
