import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AppConfig } from "../config.js";
import type { DbPool } from "../db.js";
import { CloverClient } from "../clover/client.js";
import { sha256Buffer, sha256Text } from "../lib/hash.js";
import { asArray, asNumber, asRecord, asString } from "../lib/json.js";
import { parseExportBuffer } from "../ingest/export-parser.js";
import {
  extractOrderId,
  markExportDownloaded,
  mergeExportImportSummary,
  orderIdsNeedingDetails,
  upsertExportRecord,
  upsertRawOrders,
  upsertRawPayments
} from "../ingest/raw-repository.js";
import { DirtyWindowRepository } from "../refresh/dirty-window-repository.js";
import { JobRepository } from "../scheduler/job-repository.js";
import { SyncWindowRepository } from "../scheduler/sync-window-repository.js";
import type { CloverExportType, JsonRecord, TimeWindow } from "../types.js";
import type { SyncJob } from "../scheduler/job-repository.js";
import { asJsonRecord } from "./shared.js";

export async function runExportWindowJob(
  pool: DbPool,
  config: AppConfig,
  clover: CloverClient,
  job: SyncJob
) {
  const payload = asJsonRecord(job.payload);
  const window = {
    start: new Date(String(payload.start)),
    end: new Date(String(payload.end))
  };
  if (job.jobType !== "export_reconcile" && job.jobType !== "historical_export_backfill") {
    throw new Error(`Unsupported export window job: ${job.jobType}`);
  }

  const orders = await exportAndImport(pool, config, clover, job.merchantId, job.jobType, "ORDERS", window);
  const payments = await exportAndImport(pool, config, clover, job.merchantId, job.jobType, "PAYMENTS", window);

  await new DirtyWindowRepository(pool, config.storeTimezone).append({
    merchantId: job.merchantId,
    utcStart: window.start,
    utcEnd: window.end,
    reason: job.jobType
  });

  if (job.jobType === "export_reconcile") {
    await recordReconciliationPlaceholder(pool, job.merchantId, window.start);
    await enqueueReconciliationCheck(pool, job.merchantId, window);
  }

  return {
    rowsRead: orders.rowsRead + payments.rowsRead,
    rowsWritten: orders.rowsWritten + payments.rowsWritten,
    dirtyWindowCount: 1,
    outputTables: ["raw.clover_exports", "raw.clover_orders", "raw.clover_payments", "raw.clover_refunds", "audit.dirty_windows", "audit.sync_jobs"],
    metadata: {
      orders,
      payments
    }
  };
}

async function exportAndImport(
  pool: DbPool,
  config: AppConfig,
  clover: CloverClient,
  merchantId: string,
  jobType: "export_reconcile" | "historical_export_backfill",
  type: CloverExportType,
  window: TimeWindow
) {
  const syncWindows = new SyncWindowRepository(pool);
  const created = await clover.createExport(type, window.start, window.end);
  let exportRecord = await upsertExportRecord(pool, merchantId, type, window, created);
  await syncWindows.markStage({
    merchantId,
    windowType: jobType,
    windowStart: window.start,
    windowEnd: window.end,
    stage: `${type.toLowerCase()}_export_requested`,
    rawExportId: exportRecord.id,
    metrics: { exportId: exportRecord.exportId }
  });
  const done = await waitForExport(clover, exportRecord.exportId);
  exportRecord = await upsertExportRecord(pool, merchantId, type, window, done);
  await syncWindows.markStage({
    merchantId,
    windowType: jobType,
    windowStart: window.start,
    windowEnd: window.end,
    stage: `${type.toLowerCase()}_export_downloaded`,
    rawExportId: exportRecord.id,
    metrics: { exportId: exportRecord.exportId }
  });

  const urls = exportUrls(done);
  await mkdir(config.rawExportDir, { recursive: true });

  const allRows: JsonRecord[] = [];
  const localPaths: string[] = [];
  const hashParts: string[] = [];
  let byteSize = 0;

  for (const [index, url] of urls.entries()) {
    const buffer = await clover.downloadExportUrl(url);
    const rows = parseExportBuffer(buffer);
    allRows.push(...rows);
    byteSize += buffer.byteLength;
    hashParts.push(sha256Buffer(buffer));

    const filename = `${merchantId}_${type}_${window.start.toISOString().slice(0, 10)}_${index + 1}.export`;
    const localPath = join(config.rawExportDir, filename);
    await writeFile(localPath, buffer);
    localPaths.push(localPath);
  }

  await markExportDownloaded(
    pool,
    exportRecord.id,
    localPaths,
    sha256Text(hashParts.join(":")),
    byteSize,
    allRows.length
  );

  if (type === "ORDERS") {
    const rowsWritten = await upsertRawOrders(pool, merchantId, allRows, {
      source: "export",
      rawExportId: exportRecord.id,
      window
    });
    const hydrationJobCount = await enqueueOrderDetailHydrationJobs(pool, merchantId, exportRecord.id, window, allRows);
    await syncWindows.markStage({
      merchantId,
      windowType: jobType,
      windowStart: window.start,
      windowEnd: window.end,
      stage: "orders_raw_imported",
      rawExportId: exportRecord.id,
      metrics: { rowsRead: allRows.length, rowsWritten, hydrationJobCount }
    });
    return { rowsRead: allRows.length, rowsWritten, hydrationJobCount };
  }

  const result = await upsertRawPayments(pool, merchantId, allRows, {
    source: "export",
    rawExportId: exportRecord.id,
    window
  });
  await mergeExportImportSummary(pool, exportRecord.id, {
    paymentsExportRows: allRows.length,
    completedAt: new Date().toISOString()
  });
  await syncWindows.markStage({
    merchantId,
    windowType: jobType,
    windowStart: window.start,
    windowEnd: window.end,
    stage: "payments_raw_imported",
    rawExportId: exportRecord.id,
    metrics: { rowsRead: allRows.length, rowsWritten: result.paymentCount + result.refundCount }
  });
  return { rowsRead: allRows.length, rowsWritten: result.paymentCount + result.refundCount };
}

async function waitForExport(clover: CloverClient, exportId: string) {
  // Clover documents exactly three export statuses: PENDING, IN_PROGRESS, DONE
  // (https://docs.clover.com/dev/docs/exporting-merchant-data). There is no
  // FAILED/ERROR. So treat DONE as success, PENDING/IN_PROGRESS as keep-polling,
  // and ANY other/empty status as a (retryable) failure surfaced immediately —
  // rather than silently polling to the 120-attempt timeout. "temporary"/"timed
  // out" keep classifyBackfillError on the retryable path so the window parks for
  // an automatic retry instead of being permanently blocked.
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const payload = await clover.getExport(exportId);
    const status = asString(payload.status);
    if (status === "DONE") {
      return payload;
    }
    if (status !== "PENDING" && status !== "IN_PROGRESS") {
      throw new Error(`Clover export ${exportId} returned unexpected status ${status ?? "<none>"} (temporary).`);
    }
    const percent = asNumber(payload.percentComplete);
    const waitMs = percent !== null && percent > 80 ? 5_000 : 15_000;
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
  throw new Error(`Timed out waiting for Clover export ${exportId}.`);
}

function exportUrls(payload: JsonRecord) {
  const rows = asArray(asRecord(payload.exportUrls).elements).map(asRecord);
  return rows.map((row) => asString(row.url)).filter((url): url is string => Boolean(url));
}

export async function recordReconciliationPlaceholder(pool: DbPool, merchantId: string, start: Date) {
  await pool.query(
    `
      INSERT INTO audit.reconciliation_results (merchant_id, business_date, status, details)
      VALUES ($1, $2, 'imported', '{"note":"Export imported; awaiting metric comparison."}'::jsonb)
    `,
    [merchantId, start.toISOString().slice(0, 10)]
  );
}

async function enqueueReconciliationCheck(pool: DbPool, merchantId: string, window: TimeWindow) {
  const jobs = new JobRepository(pool);
  await jobs.enqueueOnce({
    jobType: "reconciliation_check",
    merchantId,
    windowStart: window.start,
    windowEnd: window.end,
    dedupeKey: `${merchantId}:reconciliation_check:${window.start.toISOString()}:${window.end.toISOString()}`,
    runAfter: new Date(Date.now() + 5 * 60_000),
    payload: {
      start: window.start.toISOString(),
      end: window.end.toISOString(),
      reason: "export_reconcile"
    }
  });
}

async function enqueueOrderDetailHydrationJobs(
  pool: DbPool,
  merchantId: string,
  rawExportId: string,
  window: TimeWindow,
  rows: JsonRecord[]
) {
  const orderIds = [...new Set(rows.map(extractOrderId).filter((value): value is string => Boolean(value)))];
  const candidates = await orderIdsNeedingDetails(pool, merchantId, orderIds);
  const jobs = new JobRepository(pool);
  const batches = chunk(candidates, 50);

  for (const [index, orderIdsBatch] of batches.entries()) {
    await jobs.enqueueOnce({
      jobType: "order_detail_hydration",
      merchantId,
      windowStart: window.start,
      windowEnd: window.end,
      dedupeKey: `${merchantId}:order_detail_hydration:${rawExportId}:${index}`,
      payload: {
        orderIds: orderIdsBatch,
        rawExportId,
        start: window.start.toISOString(),
        end: window.end.toISOString(),
        reason: "export_order_detail_hydration"
      }
    });
  }

  await mergeExportImportSummary(pool, rawExportId, {
    ordersExportRows: rows.length,
    orderDetailHydrationQueued: candidates.length,
    orderDetailHydrationJobCount: batches.length,
    detailHydrationMode: candidates.length > 0 ? "queued" : "not_needed",
    queuedAt: new Date().toISOString()
  });

  return batches.length;
}

function chunk<T>(rows: T[], size: number) {
  const chunks: T[][] = [];
  for (let index = 0; index < rows.length; index += size) {
    chunks.push(rows.slice(index, index + size));
  }
  return chunks;
}
