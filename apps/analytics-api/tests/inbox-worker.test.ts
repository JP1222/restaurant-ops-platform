import { describe, expect, it } from "vitest";
import type { AppConfig } from "../src/config.js";
import type { DbPool } from "../src/db.js";
import { WebhookInboxWorker } from "../src/scheduler/webhook-inbox-worker.js";
import { fakeSyncTargets } from "./helpers/sync-targets.js";

const config = {
  cloverMerchantId: "merchant1",
  jobStaleAfterMinutes: 30,
  webhookInboxBatchSize: 50,
  webhookInboxPollMs: 1000,
  webhookMiniSweepBacklogThreshold: 100,
  webhookOrderDebounceSeconds: 15
} as AppConfig;

describe("webhook inbox worker", () => {
  it("recovers stale processing rows before claiming pending work", async () => {
    const pool = new InboxMockPool([]);
    const worker = new WebhookInboxWorker(pool as unknown as DbPool, config, fakeSyncTargets());

    await worker.tick();

    expect(pool.calls[0]!.sql).toContain("WHERE status = 'processing'");
    expect(pool.calls[0]!.sql).toContain("SET status = 'pending'");
    expect(pool.calls[0]!.sql).toContain("last_recovered_at = now()");
    expect(pool.calls[0]!.sql).not.toContain("Recovered stale processing webhook inbox row");
  });

  it("only claims pending inbox rows whose run_after is due", async () => {
    const pool = new InboxMockPool([]);
    const worker = new WebhookInboxWorker(pool as unknown as DbPool, config, fakeSyncTargets());

    await worker.tick();

    const claim = pool.calls.find((call) => call.sql.includes("RETURNING"));
    expect(claim?.sql).toContain("run_after <= now()");
  });

  it("turns pending inbox rows into sync jobs and marks unsupported rows ignored", async () => {
    const pool = new InboxMockPool([
      inboxRow("1", "O", "order1"),
      inboxRow("2", "P", "payment1"),
      inboxRow("3", "E", "employee1"),
      inboxRow("4", "I", "item1")
    ]);
    const worker = new WebhookInboxWorker(pool as unknown as DbPool, config, fakeSyncTargets());

    await worker.tick();

    expect(pool.enqueuedJobTypes).toEqual([
      "webhook_fetch_order",
      "webhook_fetch_payment",
      "reference_data_refresh"
    ]);
    expect(pool.processed).toBe(3);
    expect(pool.ignored).toBe(1);
    expect(pool.failed).toBe(0);
  });

  it("creates a mini sweep and cancels pending single fetches when backlog is high", async () => {
    const pool = new InboxMockPool([inboxRow("1", "O", "order1")]);
    pool.pendingWebhookFetchCount = 100;
    const worker = new WebhookInboxWorker(pool as unknown as DbPool, config, fakeSyncTargets());

    await worker.tick();

    expect(pool.cancelledPendingFetches).toBe(true);
    expect(pool.enqueuedJobTypes).toEqual(["webhook_fetch_order", "mini_rest_sweep"]);
    expect(pool.processed).toBe(1);
    expect(pool.pendingCountCalls).toBe(1);
  });

  it("checks mini sweep backlog once per merchant per batch", async () => {
    const pool = new InboxMockPool([
      inboxRow("1", "O", "order1"),
      inboxRow("2", "P", "payment1")
    ]);
    pool.pendingWebhookFetchCount = 100;
    const worker = new WebhookInboxWorker(pool as unknown as DbPool, config, fakeSyncTargets());

    await worker.tick();

    expect(pool.pendingCountCalls).toBe(1);
    expect(pool.enqueuedJobTypes).toEqual([
      "webhook_fetch_order",
      "webhook_fetch_payment",
      "mini_rest_sweep"
    ]);
  });

  it("does not run mini sweep checks for unsupported object types", async () => {
    const pool = new InboxMockPool([inboxRow("1", "I", "item1")]);
    pool.pendingWebhookFetchCount = 100;
    const worker = new WebhookInboxWorker(pool as unknown as DbPool, config, fakeSyncTargets());

    await worker.tick();

    expect(pool.pendingCountCalls).toBe(0);
    expect(pool.ignored).toBe(1);
  });

  it("retries a failed inbox row with backoff without blocking later rows", async () => {
    const pool = new InboxMockPool([
      inboxRow("1", "O", "order1"),
      inboxRow("2", "P", "payment1")
    ]);
    pool.throwOnJobType = "webhook_fetch_order";
    const worker = new WebhookInboxWorker(pool as unknown as DbPool, config, fakeSyncTargets());

    await worker.tick();

    expect(pool.retried).toBe(1);
    expect(pool.retryDelays).toEqual(["30 seconds"]);
    expect(pool.failed).toBe(0);
    expect(pool.processed).toBe(1);
    expect(pool.enqueuedJobTypes).toEqual(["webhook_fetch_payment"]);
  });

  it("marks a failed inbox row failed after max attempts", async () => {
    const pool = new InboxMockPool([
      inboxRow("1", "O", "order1", 5, 5)
    ]);
    pool.throwOnJobType = "webhook_fetch_order";
    const worker = new WebhookInboxWorker(pool as unknown as DbPool, config, fakeSyncTargets());

    await worker.tick();

    expect(pool.retried).toBe(0);
    expect(pool.failed).toBe(1);
  });
});

type InboxRow = {
  id: string;
  merchant_id: string;
  object_id: string;
  object_type: string;
  event_type: string;
  event_ts: Date;
  raw_event: Record<string, unknown>;
  dedupe_key: string;
  attempt_count: number;
  max_attempts: number;
};

class InboxMockPool {
  calls: Array<{ sql: string; params?: unknown[] }> = [];
  enqueuedJobTypes: string[] = [];
  processed = 0;
  ignored = 0;
  failed = 0;
  retried = 0;
  recovered = 0;
  cancelledPendingFetches = false;
  pendingWebhookFetchCount = 0;
  pendingCountCalls = 0;
  retryDelays: string[] = [];
  throwOnJobType: string | null = null;

  constructor(private readonly claimRows: InboxRow[]) {}

  async query(sql: string, params?: unknown[]) {
    this.calls.push({ sql, params });

    if (sql.includes("last_recovered_at = now()")) {
      this.recovered += 1;
      return { rows: [], rowCount: 0 };
    }

    if (sql.includes("INSERT INTO audit.sync_jobs")) {
      const jobType = String(params?.[0]);
      if (jobType === this.throwOnJobType) {
        throw new Error("job enqueue failed");
      }
      this.enqueuedJobTypes.push(jobType);
      return {
        rows: [{
          id: `${jobType}-id`,
          job_type: jobType,
          merchant_id: params?.[1],
          status: "pending",
          priority: params?.[2],
          window_start: params?.[3] ?? null,
          window_end: params?.[4] ?? null,
          payload: JSON.parse(String(params?.[5] ?? "{}")),
          dedupe_key: params?.[6] ?? null,
          attempt_count: 0,
          max_attempts: params?.[7] ?? 5
        }],
        rowCount: 1
      };
    }

    if (sql.includes("RETURNING")) {
      return { rows: this.claimRows.splice(0), rowCount: this.claimRows.length };
    }

    if (sql.includes("SELECT count(*) AS count")) {
      this.pendingCountCalls += 1;
      return { rows: [{ count: String(this.pendingWebhookFetchCount) }], rowCount: 1 };
    }

    if (sql.includes("Cancelled after mini sweep")) {
      this.cancelledPendingFetches = true;
      return { rows: [], rowCount: 1 };
    }

    if (sql.includes("SET status = 'processed'")) {
      this.processed += 1;
      return { rows: [], rowCount: 1 };
    }

    if (sql.includes("SET status = 'ignored'")) {
      this.ignored += 1;
      return { rows: [], rowCount: 1 };
    }

    if (sql.includes("SET status = 'failed'")) {
      this.failed += 1;
      return { rows: [], rowCount: 1 };
    }

    if (sql.includes("run_after = now()")) {
      this.retried += 1;
      this.retryDelays.push(String(params?.[1]));
      return { rows: [], rowCount: 1 };
    }

    return { rows: [], rowCount: 0 };
  }
}

function inboxRow(id: string, objectType: string, objectId: string, attemptCount = 1, maxAttempts = 5): InboxRow {
  return {
    id,
    merchant_id: "merchant1",
    object_id: objectId,
    object_type: objectType,
    event_type: "UPDATE",
    event_ts: new Date("2026-04-26T12:00:00.000Z"),
    raw_event: { objectId: `${objectType}:${objectId}` },
    dedupe_key: `merchant1:${objectType}:${objectId}:UPDATE`,
    attempt_count: attemptCount,
    max_attempts: maxAttempts
  };
}
