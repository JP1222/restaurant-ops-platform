import { describe, expect, it } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AppConfig } from "../src/config.js";
import type { DbPool } from "../src/db.js";
import {
  handleAdminApi,
  handleAdminDashboard,
  historicalBackfillSummary,
} from "../src/http/dashboard.js";
import { fakeSyncTargets } from "./helpers/sync-targets.js";

type QueryCall = { sql: string; params?: unknown[] };

const config = {
  adminToken: "admin-secret",
  cloverMerchantId: "merchant1",
  storeTimezone: "America/Chicago",
  backfillStartDate: new Date("2018-04-01T00:00:00.000Z"),
  backfillWindowDays: 30,
  exportWindowStartUtc: "10:00",
  exportWindowEndUtc: "15:00",
  exportHistoricalBackfillWindowShare: 0.4,
  backofficeBaseUrl: "https://app.example.test",
} as AppConfig;

// Inject the fake sync-targets reader (the new 6th arg) so each test call site
// stays at 5 args. Single-store fallback (merchant1 / America/Chicago) keeps the
// existing param assertions valid.
const syncTargets = fakeSyncTargets();

function callAdminApi(
  req: IncomingMessage,
  res: ServerResponse,
  pool: DbPool,
  cfg: AppConfig,
  url: URL,
) {
  return handleAdminApi(req, res, pool, cfg, url, syncTargets);
}

function callAdminDashboard(
  req: IncomingMessage,
  res: ServerResponse,
  pool: DbPool,
  cfg: AppConfig,
  url: URL,
) {
  return handleAdminDashboard(req, res, pool, cfg, url, syncTargets);
}

describe("admin dashboard", () => {
  it("redirects the legacy dashboard shell to backoffice ops", async () => {
    const { req, res, body } = httpPair();

    await callAdminDashboard(
      req,
      res,
      new MockPool() as unknown as DbPool,
      config,
      new URL("http://localhost/admin"),
    );

    expect(res.statusCode).toBe(301);
    expect(res.headers.location).toBe("https://app.example.test/ops");
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(body.value).toBe("");
  });

  it("no longer serves legacy dashboard asset handlers", async () => {
    for (const path of ["/admin/assets/app.css", "/admin/assets/app.js"]) {
      const { req, res, body } = httpPair();

      await callAdminDashboard(
        req,
        res,
        new MockPool() as unknown as DbPool,
        config,
        new URL(`http://localhost${path}`),
      );

      expect(res.statusCode).toBe(404);
      expect(JSON.parse(body.value)).toEqual({ error: "not found" });
    }
  });

  it("rejects dashboard API requests without a valid bearer token", async () => {
    const pool = new MockPool();
    const { req, res, body } = httpPair();

    await callAdminApi(
      req,
      res,
      pool as unknown as DbPool,
      config,
      new URL("http://localhost/admin/api/overview"),
    );

    expect(res.statusCode).toBe(401);
    expect(JSON.parse(body.value)).toEqual({ error: "unauthorized" });
    expect(pool.calls).toHaveLength(0);
  });

  it("returns overview data for authorized requests", async () => {
    const pool = new MockPool([
      { rows: [{ merchant_id: "merchant1", failed_job_count: 0, dirty_window_backlog: 0 }] },
      { rows: [{ component: "scheduler", age_seconds: 3 }] },
      { rows: [{ job_type: "historical_export_backfill", status: "completed", count: 2 }] },
      {
        rows: [
          { name: "mart_orders", row_count: 10, min_time: "2026-04-01", max_time: "2026-04-26" },
        ],
      },
      { rows: [{ status: "refreshed", count: 4 }] },
      { rows: [] },
      { rows: [] },
      {
        rows: [
          {
            window_start: new Date("2018-04-01T00:00:00.000Z"),
            window_end: new Date("2018-05-01T00:00:00.000Z"),
            status: "completed",
            retry_after: null,
            blocked_at: null,
            failure_count: 0,
            last_error: null,
            completed_at: new Date("2026-04-26T13:00:00.000Z"),
            updated_at: new Date("2026-04-26T13:00:00.000Z"),
          },
          {
            window_start: new Date("2018-05-01T00:00:00.000Z"),
            window_end: new Date("2018-05-31T00:00:00.000Z"),
            status: "failed",
            retry_after: new Date("2026-04-26T14:00:00.000Z"),
            blocked_at: null,
            failure_count: 1,
            last_error: "Clover request failed with 503.",
            completed_at: null,
            updated_at: new Date("2026-04-26T13:05:00.000Z"),
          },
        ],
      },
    ]);
    const { req, res, body } = httpPair({ authorization: "Bearer admin-secret" });

    await callAdminApi(
      req,
      res,
      pool as unknown as DbPool,
      config,
      new URL("http://localhost/admin/api/overview"),
    );

    const payload = JSON.parse(body.value);
    expect(res.statusCode).toBe(200);
    expect(payload.health.failed_job_count).toBe(0);
    expect(payload.heartbeats).toHaveLength(1);
    expect(payload.jobCounts[0].job_type).toBe("historical_export_backfill");
    expect(payload.historicalBackfill.expectedWindows).toBeGreaterThan(90);
    expect(payload.historicalBackfill.completedWindows).toBe(1);
    expect(payload.historicalBackfill.failedWindows).toBe(1);
    expect(payload.historicalBackfill.currentWindowStart).toBe("2018-05-01T00:00:00.000Z");
    // Oldest scheduler touch across both windows (13:00 < 13:05) — the staleness
    // anchor the backfill-metrics updater uses.
    expect(payload.historicalBackfill.oldestWindowUpdatedAt).toBe("2026-04-26T13:00:00.000Z");
    expect(payload.historicalBackfill.lastError).toBe("Clover request failed with 503.");
    expect(payload.reconBreaks).toEqual([]);
    const sql = pool.calls.map((call) => call.sql).join("\n");
    expect(sql).toContain("audit.sync_health");
    expect(sql).toContain("audit.reconciliation_results");
  });

  it("does not expose a next historical run when all expected windows are complete", async () => {
    const pool = new MockPool([
      {
        rows: [
          {
            window_start: new Date("2026-01-01T00:00:00.000Z"),
            window_end: new Date("2026-01-31T00:00:00.000Z"),
            status: "completed",
            retry_after: null,
            blocked_at: null,
            failure_count: 0,
            last_error: null,
            completed_at: new Date("2026-02-01T13:00:00.000Z"),
            updated_at: new Date("2026-02-01T13:00:00.000Z"),
          },
        ],
      },
    ]);

    const summary = await historicalBackfillSummary(
      pool as unknown as DbPool,
      {
        ...config,
        backfillStartDate: new Date("2026-01-01T00:00:00.000Z"),
        backfillWindowDays: 30,
      } as AppConfig,
      "merchant1",
      new Date("2026-01-31T00:00:00.000Z"),
    );

    expect(summary.progressPct).toBe(100);
    expect(summary.currentWindowStatus).toBe("completed");
    expect(summary.nextHistoricalWindowAt).toBeNull();
  });

  it("matches a completed moving tail window by start time", async () => {
    const pool = new MockPool([
      {
        rows: [
          {
            window_start: new Date("2026-01-01T00:00:00.000Z"),
            window_end: new Date("2026-01-20T13:00:00.000Z"),
            status: "completed",
            retry_after: null,
            blocked_at: null,
            failure_count: 0,
            last_error: null,
            completed_at: new Date("2026-01-20T13:10:00.000Z"),
            updated_at: new Date("2026-01-20T13:10:00.000Z"),
          },
        ],
      },
    ]);

    const summary = await historicalBackfillSummary(
      pool as unknown as DbPool,
      {
        ...config,
        backfillStartDate: new Date("2026-01-01T00:00:00.000Z"),
        backfillWindowDays: 30,
      } as AppConfig,
      "merchant1",
      new Date("2026-01-20T22:00:00.000Z"),
    );

    expect(summary.expectedWindows).toBe(1);
    expect(summary.completedWindows).toBe(1);
    expect(summary.progressPct).toBe(100);
    expect(summary.currentWindowStatus).toBe("completed");
  });

  it("floors the expected-window grid to the UTC day so the denominator is stable (P12)", async () => {
    const pool = new MockPool([{ rows: [] }]);

    const summary = await historicalBackfillSummary(
      pool as unknown as DbPool,
      {
        ...config,
        backfillStartDate: new Date("2026-06-01T00:00:00.000Z"),
        backfillWindowDays: 30,
      } as AppConfig,
      "merchant1",
      new Date("2026-06-14T22:30:00.000Z"),
    );

    // The last (incomplete) window ends at the start of the UTC day, not the live
    // 22:30 timestamp — so two calls at different times the same day agree.
    expect(summary.expectedWindows).toBe(1);
    expect(summary.currentWindowEnd).toBe("2026-06-14T00:00:00.000Z");
  });

  it("computes 24h throughput, an ETA, and the rows-loaded total", async () => {
    const pool = new MockPool([
      {
        rows: [
          {
            window_start: new Date("2026-06-01T00:00:00.000Z"),
            window_end: new Date("2026-06-08T00:00:00.000Z"),
            status: "completed",
            retry_after: null,
            blocked_at: null,
            failure_count: 0,
            last_error: null,
            completed_at: new Date("2026-06-14T06:00:00.000Z"),
            updated_at: new Date("2026-06-14T06:00:00.000Z"),
            rows_read: 100,
            rows_written: 80,
          },
        ],
      },
    ]);

    const summary = await historicalBackfillSummary(
      pool as unknown as DbPool,
      {
        ...config,
        backfillStartDate: new Date("2026-06-01T00:00:00.000Z"),
        backfillWindowDays: 7,
        historicalBackfillMaxConcurrentWindows: 2,
      } as AppConfig,
      "merchant1",
      new Date("2026-06-14T12:00:00.000Z"),
    );

    // Grid (start 06-01, 7-day windows, floored end 06-14): [06-01,06-08] done,
    // [06-08,06-14] remaining.
    expect(summary.expectedWindows).toBe(2);
    expect(summary.completedWindows).toBe(1);
    expect(summary.windowsCompletedLast24h).toBe(1);
    expect(summary.rowsWrittenTotal).toBe(80);
    expect(summary.maxConcurrentWindows).toBe(2);
    expect(summary.estimatedCompletionAt).not.toBeNull();
  });

  it("surfaces warning, parked, and per-window attention state (P7/P8/P9)", async () => {
    const pool = new MockPool([
      {
        rows: [
          {
            window_start: new Date("2026-01-01T00:00:00.000Z"),
            window_end: new Date("2026-01-31T00:00:00.000Z"),
            status: "completed",
            retry_after: null,
            blocked_at: null,
            failure_count: 0,
            last_error: null,
            completed_at: new Date("2026-02-01T13:00:00.000Z"),
            updated_at: new Date("2026-02-01T13:00:00.000Z"),
            rows_read: 50,
            rows_written: 40,
          },
          {
            window_start: new Date("2026-01-31T00:00:00.000Z"),
            window_end: new Date("2026-03-02T00:00:00.000Z"),
            status: "warning",
            retry_after: null,
            blocked_at: null,
            failure_count: 0,
            last_error: null,
            completed_at: new Date("2026-03-03T13:00:00.000Z"),
            updated_at: new Date("2026-03-03T13:00:00.000Z"),
            rows_read: 10,
            rows_written: 8,
          },
          {
            window_start: new Date("2026-03-02T00:00:00.000Z"),
            window_end: new Date("2026-04-01T00:00:00.000Z"),
            status: "failed",
            retry_after: new Date("2026-04-15T18:00:00.000Z"),
            blocked_at: null,
            failure_count: 1,
            last_error: "Clover request failed with 503.",
            completed_at: null,
            updated_at: new Date("2026-04-15T11:00:00.000Z"),
            rows_read: 0,
            rows_written: 0,
          },
          {
            window_start: new Date("2026-04-01T00:00:00.000Z"),
            window_end: new Date("2026-04-15T00:00:00.000Z"),
            status: "blocked",
            retry_after: null,
            blocked_at: new Date("2026-04-10T00:00:00.000Z"),
            failure_count: 6,
            last_error: "Clover request failed with 401.",
            completed_at: null,
            updated_at: new Date("2026-04-10T00:00:00.000Z"),
            rows_read: 0,
            rows_written: 0,
          },
        ],
      },
    ]);

    const summary = await historicalBackfillSummary(
      pool as unknown as DbPool,
      {
        ...config,
        backfillStartDate: new Date("2026-01-01T00:00:00.000Z"),
        backfillWindowDays: 30,
      } as AppConfig,
      "merchant1",
      new Date("2026-04-15T12:00:00.000Z"),
    );

    expect(summary.expectedWindows).toBe(4);
    expect(summary.completedWindows).toBe(2); // completed + warning both count as done
    expect(summary.warningWindows).toBe(1);
    expect(summary.failedWindows).toBe(1);
    expect(summary.blockedWindows).toBe(1);
    // failure_count 6 >= maxWindowFailures(3) + maxAutoUnblockAttempts(3) -> parked
    expect(summary.parkedWindows).toBe(1);
    expect(summary.needsManualIntervention).toBe(true);

    expect(summary.attentionWindows).toHaveLength(3);
    expect(summary.attentionWindows.map((w) => w.status)).toEqual(["warning", "failed", "blocked"]);
    expect(summary.attentionWindows[2]!.parked).toBe(true);
    expect(summary.attentionWindows[1]!.lastError).toBe("Clover request failed with 503.");
  });

  it("reports an idle backfill (no window grid) instead of a false-green completed (P8)", async () => {
    const pool = new MockPool([{ rows: [] }]);

    const summary = await historicalBackfillSummary(
      pool as unknown as DbPool,
      {
        ...config,
        backfillStartDate: new Date("2026-05-01T00:00:00.000Z"),
        backfillWindowDays: 30,
      } as AppConfig,
      "merchant1",
      new Date("2026-04-15T12:00:00.000Z"),
    );

    expect(summary.expectedWindows).toBe(0);
    expect(summary.progressPct).toBe(0);
    expect(summary.currentWindowStatus).toBe("idle");
    expect(summary.needsManualIntervention).toBe(false);
    expect(summary.attentionWindows).toEqual([]);
  });

  it("returns sales rows from mart materialized views", async () => {
    const pool = new MockPool([
      { rows: [{ business_date: "2026-04-26", order_count: 5, net_sales_cents: "12345" }] },
      { rows: [{ today_net_sales_cents: "12345", today_order_count: "5" }] },
    ]);
    const { req, res, body } = httpPair({ authorization: "Bearer admin-secret" });

    await callAdminApi(
      req,
      res,
      pool as unknown as DbPool,
      config,
      new URL("http://localhost/admin/api/sales?days=7"),
    );

    const payload = JSON.parse(body.value);
    expect(res.statusCode).toBe(200);
    expect(payload.days).toBe(7);
    expect(payload.daily[0].net_sales_cents).toBe("12345");
    expect(pool.calls[0]!.sql).toContain("mart.sales_daily_mv");
    expect(pool.calls[0]!.params).toEqual(["merchant1", "America/Chicago", 7]);
  });

  it("returns sales rows for an explicit date range", async () => {
    const pool = new MockPool([
      { rows: [{ business_date: "2026-04-15", order_count: 8, net_sales_cents: "22345" }] },
      { rows: [{ range_payment_total_cents: "25000", range_refund_total_cents: "0" }] },
    ]);
    const { req, res, body } = httpPair({ authorization: "Bearer admin-secret" });

    await callAdminApi(
      req,
      res,
      pool as unknown as DbPool,
      config,
      new URL("http://localhost/admin/api/sales?from=2026-04-01&to=2026-04-30"),
    );

    const payload = JSON.parse(body.value);
    expect(res.statusCode).toBe(200);
    expect(payload.from).toBe("2026-04-01");
    expect(payload.to).toBe("2026-04-30");
    expect(payload.daily[0].net_sales_cents).toBe("22345");
    expect(pool.calls[0]!.sql).toContain("business_date BETWEEN $2::date AND $3::date");
    expect(pool.calls[0]!.params).toEqual(["merchant1", "2026-04-01", "2026-04-30"]);
  });

  it("rejects sales requests that mix days and from/to modes", async () => {
    const pool = new MockPool();
    const { req, res, body } = httpPair({ authorization: "Bearer admin-secret" });

    await callAdminApi(
      req,
      res,
      pool as unknown as DbPool,
      config,
      new URL("http://localhost/admin/api/sales?days=30&from=2026-04-01&to=2026-04-30"),
    );

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(body.value)).toEqual({ error: "provide either days or from+to, not both" });
    expect(pool.calls).toHaveLength(0);
  });

  it("rejects sales ranges where from is after to", async () => {
    const pool = new MockPool();
    const { req, res, body } = httpPair({ authorization: "Bearer admin-secret" });

    await callAdminApi(
      req,
      res,
      pool as unknown as DbPool,
      config,
      new URL("http://localhost/admin/api/sales?from=2026-05-01&to=2026-04-30"),
    );

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(body.value)).toEqual({ error: "from must be <= to" });
    expect(pool.calls).toHaveLength(0);
  });

  it("rejects sales ranges longer than 365 days", async () => {
    const pool = new MockPool();
    const { req, res, body } = httpPair({ authorization: "Bearer admin-secret" });

    await callAdminApi(
      req,
      res,
      pool as unknown as DbPool,
      config,
      new URL("http://localhost/admin/api/sales?from=2025-01-01&to=2026-01-01"),
    );

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(body.value)).toEqual({ error: "range must be <= 365 days" });
    expect(pool.calls).toHaveLength(0);
  });

  it("rejects hourly API requests without a valid bearer token", async () => {
    const pool = new MockPool();
    const { req, res, body } = httpPair();

    await callAdminApi(
      req,
      res,
      pool as unknown as DbPool,
      config,
      new URL("http://localhost/admin/api/hourly"),
    );

    expect(res.statusCode).toBe(401);
    expect(JSON.parse(body.value)).toEqual({ error: "unauthorized" });
    expect(pool.calls).toHaveLength(0);
  });

  it("rejects invalid hourly days params", async () => {
    const pool = new MockPool();
    const { req, res, body } = httpPair({ authorization: "Bearer admin-secret" });

    await callAdminApi(
      req,
      res,
      pool as unknown as DbPool,
      config,
      new URL("http://localhost/admin/api/hourly?days=91"),
    );

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(body.value)).toEqual({ error: "invalid days" });
    expect(pool.calls).toHaveLength(0);
  });

  it("returns hourly sales rows from mart materialized views", async () => {
    const pool = new MockPool([
      {
        rows: [
          {
            business_date: "2026-04-26",
            hour: 10,
            order_count: 5,
            payment_total_cents: "15000",
            net_sales_cents: "12345",
          },
        ],
      },
    ]);
    const { req, res, body } = httpPair({ authorization: "Bearer admin-secret" });

    await callAdminApi(
      req,
      res,
      pool as unknown as DbPool,
      config,
      new URL("http://localhost/admin/api/hourly?days=30"),
    );

    const payload = JSON.parse(body.value);
    expect(res.statusCode).toBe(200);
    expect(payload[0]).toEqual({
      business_date: "2026-04-26",
      hour: 10,
      order_count: 5,
      payment_total_cents: "15000",
      net_sales_cents: "12345",
    });
    expect(pool.calls[0]!.sql).toContain("mart.sales_hourly_mv");
    expect(pool.calls[0]!.sql).toContain("local_hour AS hour");
    expect(pool.calls[0]!.params).toEqual(["merchant1", "America/Chicago", 30]);
  });

  it("rejects database stats requests without a valid bearer token", async () => {
    const pool = new MockPool();
    const { req, res, body } = httpPair();

    await callAdminApi(
      req,
      res,
      pool as unknown as DbPool,
      config,
      new URL("http://localhost/admin/api/database"),
    );

    expect(res.statusCode).toBe(401);
    expect(JSON.parse(body.value)).toEqual({ error: "unauthorized" });
    expect(pool.calls).toHaveLength(0);
  });

  it("returns database stats from allowlisted schemas with refresh timestamps for materialized views", async () => {
    const refreshedAt = new Date("2026-05-10T12:34:56.000Z");
    const pool = new MockPool([
      {
        rows: [
          {
            schema: "mart",
            table_name: "sales_daily_mv",
            row_count: "91",
            bytes_total: "4096",
            size_pretty: "4096 bytes",
            last_refreshed_at: refreshedAt,
          },
          {
            schema: "raw",
            table_name: "clover_orders",
            row_count: "1183",
            bytes_total: "2048",
            size_pretty: "2048 bytes",
            last_refreshed_at: null,
          },
          {
            schema: "pg_catalog",
            table_name: "pg_statistic",
            row_count: "999",
            bytes_total: "999999",
            size_pretty: "999 kB",
            last_refreshed_at: refreshedAt,
          },
        ],
      },
    ]);
    const { req, res, body } = httpPair({ authorization: "Bearer admin-secret" });

    await callAdminApi(
      req,
      res,
      pool as unknown as DbPool,
      config,
      new URL("http://localhost/admin/api/database"),
    );

    const payload = JSON.parse(body.value);
    expect(res.statusCode).toBe(200);
    expect(payload.tables).toEqual([
      {
        schema: "mart",
        table_name: "sales_daily_mv",
        row_count: 91,
        bytes_total: 4096,
        size_pretty: "4096 bytes",
        last_refreshed_at: "2026-05-10T12:34:56.000Z",
      },
      {
        schema: "raw",
        table_name: "clover_orders",
        row_count: 1183,
        bytes_total: 2048,
        size_pretty: "2048 bytes",
        last_refreshed_at: null,
      },
    ]);
    expect(payload.totals).toEqual({
      table_count: 2,
      bytes_total: 6144,
      size_pretty: "6.0 kB",
    });
    expect(pool.calls[0]!.sql).toContain("pg_stat_user_tables");
    expect(pool.calls[0]!.sql).toContain("pg_total_relation_size");
    expect(pool.calls[0]!.sql).toContain("stats.schemaname IN ('mart', 'audit', 'meta', 'raw')");
  });

  it("rejects per-item hourly and modifier requests without a valid bearer token", async () => {
    for (const path of [
      "/admin/api/items/fp123/hourly",
      "/admin/api/items/fp123/modifiers",
    ]) {
      const pool = new MockPool();
      const { req, res, body } = httpPair();

      await callAdminApi(
        req,
        res,
        pool as unknown as DbPool,
        config,
        new URL(`http://localhost${path}`),
      );

      expect(res.statusCode).toBe(401);
      expect(JSON.parse(body.value)).toEqual({ error: "unauthorized" });
      expect(pool.calls).toHaveLength(0);
    }
  });

  it("returns per-item hourly rows with the expected shape", async () => {
    const pool = new MockPool([
      {
        rows: [
          {
            business_date: "2026-04-26",
            local_hour: 11,
            quantity: "4.000",
            gross_sales_cents: "1200",
            line_count: 4,
          },
          {
            business_date: "2026-04-26",
            local_hour: 12,
            quantity: "7.000",
            gross_sales_cents: "2100",
            line_count: 7,
          },
        ],
      },
    ]);
    const { req, res, body } = httpPair({ authorization: "Bearer admin-secret" });

    await callAdminApi(
      req,
      res,
      pool as unknown as DbPool,
      config,
      new URL("http://localhost/admin/api/items/fp123/hourly?days=30"),
    );

    const payload = JSON.parse(body.value);
    expect(res.statusCode).toBe(200);
    expect(payload).toEqual({
      item_fingerprint: "fp123",
      days: 30,
      rows: [
        {
          business_date: "2026-04-26",
          local_hour: 11,
          quantity: "4.000",
          gross_sales_cents: "1200",
          line_count: 4,
        },
        {
          business_date: "2026-04-26",
          local_hour: 12,
          quantity: "7.000",
          gross_sales_cents: "2100",
          line_count: 7,
        },
      ],
    });
    expect(pool.calls[0]!.sql).toContain("mart.item_sales_hourly_mv");
    expect(pool.calls[0]!.params).toEqual(["merchant1", "America/Chicago", "fp123", 30]);
  });

  it("returns per-item modifier rows with attach_rate in [0,1] and line_count exposed", async () => {
    const pool = new MockPool([
      {
        rows: [
          {
            modifier_name: "Add Oreo",
            modifier_count: 12,
            modifier_total_cents: "240",
            attach_rate: "0.4000",
            line_count: 30,
          },
          {
            modifier_name: "Add Strawberry",
            modifier_count: 5,
            modifier_total_cents: "100",
            attach_rate: "0.1667",
            line_count: 30,
          },
        ],
      },
    ]);
    const { req, res, body } = httpPair({ authorization: "Bearer admin-secret" });

    await callAdminApi(
      req,
      res,
      pool as unknown as DbPool,
      config,
      new URL("http://localhost/admin/api/items/fp123/modifiers?days=30"),
    );

    const payload = JSON.parse(body.value);
    expect(res.statusCode).toBe(200);
    expect(payload.item_fingerprint).toBe("fp123");
    expect(payload.days).toBe(30);
    expect(payload.line_count).toBe(30);
    expect(payload.modifiers).toHaveLength(2);
    for (const modifier of payload.modifiers) {
      expect(modifier).toHaveProperty("attach_rate");
      const rate = Number(modifier.attach_rate);
      expect(Number.isFinite(rate)).toBe(true);
      expect(rate).toBeGreaterThanOrEqual(0);
      expect(rate).toBeLessThanOrEqual(1);
    }
    expect(pool.calls[0]!.sql).toContain("mart.fact_line_item_modifiers");
    expect(pool.calls[0]!.sql).toContain("COUNT(DISTINCT (m.order_id, m.line_item_fingerprint))");
    expect(pool.calls[0]!.params).toEqual(["merchant1", "America/Chicago", "fp123", 30]);
  });

  it("clamps per-item days to [1, 90] matching /admin/api/items", async () => {
    const pool = new MockPool([{ rows: [] }]);
    const { req, res } = httpPair({ authorization: "Bearer admin-secret" });

    await callAdminApi(
      req,
      res,
      pool as unknown as DbPool,
      config,
      new URL("http://localhost/admin/api/items/fp123/hourly?days=999"),
    );

    expect(res.statusCode).toBe(200);
    expect(pool.calls[0]!.params).toEqual(["merchant1", "America/Chicago", "fp123", 90]);

    const poolLow = new MockPool([{ rows: [] }]);
    const { req: reqLow, res: resLow } = httpPair({ authorization: "Bearer admin-secret" });
    await callAdminApi(
      reqLow,
      resLow,
      poolLow as unknown as DbPool,
      config,
      new URL("http://localhost/admin/api/items/fp123/hourly?days=0"),
    );
    expect(resLow.statusCode).toBe(200);
    expect(poolLow.calls[0]!.params).toEqual(["merchant1", "America/Chicago", "fp123", 1]);
  });

  it("decodes URL-encoded item fingerprints in the per-item routes", async () => {
    const pool = new MockPool([{ rows: [] }]);
    const { req, res, body } = httpPair({ authorization: "Bearer admin-secret" });

    await callAdminApi(
      req,
      res,
      pool as unknown as DbPool,
      config,
      new URL("http://localhost/admin/api/items/foo%2Fbar%3Abaz/hourly?days=30"),
    );

    const payload = JSON.parse(body.value);
    expect(res.statusCode).toBe(200);
    expect(payload.item_fingerprint).toBe("foo/bar:baz");
    expect(pool.calls[0]!.params).toEqual([
      "merchant1",
      "America/Chicago",
      "foo/bar:baz",
      30,
    ]);
  });

  it("returns nested transaction line items with modifier and alternate name fields", async () => {
    const pool = new MockPool([
      {
        rows: [
          {
            payment_id: "pay1",
            order_id: "order1",
            amount_cents: 764,
            line_items: [
              {
                itemName: "Special#2",
                alternateName: "Strawberry mix-in",
                modifiers: [{ name: "Mix Oreo Cookie" }],
              },
            ],
          },
        ],
      },
    ]);
    const { req, res, body } = httpPair({ authorization: "Bearer admin-secret" });

    await callAdminApi(
      req,
      res,
      pool as unknown as DbPool,
      config,
      new URL("http://localhost/admin/api/transactions?limit=10"),
    );

    const payload = JSON.parse(body.value);
    expect(res.statusCode).toBe(200);
    expect(payload.transactions[0].line_items[0].alternateName).toBe("Strawberry mix-in");
    expect(payload.transactions[0].line_items[0].modifiers[0].name).toBe("Mix Oreo Cookie");
    expect(pool.calls[0]!.sql).toContain("mart.fact_order_line_items");
    expect(pool.calls[0]!.params).toEqual(["merchant1", 10]);
  });
});

class MockPool {
  calls: QueryCall[] = [];

  constructor(private readonly results: Array<{ rows?: unknown[]; rowCount?: number }> = []) {}

  async query(sql: string, params?: unknown[]) {
    this.calls.push({ sql, params });
    return this.results.shift() ?? { rows: [], rowCount: 0 };
  }
}

function httpPair(headers: Record<string, string> = {}) {
  const req = {
    method: "GET",
    headers,
  } as IncomingMessage;

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

  return { req, res, body };
}
