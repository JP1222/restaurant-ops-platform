import type { AppConfig } from "../config.js";
import type { DbPool } from "../db.js";
import { CloverClient } from "../clover/client.js";
import { createLogger, errorMessage } from "../lib/log.js";
import {
  mergeExportImportSummary,
  upsertRawOrders
} from "../ingest/raw-repository.js";

const log = createLogger("jobs.order-detail-hydration");
import { DirtyWindowRepository } from "../refresh/dirty-window-repository.js";
import type { SyncJob } from "../scheduler/job-repository.js";
import { SyncWindowRepository } from "../scheduler/sync-window-repository.js";
import { asJsonRecord } from "./shared.js";

export async function runOrderDetailHydrationJob(
  pool: DbPool,
  config: AppConfig,
  clover: CloverClient,
  job: SyncJob
) {
  const payload = asJsonRecord(job.payload);
  const orderIds = Array.isArray(payload.orderIds)
    ? payload.orderIds.filter((value): value is string => typeof value === "string" && value.length > 0)
    : [];
  const rawExportId = typeof payload.rawExportId === "string" ? payload.rawExportId : undefined;
  const start = new Date(String(payload.start));
  const end = new Date(String(payload.end));

  let rowsWritten = 0;
  let succeeded = 0;
  const failedOrderIds: string[] = [];

  for (const orderId of orderIds) {
    try {
      const detail = await clover.fetchOrderWithDetails(orderId);
      rowsWritten += await upsertRawOrders(pool, job.merchantId, [detail], {
        source: "rest_detail",
        rawExportId,
        window: { start, end }
      });
      succeeded += 1;
    } catch (error) {
      failedOrderIds.push(orderId);
      log.warn(`Unable to hydrate order detail for ${orderId}: ${errorMessage(error)}`, { orderId });
    }
  }

  if (rawExportId) {
    await mergeExportImportSummary(pool, rawExportId, {
      orderDetailSucceeded: succeeded,
      orderDetailFailed: failedOrderIds.length,
      failedOrderIdsSample: failedOrderIds,
      detailHydrationMode: "queued",
      lastHydratedAt: new Date().toISOString()
    });
  }

  await new SyncWindowRepository(pool).markStage({
    merchantId: job.merchantId,
    windowType: "order_detail_hydration",
    windowStart: start,
    windowEnd: end,
    stage: failedOrderIds.length > 0 ? "detail_hydrated_with_warnings" : "detail_hydrated",
    status: failedOrderIds.length > 0 ? "warning" : "completed",
    rawExportId,
    metrics: {
      orderDetailSucceeded: succeeded,
      orderDetailFailed: failedOrderIds.length,
      failedOrderIdsSample: failedOrderIds.slice(0, 20)
    }
  });

  if (rowsWritten > 0) {
    await new DirtyWindowRepository(pool, config.storeTimezone).append({
      merchantId: job.merchantId,
      utcStart: start,
      utcEnd: end,
      reason: "order_detail_hydration",
      priority: 40
    });
  }

  if (succeeded === 0 && failedOrderIds.length > 0) {
    throw new Error(`Order detail hydration failed for ${failedOrderIds.length} order(s).`);
  }

  return {
    rowsRead: orderIds.length,
    rowsWritten,
    dirtyWindowCount: rowsWritten > 0 ? 1 : 0,
    outputTables: ["raw.clover_orders", "audit.dirty_windows", "raw.clover_exports"],
    metadata: {
      orderDetailSucceeded: succeeded,
      orderDetailFailed: failedOrderIds.length,
      failedOrderIdsSample: failedOrderIds.slice(0, 20)
    },
    warning: failedOrderIds.length > 0
  };
}
