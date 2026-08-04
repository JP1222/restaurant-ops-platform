import type { DbPool } from "../db.js";
import { withTransaction } from "../db.js";
import { asArray, asNumber, asRecord, asString } from "../lib/json.js";
import { sanitizeCloverPayload } from "../lib/sanitize.js";
import { parseCloverTimestamp } from "../lib/time.js";
import type { CloverExportType, JsonRecord, TimeWindow } from "../types.js";

export type RawExportRecord = {
  id: string;
  exportId: string;
};

export async function upsertExportRecord(
  pool: DbPool,
  merchantId: string,
  type: CloverExportType,
  window: TimeWindow,
  payload: JsonRecord
): Promise<RawExportRecord> {
  const exportId = asString(payload.id);
  if (!exportId) {
    throw new Error(`Clover ${type} export response did not include an id.`);
  }

  const status = asString(payload.status) ?? "UNKNOWN";
  const percentComplete = asNumber(payload.percentComplete);
  const availableUntil = parseCloverTimestamp(payload.availableUntil);
  const exportUrls = asArray(asRecord(payload.exportUrls).elements).map((entry) => {
    const record = asRecord(entry);
    const url = asString(record.url);
    return url ? { ...record, url: redactUrlForStorage(url) } : record;
  });

  const result = await pool.query<{ id: string; export_id: string }>(
    `
      INSERT INTO raw.clover_exports (
        merchant_id, export_id, export_type, window_start, window_end, status,
        percent_complete, available_until, export_urls, raw_export, updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, now())
      ON CONFLICT (merchant_id, export_id) DO UPDATE SET
        status = EXCLUDED.status,
        percent_complete = EXCLUDED.percent_complete,
        available_until = EXCLUDED.available_until,
        export_urls = EXCLUDED.export_urls,
        raw_export = EXCLUDED.raw_export,
        updated_at = now()
      RETURNING id, export_id
    `,
    [
      merchantId,
      exportId,
      type,
      window.start,
      window.end,
      status,
      percentComplete,
      availableUntil,
      JSON.stringify(exportUrls),
      JSON.stringify(sanitizeCloverPayload(payload))
    ]
  );

  const row = result.rows[0];
  if (!row) {
    throw new Error("Unable to persist Clover export metadata.");
  }

  return {
    id: row.id,
    exportId: row.export_id
  };
}

export async function markExportDownloaded(
  pool: DbPool,
  exportRecordId: string,
  localPaths: string[],
  sha256: string,
  byteSize: number,
  rowCount: number
) {
  await pool.query(
    `
      UPDATE raw.clover_exports
      SET local_paths = $2::jsonb,
          sha256 = $3,
          byte_size = $4,
          row_count = $5,
          updated_at = now()
      WHERE id = $1
    `,
    [exportRecordId, JSON.stringify(localPaths), sha256, byteSize, rowCount]
  );
}

export async function mergeExportImportSummary(
  pool: DbPool,
  exportRecordId: string,
  patch: JsonRecord
) {
  return withTransaction(pool, async (client) => {
    const result = await client.query<{ import_summary: JsonRecord }>(
      "SELECT import_summary FROM raw.clover_exports WHERE id = $1 FOR UPDATE",
      [exportRecordId]
    );
    const current = asRecord(result.rows[0]?.import_summary);
    const merged = mergeImportSummary(current, patch);
    await client.query(
      `
        UPDATE raw.clover_exports
        SET import_summary = $2::jsonb,
            updated_at = now()
        WHERE id = $1
      `,
      [exportRecordId, JSON.stringify(merged)]
    );
    return merged;
  });
}

export async function orderIdsNeedingDetails(
  pool: DbPool,
  merchantId: string,
  orderIds: string[]
) {
  if (orderIds.length === 0) {
    return [];
  }
  const result = await pool.query<{ order_id: string }>(
    `
      SELECT order_id
      FROM raw.clover_orders
      WHERE merchant_id = $1
        AND order_id = ANY($2::text[])
        AND source_priority < $3
      ORDER BY created_time_utc NULLS LAST, order_id
    `,
    [merchantId, orderIds, sourcePriority("rest_detail")]
  );
  return result.rows.map((row) => row.order_id);
}

export async function upsertRawOrders(
  pool: DbPool,
  merchantId: string,
  rows: JsonRecord[],
  options: { source: string; rawExportId?: string; window?: TimeWindow }
) {
  return withTransaction(pool, async (client) => {
    let count = 0;
    for (const rawRow of rows) {
      const row = sanitizeCloverPayload(rawRow);
      const orderId = extractOrderId(row);
      if (!orderId) {
        continue;
      }
      const detailScore = scoreOrderPayload(row);
      const priority = sourcePriority(options.source);
      const lastDetailFetchAt = isDetailSource(options.source) ? new Date() : null;
      await client.query(
        `
          INSERT INTO raw.clover_orders (
            merchant_id, order_id, payload, source, raw_export_id, window_start, window_end,
            created_time_utc, modified_time_utc, detail_score, detail_source, source_priority,
            last_detail_fetch_at, imported_at
          )
          VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, now())
          ON CONFLICT (merchant_id, order_id) DO UPDATE SET
            payload = CASE
              WHEN (
                EXCLUDED.detail_score > raw.clover_orders.detail_score
                OR (
                  EXCLUDED.detail_score = raw.clover_orders.detail_score
                  AND (
                    EXCLUDED.source_priority > raw.clover_orders.source_priority
                    OR (
                      EXCLUDED.source_priority = raw.clover_orders.source_priority
                      AND COALESCE(EXCLUDED.modified_time_utc, EXCLUDED.created_time_utc, '-infinity'::timestamptz)
                        >= COALESCE(raw.clover_orders.modified_time_utc, raw.clover_orders.created_time_utc, '-infinity'::timestamptz)
                    )
                  )
                )
              ) THEN EXCLUDED.payload
              ELSE raw.clover_orders.payload
            END,
            source = EXCLUDED.source,
            raw_export_id = COALESCE(EXCLUDED.raw_export_id, raw.clover_orders.raw_export_id),
            window_start = COALESCE(EXCLUDED.window_start, raw.clover_orders.window_start),
            window_end = COALESCE(EXCLUDED.window_end, raw.clover_orders.window_end),
            created_time_utc = COALESCE(EXCLUDED.created_time_utc, raw.clover_orders.created_time_utc),
            modified_time_utc = COALESCE(EXCLUDED.modified_time_utc, raw.clover_orders.modified_time_utc),
            detail_score = GREATEST(EXCLUDED.detail_score, raw.clover_orders.detail_score),
            detail_source = CASE
              WHEN (
                EXCLUDED.detail_score > raw.clover_orders.detail_score
                OR (
                  EXCLUDED.detail_score = raw.clover_orders.detail_score
                  AND (
                    EXCLUDED.source_priority > raw.clover_orders.source_priority
                    OR (
                      EXCLUDED.source_priority = raw.clover_orders.source_priority
                      AND COALESCE(EXCLUDED.modified_time_utc, EXCLUDED.created_time_utc, '-infinity'::timestamptz)
                        >= COALESCE(raw.clover_orders.modified_time_utc, raw.clover_orders.created_time_utc, '-infinity'::timestamptz)
                    )
                  )
                )
              ) THEN EXCLUDED.detail_source
              ELSE raw.clover_orders.detail_source
            END,
            source_priority = CASE
              WHEN (
                EXCLUDED.detail_score > raw.clover_orders.detail_score
                OR (
                  EXCLUDED.detail_score = raw.clover_orders.detail_score
                  AND (
                    EXCLUDED.source_priority > raw.clover_orders.source_priority
                    OR (
                      EXCLUDED.source_priority = raw.clover_orders.source_priority
                      AND COALESCE(EXCLUDED.modified_time_utc, EXCLUDED.created_time_utc, '-infinity'::timestamptz)
                        >= COALESCE(raw.clover_orders.modified_time_utc, raw.clover_orders.created_time_utc, '-infinity'::timestamptz)
                    )
                  )
                )
              ) THEN EXCLUDED.source_priority
              ELSE raw.clover_orders.source_priority
            END,
            last_detail_fetch_at = CASE
              WHEN (
                EXCLUDED.detail_score > raw.clover_orders.detail_score
                OR (
                  EXCLUDED.detail_score = raw.clover_orders.detail_score
                  AND (
                    EXCLUDED.source_priority > raw.clover_orders.source_priority
                    OR (
                      EXCLUDED.source_priority = raw.clover_orders.source_priority
                      AND COALESCE(EXCLUDED.modified_time_utc, EXCLUDED.created_time_utc, '-infinity'::timestamptz)
                        >= COALESCE(raw.clover_orders.modified_time_utc, raw.clover_orders.created_time_utc, '-infinity'::timestamptz)
                    )
                  )
                )
              ) THEN COALESCE(EXCLUDED.last_detail_fetch_at, raw.clover_orders.last_detail_fetch_at)
              ELSE raw.clover_orders.last_detail_fetch_at
            END,
            imported_at = now()
        `,
        [
          merchantId,
          orderId,
          JSON.stringify(row),
          options.source,
          options.rawExportId ?? null,
          options.window?.start ?? null,
          options.window?.end ?? null,
          extractCreatedTime(row),
          extractModifiedTime(row),
          detailScore,
          options.source,
          priority,
          lastDetailFetchAt
        ]
      );
      count += 1;
    }
    return count;
  });
}

export async function upsertRawPayments(
  pool: DbPool,
  merchantId: string,
  rows: JsonRecord[],
  options: { source: string; rawExportId?: string; window?: TimeWindow }
) {
  return withTransaction(pool, async (client) => {
    let paymentCount = 0;
    let refundCount = 0;
    for (const rawRow of rows) {
      const row = sanitizeCloverPayload(rawRow);
      const paymentId = extractPaymentId(row);
      if (!paymentId) {
        continue;
      }

      await client.query(
        `
          INSERT INTO raw.clover_payments (
            merchant_id, payment_id, payload, source, raw_export_id, window_start, window_end,
            created_time_utc, imported_at
          )
          VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7, $8, now())
          ON CONFLICT (merchant_id, payment_id) DO UPDATE SET
            payload = EXCLUDED.payload,
            source = EXCLUDED.source,
            raw_export_id = COALESCE(EXCLUDED.raw_export_id, raw.clover_payments.raw_export_id),
            window_start = COALESCE(EXCLUDED.window_start, raw.clover_payments.window_start),
            window_end = COALESCE(EXCLUDED.window_end, raw.clover_payments.window_end),
            created_time_utc = COALESCE(EXCLUDED.created_time_utc, raw.clover_payments.created_time_utc),
            imported_at = now()
        `,
        [
          merchantId,
          paymentId,
          JSON.stringify(row),
          options.source,
          options.rawExportId ?? null,
          options.window?.start ?? null,
          options.window?.end ?? null,
          extractCreatedTime(row)
        ]
      );
      paymentCount += 1;

      const refunds = extractRefundsFromPayment(row, paymentId);
      for (const refund of refunds) {
        await upsertRefundWithClient(client, merchantId, refund, "payment_ref", paymentId);
        refundCount += 1;
      }
    }
    return { paymentCount, refundCount };
  });
}

export async function upsertRawRefunds(
  pool: DbPool,
  merchantId: string,
  rows: JsonRecord[],
  source = "rest"
) {
  return withTransaction(pool, async (client) => {
    let count = 0;
    for (const row of rows) {
      const inserted = await upsertRefundWithClient(client, merchantId, sanitizeCloverPayload(row), source);
      if (inserted) {
        count += 1;
      }
    }
    return count;
  });
}

export async function upsertRawDimension(
  pool: DbPool,
  table: "clover_tenders" | "clover_employees" | "clover_order_types",
  merchantId: string,
  rows: JsonRecord[]
) {
  const idColumn = table === "clover_tenders"
    ? "tender_id"
    : table === "clover_employees"
      ? "employee_id"
      : "order_type_id";

  return withTransaction(pool, async (client) => {
    let count = 0;
    for (const rawRow of rows) {
      const row = sanitizeCloverPayload(rawRow);
      const id = asString(row.id);
      if (!id) {
        continue;
      }

      await client.query(
        `
          INSERT INTO raw.${table} (merchant_id, ${idColumn}, payload, imported_at)
          VALUES ($1, $2, $3::jsonb, now())
          ON CONFLICT (merchant_id, ${idColumn}) DO UPDATE SET
            payload = EXCLUDED.payload,
            imported_at = now()
        `,
        [merchantId, id, JSON.stringify(row)]
      );
      count += 1;
    }
    return count;
  });
}

async function upsertRefundWithClient(
  client: { query: (sql: string, values?: unknown[]) => Promise<unknown> },
  merchantId: string,
  row: JsonRecord,
  source: string,
  fallbackPaymentId?: string
) {
  const refundId = extractRefundId(row);
  if (!refundId) {
    return false;
  }

  const paymentId = asString(asRecord(row.payment).id) ?? asString(row.paymentId) ?? fallbackPaymentId ?? null;
  const orderId = asString(asRecord(row.order).id) ?? asString(row.orderId) ?? null;

  await client.query(
    `
      INSERT INTO raw.clover_refunds (
        merchant_id, refund_id, payment_id, order_id, payload, source, created_time_utc, imported_at
      )
      VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, now())
      ON CONFLICT (merchant_id, refund_id) DO UPDATE SET
        payment_id = COALESCE(EXCLUDED.payment_id, raw.clover_refunds.payment_id),
        order_id = COALESCE(EXCLUDED.order_id, raw.clover_refunds.order_id),
        payload = EXCLUDED.payload,
        source = EXCLUDED.source,
        created_time_utc = COALESCE(EXCLUDED.created_time_utc, raw.clover_refunds.created_time_utc),
        imported_at = now()
    `,
    [
      merchantId,
      refundId,
      paymentId,
      orderId,
      JSON.stringify(row),
      source,
      extractCreatedTime(row)
    ]
  );
  return true;
}

export function extractOrderId(row: JsonRecord) {
  return asString(row.id) ?? asString(row.orderId) ?? asString(asRecord(row.order).id);
}

export function extractPaymentId(row: JsonRecord) {
  return asString(row.id) ?? asString(row.paymentId);
}

export function extractRefundId(row: JsonRecord) {
  return asString(row.id) ?? asString(row.refundId);
}

export function extractCreatedTime(row: JsonRecord) {
  return parseCloverTimestamp(row.createdTime ?? row.clientCreatedTime ?? row.created_at ?? row.created);
}

export function extractModifiedTime(row: JsonRecord) {
  return parseCloverTimestamp(row.modifiedTime ?? row.updatedTime ?? row.clientCreatedTime ?? row.createdTime);
}

export function scoreOrderPayload(row: JsonRecord) {
  const lineItems = asArray(row.lineItems).filter(isRecord);
  const hasLineItems = lineItems.length > 0;
  const hasModifiers = lineItems.some((lineItem) => asArray(lineItem.modifications).length > 0);
  const hasAlternateName = lineItems.some((lineItem) => {
    const item = asRecord(lineItem.item);
    return Boolean(asString(lineItem.alternateName) ?? asString(item.alternateName));
  });
  const hasOrderType = Boolean(asString(asRecord(row.orderType).id) ?? asString(row.orderTypeId));
  return [hasLineItems, hasModifiers, hasAlternateName, hasOrderType].filter(Boolean).length;
}

export function sourcePriority(source: string) {
  switch (source) {
    case "webhook":
      return 90;
    case "rest_detail":
      return 80;
    case "hourly_rest_sweep":
    case "mini_rest_sweep":
    case "repair_window":
      return 70;
    case "export":
      return 10;
    default:
      return 0;
  }
}

function isDetailSource(source: string) {
  return sourcePriority(source) >= sourcePriority("hourly_rest_sweep");
}

function extractRefundsFromPayment(payment: JsonRecord, paymentId: string): JsonRecord[] {
  return asArray(payment.refunds).filter(isRecord).map((refund) => ({
    ...refund,
    paymentId: asString(asRecord(refund.payment).id) ?? paymentId,
    orderId: asString(asRecord(payment.order).id) ?? asString(payment.orderId)
  }));
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function redactUrlForStorage(value: string) {
  try {
    const url = new URL(value);
    url.search = "";
    return url.toString();
  } catch {
    return value.split("?")[0] ?? value;
  }
}

function mergeImportSummary(current: JsonRecord, patch: JsonRecord): JsonRecord {
  const merged: JsonRecord = { ...current, ...patch };
  for (const key of ["orderDetailSucceeded", "orderDetailFailed", "ordersExportRows", "paymentsExportRows"]) {
    if (patch[key] !== undefined) {
      merged[key] = Math.trunc(asNumber(current[key]) ?? 0) + Math.trunc(asNumber(patch[key]) ?? 0);
    }
  }
  const oldFailed = asArray(current.failedOrderIdsSample).map(String);
  const newFailed = asArray(patch.failedOrderIdsSample).map(String);
  if (oldFailed.length > 0 || newFailed.length > 0) {
    merged.failedOrderIdsSample = [...new Set([...oldFailed, ...newFailed])].slice(0, 20);
  }
  return merged;
}
