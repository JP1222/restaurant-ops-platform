import { describe, expect, it } from "vitest";
import type { AppConfig } from "../src/config.js";
import type { DbPool } from "../src/db.js";
import { recordReconciliationPlaceholder, runExportWindowJob } from "../src/jobs/export-reconcile.js";
import type { SyncJob } from "../src/scheduler/job-repository.js";

describe("export reconciliation placeholder", () => {
  it("records imported instead of passed before metric comparison exists", async () => {
    const pool = new QueryPool();

    await recordReconciliationPlaceholder(pool as unknown as DbPool, "merchant1", new Date("2026-04-26T00:00:00.000Z"));

    expect(pool.calls[0]!.sql).toContain("'imported'");
    expect(pool.calls[0]!.sql).not.toContain("'passed'");
    expect(pool.calls[0]!.params).toEqual(["merchant1", "2026-04-26"]);
  });

  it("queues order detail hydration after importing export order rows", async () => {
    const pool = new ExportPool();
    const clover = new ExportClover();

    await runExportWindowJob(
      pool as unknown as DbPool,
      { rawExportDir: "/tmp/rop-test-exports", storeTimezone: "America/Chicago" } as AppConfig,
      clover as never,
      exportJob()
    );

    const jobInsert = pool.calls.find((call) => call.sql.includes("INSERT INTO audit.sync_jobs"));
    expect(jobInsert?.params?.[0]).toBe("order_detail_hydration");
    expect(JSON.parse(String(jobInsert?.params?.[5])).orderIds).toEqual(["order1"]);
    expect(pool.calls.some((call) => call.sql.includes("source_priority <"))).toBe(true);
    expect(pool.calls.some((call) =>
      call.sql.includes("INSERT INTO audit.sync_jobs") && call.params?.[0] === "reconciliation_check"
    )).toBe(true);
  });

  it("treats a completed export without download URLs as empty", async () => {
    const pool = new ExportPool();
    const clover = new EmptyExportClover();

    const result = await runExportWindowJob(
      pool as unknown as DbPool,
      { rawExportDir: "/tmp/rop-test-exports", storeTimezone: "America/Chicago" } as AppConfig,
      clover as never,
      exportJob()
    );

    expect(result.rowsRead).toBe(0);
    expect(result.rowsWritten).toBe(0);
    expect(clover.downloadCount).toBe(0);

    const downloadMarks = pool.calls.filter((call) => call.sql.includes("UPDATE raw.clover_exports")
      && call.sql.includes("row_count"));
    expect(downloadMarks).toHaveLength(2);
    expect(downloadMarks.every((call) => call.params?.[1] === "[]")).toBe(true);
    expect(downloadMarks.every((call) => call.params?.[3] === 0 && call.params?.[4] === 0)).toBe(true);
  });
});

class QueryPool {
  calls: Array<{ sql: string; params?: unknown[] }> = [];

  async query(sql: string, params?: unknown[]) {
    this.calls.push({ sql, params });
    return { rows: [], rowCount: 0 };
  }
}

class ExportPool {
  calls: Array<{ sql: string; params?: unknown[] }> = [];
  exportIndex = 0;

  async connect() {
    return {
      query: (sql: string, params?: unknown[]) => this.query(sql, params),
      release: () => undefined
    };
  }

  async query(sql: string, params?: unknown[]) {
    this.calls.push({ sql, params });
    if (sql.includes("INSERT INTO raw.clover_exports")) {
      this.exportIndex += 1;
      return { rows: [{ id: `00000000-0000-4000-8000-00000000000${this.exportIndex}`, export_id: `export${this.exportIndex}` }], rowCount: 1 };
    }
    if (sql.includes("SELECT order_id")) {
      return { rows: [{ order_id: "order1" }], rowCount: 1 };
    }
    if (sql.includes("SELECT EXISTS")) {
      return { rows: [{ exists: false }], rowCount: 1 };
    }
    if (sql.includes("INSERT INTO audit.sync_jobs")) {
      return {
        rows: [{
          id: "job1",
          job_type: params?.[0],
          merchant_id: params?.[1],
          priority: params?.[2],
          window_start: params?.[3],
          window_end: params?.[4],
          payload: JSON.parse(String(params?.[5] ?? "{}")),
          dedupe_key: params?.[6],
          max_attempts: params?.[7],
          attempt_count: 0,
          status: "pending"
        }],
        rowCount: 1
      };
    }
    if (sql.includes("SELECT import_summary")) {
      return { rows: [{ import_summary: {} }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }
}

class ExportClover {
  createCount = 0;

  async createExport() {
    this.createCount += 1;
    return {
      id: `export${this.createCount}`,
      status: "CREATED"
    };
  }

  async getExport(exportId: string) {
    return {
      id: exportId,
      status: "DONE",
      exportUrls: {
        elements: [{ url: `https://example.test/${exportId}.json?token=secret` }]
      }
    };
  }

  async downloadExportUrl(url: string) {
    const rows = url.includes("export1")
      ? [{ id: "order1", createdTime: 1_714_003_200_000 }]
      : [{ id: "payment1", createdTime: 1_714_003_200_000, amount: 1000, order: { id: "order1" } }];
    return Buffer.from(JSON.stringify(rows));
  }
}

class EmptyExportClover extends ExportClover {
  downloadCount = 0;

  override async getExport(exportId: string) {
    return {
      id: exportId,
      status: "DONE",
      exportUrls: {
        elements: []
      }
    };
  }

  override async downloadExportUrl() {
    this.downloadCount += 1;
    return Buffer.from("[]");
  }
}

function exportJob(): SyncJob {
  return {
    id: "export-job",
    jobType: "export_reconcile",
    merchantId: "merchant1",
    status: "running",
    priority: 40,
    windowStart: new Date("2026-04-26T00:00:00.000Z"),
    windowEnd: new Date("2026-04-27T00:00:00.000Z"),
    payload: {
      start: "2026-04-26T00:00:00.000Z",
      end: "2026-04-27T00:00:00.000Z"
    },
    dedupeKey: null,
    attemptCount: 0,
    maxAttempts: 5
  };
}
