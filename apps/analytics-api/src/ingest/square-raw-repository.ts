import type { DbPool } from "../db.js";
import { withTransaction } from "../db.js";
import type { JsonRecord } from "../types.js";

// Square ingest landing repository (Phase 4). Mirrors raw-repository.ts (Clover)
// but DELIBERATELY simpler: Square has one full-detail REST source, so there's no
// detail_score / source_priority / raw_export_id machinery — the latest fetch
// always wins (payload = EXCLUDED.payload). `source` is always 'rest'. Payloads
// arrive already JSON-safe (the SquareClient deep-coerces bigint money → number),
// and field names are the SDK's camelCase (id / createdAt / updatedAt / orderId /
// paymentId), the same shape normalize-square reads in PR-D.

const SOURCE = "rest" as const;

export interface SquareIngestWindow {
  start: Date;
  end: Date;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asRecord(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : null;
}

// Square timestamps are ISO-8601 strings; pg coerces them to timestamptz. null
// when absent.
function isoOrNull(value: unknown): string | null {
  return asString(value);
}

export async function upsertSquareOrders(
  pool: DbPool,
  merchantId: string,
  rows: JsonRecord[],
  window: SquareIngestWindow
): Promise<number> {
  return withTransaction(pool, async (client) => {
    let count = 0;
    for (const row of rows) {
      const orderId = asString(row.id);
      if (!orderId) {
        continue;
      }
      await client.query(
        `
          INSERT INTO raw.square_orders (
            merchant_id, order_id, payload, source, window_start, window_end,
            created_time_utc, modified_time_utc, imported_at
          )
          VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7, $8, now())
          ON CONFLICT (merchant_id, order_id) DO UPDATE SET
            payload = EXCLUDED.payload,
            source = EXCLUDED.source,
            window_start = COALESCE(EXCLUDED.window_start, raw.square_orders.window_start),
            window_end = COALESCE(EXCLUDED.window_end, raw.square_orders.window_end),
            created_time_utc = COALESCE(EXCLUDED.created_time_utc, raw.square_orders.created_time_utc),
            modified_time_utc = COALESCE(EXCLUDED.modified_time_utc, raw.square_orders.modified_time_utc),
            imported_at = now()
        `,
        [
          merchantId,
          orderId,
          JSON.stringify(row),
          SOURCE,
          window.start,
          window.end,
          isoOrNull(row.createdAt),
          isoOrNull(row.updatedAt),
        ]
      );
      count += 1;
    }
    return count;
  });
}

export async function upsertSquarePayments(
  pool: DbPool,
  merchantId: string,
  rows: JsonRecord[],
  window: SquareIngestWindow
): Promise<number> {
  return withTransaction(pool, async (client) => {
    let count = 0;
    for (const row of rows) {
      const paymentId = asString(row.id);
      if (!paymentId) {
        continue;
      }
      await client.query(
        `
          INSERT INTO raw.square_payments (
            merchant_id, payment_id, order_id, payload, source, window_start, window_end,
            created_time_utc, imported_at
          )
          VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, now())
          ON CONFLICT (merchant_id, payment_id) DO UPDATE SET
            order_id = COALESCE(EXCLUDED.order_id, raw.square_payments.order_id),
            payload = EXCLUDED.payload,
            source = EXCLUDED.source,
            window_start = COALESCE(EXCLUDED.window_start, raw.square_payments.window_start),
            window_end = COALESCE(EXCLUDED.window_end, raw.square_payments.window_end),
            created_time_utc = COALESCE(EXCLUDED.created_time_utc, raw.square_payments.created_time_utc),
            imported_at = now()
        `,
        [
          merchantId,
          paymentId,
          asString(row.orderId),
          JSON.stringify(row),
          SOURCE,
          window.start,
          window.end,
          isoOrNull(row.createdAt),
        ]
      );
      count += 1;
    }
    return count;
  });
}

export async function upsertSquareRefunds(
  pool: DbPool,
  merchantId: string,
  rows: JsonRecord[]
): Promise<number> {
  return withTransaction(pool, async (client) => {
    let count = 0;
    for (const row of rows) {
      const refundId = asString(row.id);
      if (!refundId) {
        continue;
      }
      await client.query(
        `
          INSERT INTO raw.square_refunds (
            merchant_id, refund_id, payment_id, order_id, payload, source, created_time_utc, imported_at
          )
          VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, now())
          ON CONFLICT (merchant_id, refund_id) DO UPDATE SET
            payment_id = COALESCE(EXCLUDED.payment_id, raw.square_refunds.payment_id),
            order_id = COALESCE(EXCLUDED.order_id, raw.square_refunds.order_id),
            payload = EXCLUDED.payload,
            source = EXCLUDED.source,
            created_time_utc = COALESCE(EXCLUDED.created_time_utc, raw.square_refunds.created_time_utc),
            imported_at = now()
        `,
        [
          merchantId,
          refundId,
          asString(row.paymentId),
          asString(row.orderId) ?? asString(asRecord(row.order)?.id),
          JSON.stringify(row),
          SOURCE,
          isoOrNull(row.createdAt),
        ]
      );
      count += 1;
    }
    return count;
  });
}
