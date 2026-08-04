import type { IncomingMessage, ServerResponse } from "node:http";
import { runSafeAiQuery } from "../analytics/safe-query.js";
import { loadMetricRegistry, resolveMetric } from "../analytics/metric-registry.js";
import { fullBackfillWindows } from "../backfill/windows.js";
import type { AppConfig } from "../config.js";
import type { DbPool } from "../db.js";
import { nextHistoricalBackfillWindowAt } from "../scheduler/scheduler.js";
import { isAdminAuthorized } from "./admin.js";
import { enforceTenantScope } from "../lib/tenant-auth.js";
import { handleAdminBackfillRequeue } from "./backfill-requeue.js";
import { readJsonBody, respondJson } from "./health.js";
import { handleAdminMetric, handleAdminMetricsList } from "./metric-route.js";
import { handleAdminMetricStats } from "./metric-stats-route.js";
import { handleAdminMetricDrivers } from "./metric-drivers-route.js";
import { handleAdminDataTrust } from "./data-trust-route.js";
import { handleAdminSyncActualCogs } from "./sync-actual-cogs.js";
import { handleAdminSyncLaborCosts } from "./sync-labor-costs.js";
import { handleAdminSyncPlateCosts } from "./sync-plate-costs.js";
import { trendsBreakdown } from "./trends-breakdown.js";
import { completenessReport } from "./completeness.js";
import { menuEngineering } from "./menu-engineering.js";
import { costsSummary } from "./costs-summary.js";
import { forecastRead, handleAdminForecastRun } from "./forecast.js";
import type { SyncTargetsReader } from "../sync-targets/repository.js";

const AI_SQL_MAX_BODY_BYTES = 16 * 1024;

const VALID_SALES_DAYS = new Set([7, 30, 90]);
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

type SalesWindow = { mode: "days"; days: number } | { mode: "range"; from: string; to: string };

export async function handleAdminDashboard(
  req: IncomingMessage,
  res: ServerResponse,
  pool: DbPool,
  config: AppConfig,
  url: URL,
  syncTargets: SyncTargetsReader,
) {
  if (req.method === "POST" && url.pathname === "/admin/api/ai-sql") {
    return handleAdminAiSql(req, res, pool, config);
  }

  if (req.method === "POST" && url.pathname === "/admin/api/metric") {
    return handleAdminMetric(req, res, pool, config, url, syncTargets);
  }

  if (req.method === "POST" && url.pathname === "/admin/api/metric-stats") {
    return handleAdminMetricStats(req, res, pool, config, url, syncTargets);
  }

  if (req.method === "POST" && url.pathname === "/admin/api/metric/drivers") {
    return handleAdminMetricDrivers(req, res, pool, config, url);
  }

  if (req.method === "POST" && url.pathname === "/admin/api/data-trust") {
    return handleAdminDataTrust(req, res, pool, config, url);
  }

  if (req.method === "POST" && url.pathname === "/admin/api/sync-plate-costs") {
    return handleAdminSyncPlateCosts(req, res, pool, config);
  }

  if (req.method === "POST" && url.pathname === "/admin/api/sync-labor-costs") {
    return handleAdminSyncLaborCosts(req, res, pool, config);
  }

  if (req.method === "POST" && url.pathname === "/admin/api/sync-actual-cogs") {
    return handleAdminSyncActualCogs(req, res, pool, config);
  }

  if (req.method === "POST" && url.pathname === "/admin/api/forecast/run") {
    return handleAdminForecastRun(req, res, pool, config, url);
  }

  if (req.method === "POST" && url.pathname === "/admin/api/backfill/requeue") {
    return handleAdminBackfillRequeue(req, res, pool, config, url);
  }

  if (req.method === "GET" && url.pathname === "/admin/api/metrics") {
    return handleAdminMetricsList(req, res, pool, config);
  }

  if (req.method !== "GET") {
    return respondJson(res, 405, { error: "method not allowed" });
  }

  if (url.pathname === "/admin" || url.pathname === "/admin/") {
    return respondRedirect(res, backofficeOpsUrl(config));
  }

  if (url.pathname.startsWith("/admin/api/")) {
    return handleAdminApi(req, res, pool, config, url, syncTargets);
  }

  return respondJson(res, 404, { error: "not found" });
}

export async function handleAdminAiSql(
  req: IncomingMessage,
  res: ServerResponse,
  pool: DbPool,
  config: AppConfig,
) {
  if (!isAdminAuthorized(req, config)) {
    return respondJson(res, 401, { error: "unauthorized" });
  }

  const contentType = req.headers["content-type"] ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    return respondJson(res, 415, { error: "unsupported_media_type" });
  }

  let bodyText: string;
  try {
    bodyText = await readJsonBody(req, AI_SQL_MAX_BODY_BYTES);
  } catch (error) {
    return respondJson(res, 413, {
      error: "body_too_large",
      message: error instanceof Error ? error.message : "body read failed",
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return respondJson(res, 400, { error: "invalid_json" });
  }

  if (!parsed || typeof parsed !== "object") {
    return respondJson(res, 400, { error: "invalid_body" });
  }

  const { sql, question, user_id: userId } = parsed as {
    sql?: unknown;
    question?: unknown;
    user_id?: unknown;
  };

  if (typeof sql !== "string" || sql.length < 20 || sql.length > 2000) {
    return respondJson(res, 400, { error: "invalid_sql_length" });
  }
  if (question !== undefined && (typeof question !== "string" || question.length > 500)) {
    return respondJson(res, 400, { error: "invalid_question" });
  }
  if (userId !== undefined && typeof userId !== "string") {
    return respondJson(res, 400, { error: "invalid_user_id" });
  }

  try {
    const rows = await runSafeAiQuery(pool, {
      sql,
      rowLimit: config.aiQueryRowLimit,
      statementTimeoutMs: config.sqlStatementTimeoutMs,
      actor: typeof userId === "string" ? `backoffice:${userId}` : "backoffice:ai",
      question: typeof question === "string" ? question : undefined,
    });
    return respondJson(res, 200, {
      rows,
      row_count: rows.length,
      row_limit: config.aiQueryRowLimit,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "ai_sql_failed";
    return respondJson(res, 400, { error: "ai_sql_rejected", message });
  }
}

export async function handleAdminApi(
  req: IncomingMessage,
  res: ServerResponse,
  pool: DbPool,
  config: AppConfig,
  url: URL,
  syncTargets: SyncTargetsReader,
) {
  if (!isAdminAuthorized(req, config)) {
    return respondJson(res, 401, { error: "unauthorized" });
  }

  // Multi-location (ADR-0018): the BFF selects the store via ?merchant_id=,
  // falling back to the env-configured store for single-store deploys.
  const merchantId = url.searchParams.get("merchant_id") ?? config.cloverMerchantId;
  if (!merchantId) {
    return respondJson(res, 400, { error: "merchant_id is required" });
  }

  // Multi-tenant (ADR-0818 Phase 2c): verify the signed tenant claim + that this
  // merchant belongs to the claim's tenant. No-op when MULTITENANT_MODE=off.
  const scope = await enforceTenantScope(req, pool, config, merchantId);
  if (!scope.ok) {
    return respondJson(res, scope.status, { error: scope.error });
  }

  const timezone = await syncTargets.timezoneFor(merchantId, config.storeTimezone);

  if (url.pathname.startsWith("/admin/api/items/")) {
    const match = url.pathname.match(/^\/admin\/api\/items\/([^/]+)\/(hourly|modifiers)$/);
    if (match) {
      const fingerprint = decodeURIComponent(match[1]!);
      const kind = match[2];
      const days = daysParam(url, 30, 90);
      if (kind === "hourly") {
        return respondJson(
          res,
          200,
          await itemHourly(pool, merchantId, timezone, fingerprint, days),
        );
      }
      return respondJson(
        res,
        200,
        await itemModifiers(pool, merchantId, timezone, fingerprint, days),
      );
    }
  }

  switch (url.pathname) {
    case "/admin/api/overview":
      return respondJson(res, 200, await dashboardOverview(pool, config, merchantId));
    case "/admin/api/sales": {
      const window = salesWindow(url);
      if ("error" in window) {
        return respondJson(res, 400, { error: window.error });
      }
      return respondJson(
        res,
        200,
        await salesSummary(pool, merchantId, timezone, window),
      );
    }
    case "/admin/api/hourly": {
      const days = hourlyDays(url);
      if (days === null) {
        return respondJson(res, 400, { error: "invalid days" });
      }
      return respondJson(res, 200, await hourlySales(pool, merchantId, timezone, days));
    }
    case "/admin/api/transactions":
      return respondJson(
        res,
        200,
        await recentTransactions(pool, merchantId, limitParam(url, 50, 100)),
      );
    case "/admin/api/items":
      return respondJson(
        res,
        200,
        await topItems(pool, merchantId, timezone, daysParam(url, 30, 90)),
      );
    case "/admin/api/menu-engineering":
      return respondJson(
        res,
        200,
        await menuEngineering(pool, merchantId, timezone, daysParam(url, 30, 90)),
      );
    case "/admin/api/costs":
      return respondJson(
        res,
        200,
        await costsSummary(pool, merchantId, timezone, daysParam(url, 30, 90)),
      );
    case "/admin/api/trends/breakdown": {
      const from = url.searchParams.get("from");
      const to = url.searchParams.get("to");
      if (!from || !to || !ISO_DATE_RE.test(from) || !ISO_DATE_RE.test(to)) {
        return respondJson(res, 400, { error: "from and to (YYYY-MM-DD) are required" });
      }
      if (from > to) {
        return respondJson(res, 400, { error: "from must be <= to" });
      }
      return respondJson(res, 200, await trendsBreakdown(pool, merchantId, from, to));
    }
    case "/admin/api/completeness": {
      // Defaults to a rolling ~13-month window (bounded UI); the report's
      // olderMissing count still covers all years before `from`.
      const to = url.searchParams.get("to") ?? new Date().toISOString().slice(0, 10);
      const fromDefault = new Date(`${to}T00:00:00.000Z`);
      fromDefault.setUTCMonth(fromDefault.getUTCMonth() - 13);
      const from = url.searchParams.get("from") ?? fromDefault.toISOString().slice(0, 10);
      if (!ISO_DATE_RE.test(from) || !ISO_DATE_RE.test(to) || from > to) {
        return respondJson(res, 400, { error: "from/to must be YYYY-MM-DD with from <= to" });
      }
      return respondJson(res, 200, await completenessReport(pool, merchantId, from, to));
    }
    case "/admin/api/forecast":
      return respondJson(res, 200, await forecastRead(pool, merchantId));
    case "/admin/api/jobs":
      return respondJson(res, 200, await jobStatus(pool, merchantId));
    case "/admin/api/database":
      return respondJson(res, 200, await databaseStats(pool));
    default:
      return respondJson(res, 404, { error: "not found" });
  }
}

async function dashboardOverview(pool: DbPool, config: AppConfig, merchantId: string) {
  const [health, heartbeats, jobCounts, ranges, dirtyWindows, dqFailures, reconBreaks, historicalBackfill] =
    await Promise.all([
      pool.query(
        `
        SELECT merchant_id,
               last_hourly_sweep_at,
               last_export_reconcile_at,
               webhook_lag_seconds,
               open_repair_count,
               failed_job_count,
               dq_failed_count,
               dirty_window_backlog
        FROM audit.sync_health
        WHERE merchant_id = $1
      `,
        [merchantId],
      ),
      pool.query(
        `
        SELECT component, instance_id, last_seen_at,
               extract(epoch FROM (now() - last_seen_at))::integer AS age_seconds,
               details
        FROM audit.service_heartbeats
        ORDER BY component
      `,
      ),
      pool.query(
        `
        SELECT job_type, status, count(*)::integer AS count
        FROM audit.sync_jobs
        WHERE merchant_id = $1
        GROUP BY job_type, status
        ORDER BY job_type, status
      `,
        [merchantId],
      ),
      pool.query(
        `
        SELECT *
        FROM (
          SELECT 'raw_orders' AS name, count(*)::integer AS row_count, min(created_time_utc) AS min_time, max(created_time_utc) AS max_time
          FROM raw.clover_orders WHERE merchant_id = $1
          UNION ALL
          SELECT 'raw_payments', count(*)::integer, min(created_time_utc), max(created_time_utc)
          FROM raw.clover_payments WHERE merchant_id = $1
          UNION ALL
          SELECT 'mart_orders', count(*)::integer, min(created_at_utc), max(created_at_utc)
          FROM mart.fact_orders WHERE merchant_id = $1
          UNION ALL
          SELECT 'mart_payments', count(*)::integer, min(created_at_utc), max(created_at_utc)
          FROM mart.fact_payments WHERE merchant_id = $1
          UNION ALL
          SELECT 'mart_line_items', count(*)::integer, min(created_at_utc), max(created_at_utc)
          FROM mart.fact_order_line_items WHERE merchant_id = $1
        ) ranges
        ORDER BY name
      `,
        [merchantId],
      ),
      pool.query(
        `
        SELECT status, count(*)::integer AS count
        FROM audit.dirty_windows
        WHERE merchant_id = $1
        GROUP BY status
        ORDER BY status
      `,
        [merchantId],
      ),
      pool.query(
        `
        SELECT check_name, status, severity, details, created_at
        FROM audit.data_quality_checks
        WHERE merchant_id = $1
          AND status <> 'passed'
        ORDER BY created_at DESC
        LIMIT 20
      `,
        [merchantId],
      ),
      loadReconBreaks(pool, merchantId),
      historicalBackfillSummary(pool, config, merchantId),
    ]);

  return {
    merchantId,
    health: health.rows[0] ?? null,
    heartbeats: heartbeats.rows,
    jobCounts: jobCounts.rows,
    dirtyWindows: dirtyWindows.rows,
    historicalBackfill,
    dataRanges: ranges.rows,
    dqFailures: dqFailures.rows,
    reconBreaks: reconBreaks.rows,
  };
}

// Unresolved reconciliation breaks: the latest reconcile per business_date whose
// newest status is 'failed'. reconciliation_results is INSERT-only (one row per
// reconcile run, no resolved_at), so DISTINCT ON the newest row per date IS the
// current truth — a later 'passed' row for the same date (e.g. after a repair
// self-heals it, see reconciliation-check.ts) supersedes the break and drops it
// from this list. business_date is forced to text to bypass node-postgres' date
// parser (off-by-one risk). Extracted so the reconcile re-verify loop can assert
// against the exact query the ops panel reads.
export async function loadReconBreaks(pool: DbPool, merchantId: string) {
  return pool.query(
    `
    WITH latest AS (
      SELECT DISTINCT ON (business_date)
        business_date, status, order_count_delta, payment_total_delta_cents,
        net_sales_delta_cents, refund_delta_cents, created_at
      FROM audit.reconciliation_results
      WHERE merchant_id = $1
      ORDER BY business_date, created_at DESC
    )
    SELECT
      to_char(business_date, 'YYYY-MM-DD') AS business_date,
      order_count_delta,
      payment_total_delta_cents,
      net_sales_delta_cents,
      refund_delta_cents,
      created_at
    FROM latest
    WHERE status = 'failed'
    ORDER BY business_date DESC
    LIMIT 30
  `,
    [merchantId],
  );
}

export async function historicalBackfillSummary(
  pool: DbPool,
  config: AppConfig,
  merchantId: string,
  now = new Date(),
) {
  const backfillStartDate = config.backfillStartDate ?? new Date("2018-04-01T00:00:00.000Z");
  const backfillWindowDays = config.backfillWindowDays ?? 30;
  // P12: build the expected-window grid against the start of the current UTC day,
  // not the live `now`. The grid (and therefore expectedWindows / progressPct's
  // denominator) is then stable across requests within a day instead of drifting
  // every call. `now` is still used for rate/ETA and the next-window estimate.
  const gridEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const windows = fullBackfillWindows(backfillStartDate, gridEnd, backfillWindowDays);
  const result = await pool.query<HistoricalBackfillRow>(
    `
      SELECT window_start, window_end, status, retry_after, blocked_at,
             failure_count, last_error, completed_at, updated_at,
             rows_read, rows_written
      FROM audit.sync_windows
      WHERE merchant_id = $1
        AND window_type = 'historical_export_backfill'
      ORDER BY window_start ASC
    `,
    [merchantId],
  );

  const rowsByWindow = new Map(
    result.rows.map((row) => [`${dateIso(row.window_start)}|${dateIso(row.window_end)}`, row]),
  );
  const rowsByStart = new Map<string, HistoricalBackfillRow>();
  for (const row of result.rows) {
    const key = dateIso(row.window_start);
    const existing = rowsByStart.get(key);
    if (!existing || historicalRowRank(row) < historicalRowRank(existing)) {
      rowsByStart.set(key, row);
      continue;
    }
    if (
      historicalRowRank(row) === historicalRowRank(existing) &&
      new Date(row.window_end).getTime() > new Date(existing.window_end).getTime()
    ) {
      rowsByStart.set(key, row);
    }
  }
  const expectedRows = windows.map((window) => ({
    window,
    row:
      rowsByWindow.get(`${window.start.toISOString()}|${window.end.toISOString()}`) ??
      rowsByStart.get(window.start.toISOString()) ??
      null,
  }));
  const isComplete = (row: HistoricalBackfillRow | null) =>
    row?.status === "completed" || row?.status === "warning";
  const completedWindows = expectedRows.filter(({ row }) => isComplete(row)).length;
  const failedWindows = expectedRows.filter(({ row }) => row?.status === "failed").length;
  const blockedWindows = expectedRows.filter(({ row }) => row?.status === "blocked").length;
  const warningWindows = expectedRows.filter(({ row }) => row?.status === "warning").length;
  const runningWindows = expectedRows.filter(({ row }) => row?.status === "running").length;
  const current = expectedRows.find(({ row }) => !isComplete(row)) ?? null;

  // P7/P8/P9: surface the recovery state the summary used to fetch and discard.
  // A window is "parked" (needs manual intervention) once it is blocked AND has
  // burned through the auto-unblock budget — the scheduler will not retry it again.
  const parkedCeiling =
    (config.historicalBackfillMaxWindowFailures ?? 3) +
    (config.historicalBackfillMaxAutoUnblockAttempts ?? 3);
  const isParked = (row: HistoricalBackfillRow | null) =>
    row?.status === "blocked" && Number(row.failure_count ?? 0) >= parkedCeiling;
  const parkedWindows = expectedRows.filter(({ row }) => isParked(row)).length;
  const needsManualIntervention = parkedWindows > 0;

  // The windows an operator may need to act on: failed (cooling), blocked
  // (auto-recovering or parked), and warning (completed with DQ warnings). Capped
  // so the payload stays bounded; the aggregate counts above are authoritative.
  const ATTENTION_LIMIT = 100;
  const attentionAll = expectedRows.filter(
    ({ row }) =>
      row?.status === "failed" || row?.status === "blocked" || row?.status === "warning",
  );
  const attentionWindows = attentionAll.slice(0, ATTENTION_LIMIT).map(({ window, row }) => ({
    windowStart: window.start.toISOString(),
    windowEnd: window.end.toISOString(),
    status: row!.status,
    failureCount: Number(row!.failure_count ?? 0),
    blockedAt: row!.blocked_at ? new Date(row!.blocked_at).toISOString() : null,
    retryAfter: row!.retry_after ? new Date(row!.retry_after).toISOString() : null,
    lastError: row!.last_error,
    completedAt: row!.completed_at ? new Date(row!.completed_at).toISOString() : null,
    parked: isParked(row),
  }));

  // Throughput / ETA observability: completion rate over the trailing 24h and a
  // naive remaining/rate projection, so an operator can tell on-track from wedged.
  const dayMs = 24 * 60 * 60 * 1000;
  const windowsCompletedLast24h = result.rows.filter(
    (row) =>
      isComplete(row) &&
      row.completed_at &&
      new Date(row.completed_at).getTime() >= now.getTime() - dayMs,
  ).length;
  const remainingWindows = Math.max(0, windows.length - completedWindows);
  const estimatedCompletionAt =
    windowsCompletedLast24h > 0 && remainingWindows > 0
      ? new Date(now.getTime() + (remainingWindows / windowsCompletedLast24h) * dayMs).toISOString()
      : null;
  const rowsWrittenTotal = result.rows.reduce((sum, row) => sum + Number(row.rows_written ?? 0), 0);
  const latestCompleted = maxDate(
    expectedRows
      .map(({ row }) => (isComplete(row) ? row?.completed_at : null))
      .filter((value): value is Date | string => Boolean(value)),
  );
  // Oldest scheduler touch across all historical windows ≈ when the backfill
  // first started trying. The metrics updater anchors staleness on this when
  // nothing has completed yet (see secondsSinceLastProgress in
  // src/metrics/backfill-gauges.ts).
  const oldestWindowUpdated = minDate(
    result.rows
      .map((row) => row.updated_at)
      .filter((value): value is Date | string => Boolean(value)),
  );
  const currentRetryAfter =
    current?.row?.status === "failed" && current.row.retry_after
      ? new Date(current.row.retry_after)
      : null;
  const latestError =
    current?.row?.last_error ?? latestErroredWindow(result.rows)?.last_error ?? null;
  const nextExportWindow = nextHistoricalBackfillWindowAt(now, backfillWindowConfig(config));
  const nextHistoricalWindowAt =
    !current || current.row?.status === "blocked"
      ? null
      : currentRetryAfter && currentRetryAfter.getTime() > now.getTime()
        ? currentRetryAfter.toISOString()
        : (nextExportWindow?.toISOString() ?? null);

  return {
    expectedWindows: windows.length,
    completedWindows,
    failedWindows,
    blockedWindows,
    progressPct:
      windows.length === 0 ? 0 : Math.round((completedWindows / windows.length) * 1000) / 10,
    currentWindowStart: current ? current.window.start.toISOString() : null,
    currentWindowEnd: current ? current.window.end.toISOString() : null,
    // "idle" (not "completed") when there is no window grid at all, so a never-
    // configured backfill doesn't read as a finished one (P8 false-green fix).
    currentWindowStatus:
      current?.row?.status ?? (current ? "not_started" : windows.length === 0 ? "idle" : "completed"),
    lastCompletedAt: latestCompleted?.toISOString() ?? null,
    oldestWindowUpdatedAt: oldestWindowUpdated?.toISOString() ?? null,
    lastError: latestError,
    nextHistoricalWindowAt,
    runningWindows,
    maxConcurrentWindows: config.historicalBackfillMaxConcurrentWindows ?? 1,
    windowsCompletedLast24h,
    estimatedCompletionAt,
    rowsWrittenTotal,
    warningWindows,
    parkedWindows,
    needsManualIntervention,
    attentionWindows,
  };
}

function toRatio(value: unknown): number | null {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Resolve the two ratio metrics — avg_ticket_cents and refund_rate — per
 * business_date through the governed metric registry (ADR-0030) and merge them
 * onto the raw daily rows. This is the single-source migration (Phase 0): Today
 * and Trends read ONE governed definition off these fields instead of
 * re-deriving the ratios in their transforms.
 *
 * NOTE on 口径: refund_rate here is the registry definition
 * (refund_total / payment_total), which intentionally DIFFERS from the legacy
 * page formula (refund_total / net_sales). The migrated pages adopt this as the
 * canonical refund-rate; the displayed number changes slightly by design.
 * avg_ticket_cents (net_sales / order_count) is unchanged from the old formula.
 */
async function withPerDayRatios(
  pool: DbPool,
  merchantId: string,
  timezone: string,
  window: SalesWindow,
  rows: Record<string, unknown>[],
): Promise<Record<string, unknown>[]> {
  const registry = await loadMetricRegistry(pool);
  // If the governed registry isn't loaded (e.g. migration 010 not yet applied on
  // a fresh DB), serve the raw rows with null ratios rather than failing the whole
  // sales endpoint — the same honest-null posture the cost metrics use when
  // unconfigured. A genuine resolution error (DB fault) below still propagates.
  if (!registry.has("avg_ticket_cents") || !registry.has("refund_rate")) {
    return rows.map((r) => ({ ...r, avg_ticket_cents: null, refund_rate: null }));
  }
  const base = { merchantId, timezone, window, dimensions: ["business_date"] };
  const [avgTicket, refundRate] = await Promise.all([
    resolveMetric(pool, registry, "avg_ticket_cents", base),
    resolveMetric(pool, registry, "refund_rate", base),
  ]);
  const byDate = (result: { rows: Record<string, unknown>[] }) =>
    new Map(result.rows.map((r) => [String(r.business_date), toRatio(r.value)]));
  const avgByDate = byDate(avgTicket);
  const refundByDate = byDate(refundRate);
  return rows.map((r) => ({
    ...r,
    avg_ticket_cents: avgByDate.get(String(r.business_date)) ?? null,
    refund_rate: refundByDate.get(String(r.business_date)) ?? null,
  }));
}

export async function salesSummary(
  pool: DbPool,
  merchantId: string,
  timezone: string,
  window: SalesWindow,
) {
  if (window.mode === "range") {
    const [daily, totals] = await Promise.all([
      pool.query(
        `
          SELECT business_date, order_count, payment_total_cents, refund_total_cents,
                 net_sales_cents, tax_total_cents, tip_total_cents, discount_total_cents
          FROM mart.sales_daily_mv
          WHERE merchant_id = $1
            AND business_date BETWEEN $2::date AND $3::date
          ORDER BY business_date
        `,
        [merchantId, window.from, window.to],
      ),
      pool.query(
        `
          WITH bounds AS (
            SELECT (now() AT TIME ZONE $2)::date AS today
          )
          SELECT
            COALESCE(sum(net_sales_cents) FILTER (WHERE business_date = bounds.today), 0)::bigint AS today_net_sales_cents,
            COALESCE(sum(order_count) FILTER (WHERE business_date = bounds.today), 0)::bigint AS today_order_count,
            COALESCE(sum(net_sales_cents) FILTER (WHERE business_date >= bounds.today - 6), 0)::bigint AS last_7_net_sales_cents,
            COALESCE(sum(order_count) FILTER (WHERE business_date >= bounds.today - 6), 0)::bigint AS last_7_order_count,
            COALESCE(sum(net_sales_cents) FILTER (WHERE business_date >= bounds.today - 29), 0)::bigint AS last_30_net_sales_cents,
            COALESCE(sum(order_count) FILTER (WHERE business_date >= bounds.today - 29), 0)::bigint AS last_30_order_count,
            COALESCE(sum(payment_total_cents), 0)::bigint AS range_payment_total_cents,
            COALESCE(sum(refund_total_cents), 0)::bigint AS range_refund_total_cents,
            COALESCE(sum(tax_total_cents), 0)::bigint AS range_tax_total_cents,
            COALESCE(sum(tip_total_cents), 0)::bigint AS range_tip_total_cents
          FROM mart.sales_daily_mv, bounds
          WHERE merchant_id = $1
            AND business_date BETWEEN $3::date AND $4::date
        `,
        [merchantId, timezone, window.from, window.to],
      ),
    ]);

    return {
      from: window.from,
      to: window.to,
      daily: await withPerDayRatios(pool, merchantId, timezone, window, daily.rows),
      totals: totals.rows[0] ?? {},
    };
  }

  const { days } = window;
  const [daily, totals] = await Promise.all([
    pool.query(
      `
        WITH bounds AS (
          SELECT (now() AT TIME ZONE $2)::date AS today
        )
        SELECT business_date, order_count, payment_total_cents, refund_total_cents,
               net_sales_cents, tax_total_cents, tip_total_cents, discount_total_cents
        FROM mart.sales_daily_mv, bounds
        WHERE merchant_id = $1
          AND business_date >= bounds.today - ($3::integer - 1)
        ORDER BY business_date
      `,
      [merchantId, timezone, days],
    ),
    pool.query(
      `
        WITH bounds AS (
          SELECT (now() AT TIME ZONE $2)::date AS today
        )
        SELECT
          COALESCE(sum(net_sales_cents) FILTER (WHERE business_date = bounds.today), 0)::bigint AS today_net_sales_cents,
          COALESCE(sum(order_count) FILTER (WHERE business_date = bounds.today), 0)::bigint AS today_order_count,
          COALESCE(sum(net_sales_cents) FILTER (WHERE business_date >= bounds.today - 6), 0)::bigint AS last_7_net_sales_cents,
          COALESCE(sum(order_count) FILTER (WHERE business_date >= bounds.today - 6), 0)::bigint AS last_7_order_count,
          COALESCE(sum(net_sales_cents) FILTER (WHERE business_date >= bounds.today - 29), 0)::bigint AS last_30_net_sales_cents,
          COALESCE(sum(order_count) FILTER (WHERE business_date >= bounds.today - 29), 0)::bigint AS last_30_order_count,
          COALESCE(sum(payment_total_cents), 0)::bigint AS range_payment_total_cents,
          COALESCE(sum(refund_total_cents), 0)::bigint AS range_refund_total_cents,
          COALESCE(sum(tax_total_cents), 0)::bigint AS range_tax_total_cents,
          COALESCE(sum(tip_total_cents), 0)::bigint AS range_tip_total_cents
        FROM mart.sales_daily_mv, bounds
        WHERE merchant_id = $1
          AND business_date >= bounds.today - ($3::integer - 1)
      `,
      [merchantId, timezone, days],
    ),
  ]);

  return {
    days,
    daily: await withPerDayRatios(pool, merchantId, timezone, window, daily.rows),
    totals: totals.rows[0] ?? {},
  };
}

async function hourlySales(pool: DbPool, merchantId: string, timezone: string, days: number) {
  const result = await pool.query(
    `
      WITH bounds AS (
        SELECT (now() AT TIME ZONE $2)::date AS today
      )
      SELECT business_date,
             local_hour AS hour,
             order_count,
             payment_total_cents,
             net_sales_cents
      FROM mart.sales_hourly_mv, bounds
      WHERE merchant_id = $1
        AND business_date >= bounds.today - ($3::integer - 1)
      ORDER BY business_date ASC, local_hour ASC
    `,
    [merchantId, timezone, days],
  );

  return result.rows;
}

async function recentTransactions(pool: DbPool, merchantId: string, limit: number) {
  const result = await pool.query(
    `
      WITH recent_payments AS (
        SELECT p.merchant_id, p.payment_id, p.business_date, p.order_id, p.created_at_utc,
               p.employee_id, e.display_name AS employee_name, p.tender_type, p.payment_result,
               p.amount_cents, p.tip_cents, p.tax_cents,
               o.order_label, o.payment_state, o.order_state, o.line_item_count
        FROM mart.fact_payments p
        LEFT JOIN mart.fact_orders o
          ON o.merchant_id = p.merchant_id
         AND o.order_id = p.order_id
         AND o.business_date = p.business_date
        LEFT JOIN mart.dim_employee e
          ON e.merchant_id = p.merchant_id
         AND e.employee_id = p.employee_id
        WHERE p.merchant_id = $1
        ORDER BY p.created_at_utc DESC NULLS LAST, p.payment_id DESC
        LIMIT $2
      )
      SELECT rp.*,
             COALESCE(items.line_items, '[]'::json) AS line_items
      FROM recent_payments rp
      LEFT JOIN LATERAL (
        SELECT json_agg(
          json_build_object(
            'lineItemId', li.line_item_id,
            'itemName', li.item_name,
            'alternateName', di.alternate_name,
            'quantity', li.quantity,
            'unitPriceCents', li.unit_price_cents,
            'modifierTotalCents', li.modifier_total_cents,
            'grossSalesCents', li.gross_sales_cents,
            'taxTotalCents', li.tax_total_cents,
            'modifiers', li.modifiers
          )
          ORDER BY li.created_at_utc, li.item_name
        ) AS line_items
        FROM mart.fact_order_line_items li
        LEFT JOIN mart.dim_item di
          ON di.merchant_id = li.merchant_id
         AND di.item_fingerprint = li.item_fingerprint
        WHERE li.merchant_id = rp.merchant_id
          AND li.order_id = rp.order_id
          AND li.business_date = rp.business_date
      ) items ON true
      ORDER BY rp.created_at_utc DESC NULLS LAST, rp.payment_id DESC
    `,
    [merchantId, limit],
  );

  return { transactions: result.rows };
}

async function topItems(pool: DbPool, merchantId: string, timezone: string, days: number) {
  const result = await pool.query(
    `
      WITH bounds AS (
        SELECT (now() AT TIME ZONE $2)::date AS today
      )
      SELECT li.item_fingerprint,
             min(li.item_name) AS item_name,
             max(di.alternate_name) AS alternate_name,
             sum(li.quantity)::numeric(14, 3) AS quantity,
             sum(li.gross_sales_cents)::bigint AS gross_sales_cents,
             sum(li.modifier_total_cents)::bigint AS modifier_total_cents,
             count(*)::integer AS line_count,
             count(*) FILTER (WHERE jsonb_array_length(li.modifiers) > 0)::integer AS modifier_line_count
      FROM mart.fact_order_line_items li
      LEFT JOIN mart.dim_item di
        ON di.merchant_id = li.merchant_id
       AND di.item_fingerprint = li.item_fingerprint,
      bounds
      WHERE li.merchant_id = $1
        AND li.business_date >= bounds.today - ($3::integer - 1)
        AND li.refunded = false
      GROUP BY li.item_fingerprint
      ORDER BY gross_sales_cents DESC, quantity DESC
      LIMIT 50
    `,
    [merchantId, timezone, days],
  );

  return { days, items: result.rows };
}

async function itemHourly(
  pool: DbPool,
  merchantId: string,
  timezone: string,
  fingerprint: string,
  days: number,
) {
  const result = await pool.query(
    `
      WITH bounds AS (SELECT (now() AT TIME ZONE $2)::date AS today)
      SELECT business_date, local_hour, quantity, gross_sales_cents, line_count
      FROM mart.item_sales_hourly_mv, bounds
      WHERE merchant_id = $1 AND item_fingerprint = $3
        AND business_date >= bounds.today - ($4::integer - 1)
      ORDER BY business_date ASC, local_hour ASC
    `,
    [merchantId, timezone, fingerprint, days],
  );

  return { item_fingerprint: fingerprint, days, rows: result.rows };
}

async function itemModifiers(
  pool: DbPool,
  merchantId: string,
  timezone: string,
  fingerprint: string,
  days: number,
) {
  const result = await pool.query<{
    modifier_name: string;
    modifier_count: number;
    modifier_total_cents: number | string;
    attach_rate: number | string;
    line_count: number | string;
  }>(
    `
      WITH bounds AS (SELECT (now() AT TIME ZONE $2)::date AS today),
      line_total AS (
        SELECT count(*)::integer AS line_count
        FROM mart.fact_order_line_items, bounds
        WHERE merchant_id = $1 AND item_fingerprint = $3
          AND business_date >= bounds.today - ($4::integer - 1)
          AND refunded = false
      )
      SELECT m.modifier_name,
             count(*)::integer AS modifier_count,
             sum(m.modifier_amount_cents)::bigint AS modifier_total_cents,
             (COUNT(DISTINCT (m.order_id, m.line_item_fingerprint))::numeric
               / NULLIF((SELECT line_count FROM line_total), 0))::numeric(6,4) AS attach_rate,
             (SELECT line_count FROM line_total) AS line_count
      FROM mart.fact_line_item_modifiers m, bounds
      WHERE m.merchant_id = $1 AND m.item_fingerprint = $3
        AND m.business_date >= bounds.today - ($4::integer - 1)
      GROUP BY m.modifier_name
      ORDER BY modifier_count DESC, modifier_total_cents DESC
      LIMIT 10
    `,
    [merchantId, timezone, fingerprint, days],
  );

  const lineCount = Number(result.rows[0]?.line_count ?? 0);
  const modifiers = result.rows.map((row) => ({
    modifier_name: row.modifier_name,
    modifier_count: row.modifier_count,
    modifier_total_cents: row.modifier_total_cents,
    attach_rate: row.attach_rate,
  }));

  return { item_fingerprint: fingerprint, days, line_count: lineCount, modifiers };
}

async function jobStatus(pool: DbPool, merchantId: string) {
  const [jobs, failedJobs, dqChecks] = await Promise.all([
    pool.query(
      `
        SELECT job_type, status, priority, window_start, window_end, attempt_count,
               max_attempts, run_after, started_at, completed_at, last_error, created_at
        FROM audit.sync_jobs
        WHERE merchant_id = $1
        ORDER BY created_at DESC
        LIMIT 100
      `,
      [merchantId],
    ),
    pool.query(
      `
        SELECT job_type, status, window_start, window_end, attempt_count, max_attempts,
               last_error, updated_at
        FROM audit.sync_jobs
        WHERE merchant_id = $1
          AND status = 'failed'
        ORDER BY updated_at DESC
        LIMIT 30
      `,
      [merchantId],
    ),
    pool.query(
      `
        SELECT check_name, status, severity, details, created_at
        FROM audit.data_quality_checks
        WHERE merchant_id = $1
        ORDER BY created_at DESC
        LIMIT 50
      `,
      [merchantId],
    ),
  ]);

  return {
    recentJobs: jobs.rows,
    failedJobs: failedJobs.rows,
    dataQualityChecks: dqChecks.rows,
  };
}

async function databaseStats(pool: DbPool) {
  const allowedSchemas = new Set(["mart", "audit", "meta", "raw"]);
  const result = await pool.query<DatabaseStatsRow>(
    `
      WITH refresh AS (
        SELECT updated_at
        FROM audit.refresh_state
        WHERE key = 'materialized_views'
      )
      SELECT stats.schemaname AS schema,
             stats.relname AS table_name,
             stats.n_live_tup::bigint AS row_count,
             pg_total_relation_size(format('%I.%I', stats.schemaname, stats.relname)::regclass)::bigint AS bytes_total,
             pg_size_pretty(pg_total_relation_size(format('%I.%I', stats.schemaname, stats.relname)::regclass)) AS size_pretty,
             CASE
               WHEN matviews.matviewname IS NULL THEN NULL
               ELSE refresh.updated_at
             END AS last_refreshed_at
      FROM pg_stat_user_tables stats
      LEFT JOIN pg_matviews matviews
        ON matviews.schemaname = stats.schemaname
       AND matviews.matviewname = stats.relname
      LEFT JOIN refresh ON true
      WHERE stats.schemaname IN ('mart', 'audit', 'meta', 'raw')
      ORDER BY pg_total_relation_size(format('%I.%I', stats.schemaname, stats.relname)::regclass) DESC,
               stats.schemaname ASC,
               stats.relname ASC
    `,
  );

  const tables = result.rows
    .filter((row) => allowedSchemas.has(String(row.schema)))
    .map((row) => {
      const bytesTotal = numberValue(row.bytes_total);

      return {
        schema: String(row.schema),
        table_name: String(row.table_name),
        row_count: numberValue(row.row_count),
        bytes_total: bytesTotal,
        size_pretty: String(row.size_pretty ?? formatBytes(bytesTotal)),
        last_refreshed_at: isoOrNull(row.last_refreshed_at),
      };
    });
  const bytesTotal = tables.reduce((sum, table) => sum + table.bytes_total, 0);

  return {
    tables,
    totals: {
      table_count: tables.length,
      bytes_total: bytesTotal,
      size_pretty: formatBytes(bytesTotal),
    },
  };
}

type HistoricalBackfillRow = {
  window_start: Date | string;
  window_end: Date | string;
  status: string;
  retry_after: Date | string | null;
  blocked_at: Date | string | null;
  failure_count: number | string | null;
  last_error: string | null;
  completed_at: Date | string | null;
  updated_at: Date | string | null;
  rows_read: number | string | null;
  rows_written: number | string | null;
};

type DatabaseStatsRow = {
  schema: string;
  table_name: string;
  row_count: number | string | null;
  bytes_total: number | string | null;
  size_pretty: string | null;
  last_refreshed_at: Date | string | null;
};

function dateIso(value: Date | string) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function maxDate(values: Array<Date | string>) {
  if (values.length === 0) {
    return null;
  }
  return new Date(Math.max(...values.map((value) => new Date(value).getTime())));
}

function minDate(values: Array<Date | string>) {
  if (values.length === 0) {
    return null;
  }
  return new Date(Math.min(...values.map((value) => new Date(value).getTime())));
}

function latestErroredWindow(rows: HistoricalBackfillRow[]) {
  return (
    rows
      .filter((row) => (row.status === "failed" || row.status === "blocked") && row.last_error)
      .sort(
        (left, right) =>
          new Date(right.updated_at ?? 0).getTime() - new Date(left.updated_at ?? 0).getTime(),
      )[0] ?? null
  );
}

function historicalRowRank(row: HistoricalBackfillRow) {
  switch (row.status) {
    case "completed":
    case "warning":
      return 0;
    case "blocked":
      return 1;
    case "running":
      return 2;
    case "pending":
      return 3;
    case "failed":
      return 4;
    default:
      return 5;
  }
}

function backfillWindowConfig(config: AppConfig): AppConfig {
  return {
    ...config,
    exportWindowStartUtc: config.exportWindowStartUtc ?? "10:00",
    exportWindowEndUtc: config.exportWindowEndUtc ?? "15:00",
    exportHistoricalBackfillWindowShare: config.exportHistoricalBackfillWindowShare ?? 0.4,
  };
}

function salesDays(url: URL) {
  const value = Number(url.searchParams.get("days") ?? 30);
  return VALID_SALES_DAYS.has(value) ? value : 30;
}

function salesWindow(url: URL): SalesWindow | { error: string } {
  const hasDays = url.searchParams.has("days");
  const hasFrom = url.searchParams.has("from");
  const hasTo = url.searchParams.has("to");

  if ((hasFrom || hasTo) && hasDays) {
    return { error: "provide either days or from+to, not both" };
  }

  if (hasFrom || hasTo) {
    const from = url.searchParams.get("from") ?? "";
    const to = url.searchParams.get("to") ?? "";

    if (!isIsoBusinessDate(from) || !isIsoBusinessDate(to)) {
      return { error: "from and to must be YYYY-MM-DD" };
    }
    if (from > to) {
      return { error: "from must be <= to" };
    }
    if (rangeDays(from, to) > 365) {
      return { error: "range must be <= 365 days" };
    }

    return { mode: "range", from, to };
  }

  return { mode: "days", days: salesDays(url) };
}

function isIsoBusinessDate(value: string): boolean {
  if (!ISO_DATE_RE.test(value)) {
    return false;
  }

  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function rangeDays(from: string, to: string): number {
  const fromTime = new Date(`${from}T00:00:00.000Z`).getTime();
  const toTime = new Date(`${to}T00:00:00.000Z`).getTime();
  return Math.floor((toTime - fromTime) / MS_PER_DAY) + 1;
}

function hourlyDays(url: URL) {
  const value = Number(url.searchParams.get("days") ?? 30);
  if (!Number.isInteger(value) || value < 1 || value > 90) {
    return null;
  }
  return value;
}

function daysParam(url: URL, fallback: number, max: number) {
  const value = Number(url.searchParams.get("days") ?? fallback);
  if (!Number.isInteger(value)) {
    return fallback;
  }
  return Math.max(1, Math.min(max, value));
}

function limitParam(url: URL, fallback: number, max: number) {
  const value = Number(url.searchParams.get("limit") ?? fallback);
  if (!Number.isInteger(value)) {
    return fallback;
  }
  return Math.max(1, Math.min(max, value));
}

function respondRedirect(res: ServerResponse, location: string) {
  res.statusCode = 301;
  res.setHeader("location", location);
  res.setHeader("cache-control", "no-store");
  res.end();
}

function backofficeOpsUrl(config: AppConfig) {
  return `${config.backofficeBaseUrl.replace(/\/+$/, "")}/ops`;
}

function numberValue(value: number | string | null | undefined) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
}

function isoOrNull(value: Date | string | null | undefined) {
  if (!value) {
    return null;
  }
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function formatBytes(bytes: number) {
  if (bytes < 1024) {
    return `${bytes} bytes`;
  }
  const units = ["kB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unitIndex]}`;
}
