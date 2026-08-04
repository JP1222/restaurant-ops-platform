import type { AppConfig } from "../config.js";
import type { DbPool } from "../db.js";
import { CloverClient } from "../clover/client.js";
import {
  upsertRawDimension,
  upsertRawOrders,
  upsertRawPayments,
  upsertRawRefunds
} from "../ingest/raw-repository.js";
import { DirtyWindowRepository } from "../refresh/dirty-window-repository.js";
import { refreshMartDimensions } from "../transform/mart-loader.js";
import type { JsonRecord } from "../types.js";

export type JobMetrics = {
  rowsRead?: number;
  rowsWritten?: number;
  dirtyWindowCount?: number;
  outputTables?: string[];
  metadata?: JsonRecord;
  warning?: boolean;
};

export async function syncRestWindow(
  pool: DbPool,
  config: AppConfig,
  clover: CloverClient,
  merchantId: string,
  start: Date,
  end: Date,
  reason: string
): Promise<JobMetrics> {
  const [orders, payments] = await Promise.all([
    clover.listOrdersForWindow(start, end),
    clover.listPaymentsForWindow(start, end)
  ]);
  const orderCount = await upsertRawOrders(pool, merchantId, orders, {
    source: reason,
    window: { start, end }
  });
  const paymentResult = await upsertRawPayments(pool, merchantId, payments, {
    source: reason,
    window: { start, end }
  });

  await new DirtyWindowRepository(pool, config.storeTimezone).append({
    merchantId,
    utcStart: start,
    utcEnd: end,
    reason
  });

  return {
    rowsRead: orders.length + payments.length,
    rowsWritten: orderCount + paymentResult.paymentCount + paymentResult.refundCount,
    dirtyWindowCount: 1,
    outputTables: ["raw.clover_orders", "raw.clover_payments", "raw.clover_refunds", "audit.dirty_windows"],
    metadata: {
      orderCount,
      paymentCount: paymentResult.paymentCount,
      refundCount: paymentResult.refundCount
    }
  };
}

export async function fetchOrderByWebhook(
  pool: DbPool,
  config: AppConfig,
  clover: CloverClient,
  merchantId: string,
  orderId: string,
  eventTs?: Date
): Promise<JobMetrics> {
  const order = await clover.fetchOrderWithDetails(orderId);
  const now = new Date();
  const start = eventTs ?? now;
  const count = await upsertRawOrders(pool, merchantId, [order], {
    source: "webhook",
    window: { start, end: now }
  });
  await new DirtyWindowRepository(pool, config.storeTimezone).append({
    merchantId,
    utcStart: start,
    utcEnd: now,
    reason: "webhook_fetch_order",
    priority: 10
  });
  return {
    rowsRead: 1,
    rowsWritten: count,
    dirtyWindowCount: 1,
    outputTables: ["raw.clover_orders", "audit.dirty_windows"]
  };
}

export async function fetchPaymentByWebhook(
  pool: DbPool,
  config: AppConfig,
  clover: CloverClient,
  merchantId: string,
  paymentId: string,
  eventTs?: Date
): Promise<JobMetrics> {
  const payment = await clover.fetchPaymentWithDetails(paymentId);
  const now = new Date();
  const start = eventTs ?? now;
  const result = await upsertRawPayments(pool, merchantId, [payment], {
    source: "webhook",
    window: { start, end: now }
  });
  await new DirtyWindowRepository(pool, config.storeTimezone).append({
    merchantId,
    utcStart: start,
    utcEnd: now,
    reason: "webhook_fetch_payment",
    priority: 10
  });
  return {
    rowsRead: 1,
    rowsWritten: result.paymentCount + result.refundCount,
    dirtyWindowCount: 1,
    outputTables: ["raw.clover_payments", "raw.clover_refunds", "audit.dirty_windows"]
  };
}

export async function refreshReferenceData(
  pool: DbPool,
  clover: CloverClient,
  merchantId: string,
  resource: "employees" | "tenders" | "order_types" | "all"
): Promise<JobMetrics> {
  let rowsRead = 0;
  let rowsWritten = 0;

  if (resource === "all" || resource === "tenders") {
    const tenders = await clover.listV3Collection(`/v3/merchants/${merchantId}/tenders`);
    rowsRead += tenders.length;
    rowsWritten += await upsertRawDimension(pool, "clover_tenders", merchantId, tenders);
  }
  if (resource === "all" || resource === "employees") {
    const employees = await clover.listV3Collection(`/v3/merchants/${merchantId}/employees`);
    rowsRead += employees.length;
    rowsWritten += await upsertRawDimension(pool, "clover_employees", merchantId, employees);
  }
  if (resource === "all" || resource === "order_types") {
    const orderTypes = await clover.listV3Collection(`/v3/merchants/${merchantId}/order_types`);
    rowsRead += orderTypes.length;
    rowsWritten += await upsertRawDimension(pool, "clover_order_types", merchantId, orderTypes);
  }

  const refunds = await clover.tryListV1Refunds();
  if (refunds.length > 0) {
    rowsRead += refunds.length;
    rowsWritten += await upsertRawRefunds(pool, merchantId, refunds, "rest_v1");
  }

  await refreshMartDimensions(pool, merchantId);

  return {
    rowsRead,
    rowsWritten,
    dirtyWindowCount: 0,
    outputTables: ["raw.clover_tenders", "raw.clover_employees", "raw.clover_order_types", "raw.clover_refunds", "mart.dim_tender", "mart.dim_employee", "mart.dim_order_type"]
  };
}

export function parseEventTs(value: unknown) {
  if (typeof value !== "string") {
    return undefined;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

export function asJsonRecord(value: unknown): JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as JsonRecord
    : {};
}
