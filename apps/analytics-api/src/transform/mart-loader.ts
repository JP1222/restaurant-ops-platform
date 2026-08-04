import type { DbPool } from "../db.js";
import { withTransaction } from "../db.js";
import { DateTime } from "luxon";
import { sha256Text } from "../lib/hash.js";
import { asRecord, asString } from "../lib/json.js";
import type { JsonRecord, TenderType } from "../types.js";
import {
  cents,
  dateDimensionRows,
  normalizeEmployee,
  normalizeOrder,
  normalizeOrderType,
  normalizePayment,
  normalizeRefund,
  normalizeTender,
  type NormalizedOrder,
  type NormalizedPayment,
  type NormalizedRefund
} from "./normalize.js";
import {
  normalizeSquareOrder,
  normalizeSquarePayment,
  normalizeSquareRefund
} from "./normalize-square.js";

type RefreshOptions = {
  merchantId: string;
  start: Date;
  end: Date;
  timezone: string;
  // Which raw.* source + normalizer to use (ADR-0019). Defaulted to "clover" by
  // the worker for legacy/unset targets so existing behavior is unchanged.
  provider: string;
};

export async function refreshMartForRange(pool: DbPool, options: RefreshOptions) {
  await ensureMonthlyPartitions(pool, options.start, options.end);
  await withTransaction(pool, async (client) => {
    await loadCalendar(client, options);

    let normalizedOrders: NormalizedOrder[];
    let normalizedPayments: NormalizedPayment[];
    let normalizedRefunds: NormalizedRefund[];

    if (options.provider === "square") {
      const orders = await loadRawRows(client, "raw.square_orders", options);
      const payments = await loadRawRows(client, "raw.square_payments", options);
      const refunds = await loadRawRows(client, "raw.square_refunds", options);
      normalizedOrders = orders.map((row) => normalizeSquareOrder(row.payload, options.timezone)).filter(notNull);
      normalizedPayments = payments.map((row) => normalizeSquarePayment(row.payload, options.timezone)).filter(notNull);
      normalizedRefunds = refunds.map((row) => normalizeSquareRefund(row.payload, options.timezone)).filter(notNull);
    } else if (options.provider === "clover") {
      const tenderLookup = await loadDimensions(client, options.merchantId);
      const orders = await loadRawRows(client, "raw.clover_orders", options);
      const payments = await loadRawRows(client, "raw.clover_payments", options);
      const refunds = await loadRawRows(client, "raw.clover_refunds", options);
      normalizedOrders = orders.map((row) => normalizeOrder(row.payload, options.timezone)).filter(notNull);
      normalizedPayments = payments
        .map((row) => normalizePayment(row.payload, options.timezone, tenderLookup))
        .filter(notNull);
      normalizedRefunds = refunds.map((row) => normalizeRefund(row.payload, options.timezone)).filter(notNull);
    } else {
      // Fail LOUD before the destructive deleteMartRange: an unknown provider
      // would read zero raw rows, then delete this merchant's mart range and
      // insert nothing (silent data loss). Refuse instead.
      throw new Error(
        `refreshMartForRange: unknown provider '${options.provider}' for ${options.merchantId} — refusing to refresh (would delete the mart range with no source).`
      );
    }

    await deleteMartRange(client, options);

    const paymentTotalsByOrder = new Map<string, { amount: number; tax: number; tip: number }>();
    for (const payment of normalizedPayments) {
      if (!payment.orderId) {
        continue;
      }
      const current = paymentTotalsByOrder.get(payment.orderId) ?? { amount: 0, tax: 0, tip: 0 };
      current.amount += payment.amountCents;
      current.tax += payment.taxCents;
      current.tip += payment.tipCents;
      paymentTotalsByOrder.set(payment.orderId, current);
    }

    const refundTotalsByOrder = new Map<string, { amount: number; tax: number }>();
    for (const refund of normalizedRefunds) {
      if (!refund.orderId) {
        continue;
      }
      const current = refundTotalsByOrder.get(refund.orderId) ?? { amount: 0, tax: 0 };
      current.amount += refund.amountCents;
      current.tax += refund.taxCents;
      refundTotalsByOrder.set(refund.orderId, current);
    }

    const paymentRows = uniqueRowsByKey(normalizedPayments.map((payment): unknown[] => [
      options.merchantId,
      payment.paymentId,
      payment.businessDate,
      payment.orderId,
      payment.createdAt,
      payment.local.localHour,
      payment.local.weekday,
      payment.local.yearMonth,
      payment.local.isoWeek,
      payment.employeeId,
      payment.tenderId,
      payment.tenderType,
      payment.result,
      payment.currency,
      payment.amountCents,
      payment.tipCents,
      payment.taxCents
    ]), [0, 1, 2]);
    await batchInsert(client, `
      INSERT INTO mart.fact_payments (
        merchant_id, payment_id, business_date, order_id, created_at_utc, local_hour,
        weekday, year_month, iso_week, employee_id, tender_id, tender_type, payment_result,
        currency, amount_cents, tip_cents, tax_cents
      )
      VALUES /*VALUES*/
      ON CONFLICT (merchant_id, payment_id, business_date) DO UPDATE SET
        order_id = EXCLUDED.order_id,
        amount_cents = EXCLUDED.amount_cents,
        tip_cents = EXCLUDED.tip_cents,
        tax_cents = EXCLUDED.tax_cents,
        tender_type = EXCLUDED.tender_type
    `, paymentRows);

    const refundRows = uniqueRowsByKey(normalizedRefunds.map((refund): unknown[] => [
      options.merchantId,
      refund.refundId,
      refund.businessDate,
      refund.paymentId,
      refund.orderId,
      refund.createdAt,
      refund.local.localHour,
      refund.local.weekday,
      refund.local.yearMonth,
      refund.local.isoWeek,
      refund.employeeId,
      refund.amountCents,
      refund.taxCents,
      refund.reason
    ]), [0, 1, 2]);
    await batchInsert(client, `
      INSERT INTO mart.fact_refunds (
        merchant_id, refund_id, business_date, payment_id, order_id, created_at_utc,
        local_hour, weekday, year_month, iso_week, employee_id, amount_cents, tax_cents, reason
      )
      VALUES /*VALUES*/
      ON CONFLICT (merchant_id, refund_id, business_date) DO UPDATE SET
        payment_id = EXCLUDED.payment_id,
        order_id = EXCLUDED.order_id,
        amount_cents = EXCLUDED.amount_cents,
        tax_cents = EXCLUDED.tax_cents,
        reason = EXCLUDED.reason
    `, refundRows);

    const dimItemRows: unknown[][] = [];
    const lineItemRows: unknown[][] = [];
    const modifierRows: unknown[][] = [];
    const orderRows: unknown[][] = [];

    for (const order of normalizedOrders) {
      for (const item of order.lineItems) {
        dimItemRows.push([options.merchantId, item.itemFingerprint, item.itemId, item.itemName, item.alternateName]);
        lineItemRows.push([
          options.merchantId,
          order.orderId,
          item.lineItemFingerprint,
          item.lineItemId,
          item.businessDate,
          item.createdAt,
          item.itemFingerprint,
          item.itemId,
          item.itemName,
          item.quantity,
          item.unitPriceCents,
          item.modifierTotalCents,
          item.grossSalesCents,
          item.discountTotalCents,
          item.taxTotalCents,
          item.refunded,
          JSON.stringify(item.modifiers),
          JSON.stringify(item.raw)
        ]);

        for (const [modifierIndex, modifier] of item.modifiers.entries()) {
          const modifierRow = normalizeLineItemModifier(order.orderId, item, modifier, modifierIndex);
          modifierRows.push([
            options.merchantId,
            order.orderId,
            item.lineItemFingerprint,
            modifierRow.fingerprint,
            item.lineItemId,
            item.businessDate,
            item.createdAt,
            item.itemFingerprint,
            modifierRow.modifierId,
            modifierRow.name,
            modifierRow.amountCents,
            item.quantity,
            JSON.stringify(modifier)
          ]);
        }
      }

      const paymentTotals = paymentTotalsByOrder.get(order.orderId) ?? { amount: 0, tax: 0, tip: 0 };
      const refundTotals = refundTotalsByOrder.get(order.orderId) ?? { amount: 0, tax: 0 };
      orderRows.push([
        options.merchantId,
        order.orderId,
        order.businessDate,
        order.createdAt,
        order.modifiedAt,
        order.local.localHour,
        order.local.weekday,
        order.local.yearMonth,
        order.local.isoWeek,
        order.employeeId,
        order.orderTypeId,
        order.orderLabel,
        order.paymentState,
        order.orderState,
        order.currency,
        order.orderTotalCents,
        paymentTotals.amount,
        refundTotals.amount,
        paymentTotals.amount - refundTotals.amount,
        paymentTotals.tax,
        paymentTotals.tip,
        order.discountTotalCents,
        order.lineItems.length
      ]);
    }

    await batchInsert(client, `
      INSERT INTO mart.dim_item (merchant_id, item_fingerprint, item_id, item_name, alternate_name, updated_at)
      VALUES /*VALUES*/
      ON CONFLICT (merchant_id, item_fingerprint) DO UPDATE SET
        item_id = COALESCE(EXCLUDED.item_id, mart.dim_item.item_id),
        item_name = EXCLUDED.item_name,
        alternate_name = EXCLUDED.alternate_name,
        updated_at = now()
    `, uniqueRowsByKey(dimItemRows, [0, 1]), [], ["now()"]);

    await batchInsert(client, `
      INSERT INTO mart.fact_order_line_items (
        merchant_id, order_id, line_item_fingerprint, line_item_id, business_date,
        created_at_utc, item_fingerprint, item_id, item_name, quantity, unit_price_cents,
        modifier_total_cents, gross_sales_cents, discount_total_cents, tax_total_cents, refunded, modifiers, raw
      )
      VALUES /*VALUES*/
      ON CONFLICT (merchant_id, order_id, line_item_fingerprint, business_date) DO UPDATE SET
        quantity = EXCLUDED.quantity,
        unit_price_cents = EXCLUDED.unit_price_cents,
        modifier_total_cents = EXCLUDED.modifier_total_cents,
        gross_sales_cents = EXCLUDED.gross_sales_cents,
        discount_total_cents = EXCLUDED.discount_total_cents,
        tax_total_cents = EXCLUDED.tax_total_cents,
        refunded = EXCLUDED.refunded,
        modifiers = EXCLUDED.modifiers,
        raw = EXCLUDED.raw
    `, uniqueRowsByKey(lineItemRows, [0, 1, 2, 4]), ["", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "::jsonb", "::jsonb"]);

    await batchInsert(client, `
      INSERT INTO mart.fact_line_item_modifiers (
        merchant_id, order_id, line_item_fingerprint, line_item_modifier_fingerprint,
        line_item_id, business_date, created_at_utc, item_fingerprint, modifier_id,
        modifier_name, modifier_amount_cents, quantity, raw
      )
      VALUES /*VALUES*/
      ON CONFLICT (
        merchant_id, order_id, line_item_fingerprint, line_item_modifier_fingerprint, business_date
      ) DO UPDATE SET
        modifier_id = EXCLUDED.modifier_id,
        modifier_name = EXCLUDED.modifier_name,
        modifier_amount_cents = EXCLUDED.modifier_amount_cents,
        quantity = EXCLUDED.quantity,
        raw = EXCLUDED.raw
    `, uniqueRowsByKey(modifierRows, [0, 1, 2, 3, 5]), ["", "", "", "", "", "", "", "", "", "", "", "", "::jsonb"]);

    await batchInsert(client, `
      INSERT INTO mart.fact_orders (
        merchant_id, order_id, business_date, created_at_utc, modified_at_utc, local_hour,
        weekday, year_month, iso_week, employee_id, order_type_id, order_label, payment_state,
        order_state, currency, order_total_cents, payment_total_cents, refund_total_cents,
        net_sales_cents, tax_total_cents, tip_total_cents, discount_total_cents, line_item_count,
        raw_updated_at
      )
      VALUES /*VALUES*/
      ON CONFLICT (merchant_id, order_id, business_date) DO UPDATE SET
        payment_total_cents = EXCLUDED.payment_total_cents,
        refund_total_cents = EXCLUDED.refund_total_cents,
        net_sales_cents = EXCLUDED.net_sales_cents,
        line_item_count = EXCLUDED.line_item_count,
        raw_updated_at = now()
    `, uniqueRowsByKey(orderRows, [0, 1, 2]), [], ["now()"]);
  });
}

export async function refreshMartDimensions(pool: DbPool, merchantId: string) {
  await withTransaction(pool, async (client) => {
    await loadDimensions(client, merchantId);
  });
}

async function batchInsert(
  client: QueryClient,
  sqlTemplate: string,
  rows: unknown[][],
  casts: string[] = [],
  suffixLiterals: string[] = [],
  batchSize = 500
) {
  if (rows.length === 0) {
    return;
  }
  for (let start = 0; start < rows.length; start += batchSize) {
    const batch = rows.slice(start, start + batchSize);
    const params: unknown[] = [];
    const values = batch.map((row) => {
      const placeholders = row.map((value, columnIndex) => {
        params.push(value);
        return `$${params.length}${casts[columnIndex] ?? ""}`;
      });
      return `(${[...placeholders, ...suffixLiterals].join(", ")})`;
    });
    await client.query(sqlTemplate.replace("/*VALUES*/", values.join(",\n")), params);
  }
}

function uniqueRowsByKey(rows: unknown[][], keyIndexes: number[]) {
  const byKey = new Map<string, unknown[]>();
  for (const row of rows) {
    byKey.set(keyIndexes.map((index) => keyPart(row[index])).join("\u001f"), row);
  }
  return [...byKey.values()];
}

function keyPart(value: unknown) {
  if (value instanceof Date) {
    return value.toISOString();
  }
  return JSON.stringify(value) ?? String(value);
}

async function loadDimensions(client: QueryClient, merchantId: string) {
  const tenderLookup = new Map<string, TenderType>();

  const tenders = await client.query<RowWithPayload>(
    "SELECT payload FROM raw.clover_tenders WHERE merchant_id = $1",
    [merchantId]
  );
  for (const row of tenders.rows) {
    const tender = normalizeTender(row.payload);
    if (!tender) {
      continue;
    }
    tenderLookup.set(tender.tenderId, tender.type);
    await client.query(
      `
        INSERT INTO mart.dim_tender (merchant_id, tender_id, tender_label, tender_type, raw, updated_at)
        VALUES ($1, $2, $3, $4, $5::jsonb, now())
        ON CONFLICT (merchant_id, tender_id) DO UPDATE SET
          tender_label = EXCLUDED.tender_label,
          tender_type = EXCLUDED.tender_type,
          raw = EXCLUDED.raw,
          updated_at = now()
      `,
      [merchantId, tender.tenderId, tender.label, tender.type, JSON.stringify(tender.raw)]
    );
  }

  const employees = await client.query<RowWithPayload>(
    "SELECT payload FROM raw.clover_employees WHERE merchant_id = $1",
    [merchantId]
  );
  for (const row of employees.rows) {
    const employee = normalizeEmployee(row.payload);
    if (!employee) {
      continue;
    }
    await client.query(
      `
        INSERT INTO mart.dim_employee (merchant_id, employee_id, display_name, raw, updated_at)
        VALUES ($1, $2, $3, $4::jsonb, now())
        ON CONFLICT (merchant_id, employee_id) DO UPDATE SET
          display_name = EXCLUDED.display_name,
          raw = EXCLUDED.raw,
          updated_at = now()
      `,
      [merchantId, employee.employeeId, employee.displayName, JSON.stringify(employee.raw)]
    );
  }

  const orderTypes = await client.query<RowWithPayload>(
    "SELECT payload FROM raw.clover_order_types WHERE merchant_id = $1",
    [merchantId]
  );
  for (const row of orderTypes.rows) {
    const orderType = normalizeOrderType(row.payload);
    if (!orderType) {
      continue;
    }
    await client.query(
      `
        INSERT INTO mart.dim_order_type (merchant_id, order_type_id, label, raw, updated_at)
        VALUES ($1, $2, $3, $4::jsonb, now())
        ON CONFLICT (merchant_id, order_type_id) DO UPDATE SET
          label = EXCLUDED.label,
          raw = EXCLUDED.raw,
          updated_at = now()
      `,
      [merchantId, orderType.orderTypeId, orderType.label, JSON.stringify(orderType.raw)]
    );
  }

  return tenderLookup;
}

async function loadCalendar(client: QueryClient, options: RefreshOptions) {
  for (const row of dateDimensionRows(options.start, options.end, options.timezone)) {
    await client.query(
      `
        INSERT INTO mart.dim_calendar (
          business_date, year, quarter, month, day_of_month, iso_week, weekday,
          weekday_name, is_weekend, year_month
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        ON CONFLICT (business_date) DO UPDATE SET
          year = EXCLUDED.year,
          quarter = EXCLUDED.quarter,
          month = EXCLUDED.month,
          day_of_month = EXCLUDED.day_of_month,
          iso_week = EXCLUDED.iso_week,
          weekday = EXCLUDED.weekday,
          weekday_name = EXCLUDED.weekday_name,
          is_weekend = EXCLUDED.is_weekend,
          year_month = EXCLUDED.year_month
      `,
      [
        row.businessDate,
        row.year,
        row.quarter,
        row.month,
        row.dayOfMonth,
        row.isoWeek,
        row.weekday,
        row.weekdayName,
        row.isWeekend,
        row.yearMonth
      ]
    );
  }
}

async function loadRawRows(client: QueryClient, table: string, options: RefreshOptions) {
  const timestampColumn = table === "raw.clover_orders"
    ? "COALESCE(created_time_utc, modified_time_utc)"
    : "created_time_utc";
  const result = await client.query<RowWithPayload>(
    `
      SELECT payload
      FROM ${table}
      WHERE merchant_id = $1
        AND ${timestampColumn} >= $2
        AND ${timestampColumn} < $3
    `,
    [options.merchantId, options.start, options.end]
  );
  return result.rows.map((row) => ({ payload: asRecord(row.payload) }));
}

async function deleteMartRange(client: QueryClient, options: RefreshOptions) {
  const businessStart = DateTime.fromJSDate(options.start, { zone: "utc" }).setZone(options.timezone).toISODate();
  const businessEnd = DateTime.fromJSDate(new Date(options.end.getTime() - 1), { zone: "utc" }).setZone(options.timezone).toISODate();
  for (const table of ["fact_orders", "fact_order_line_items", "fact_line_item_modifiers", "fact_payments", "fact_refunds"]) {
    await client.query(
      `
        DELETE FROM mart.${table}
        WHERE merchant_id = $1
          AND business_date >= $4
          AND business_date <= $5
          AND created_at_utc >= $2
          AND created_at_utc < $3
      `,
      [options.merchantId, options.start, options.end, businessStart, businessEnd]
    );
  }
}

async function ensureMonthlyPartitions(pool: DbPool, start: Date, end: Date) {
  const months = monthsBetween(start, end);
  for (const month of months) {
    for (const table of ["fact_orders", "fact_order_line_items", "fact_line_item_modifiers", "fact_payments", "fact_refunds"]) {
      const name = `${table}_${month.replace("-", "m")}`;
      await pool.query(`
        CREATE TABLE IF NOT EXISTS mart.${quoteIdent(name)}
        PARTITION OF mart.${quoteIdent(table)}
        FOR VALUES FROM ('${month}-01') TO ('${nextMonth(month)}-01')
      `);
    }
  }
}

function monthsBetween(start: Date, end: Date) {
  const months: string[] = [];
  const cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
  const last = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1));
  while (cursor <= last) {
    months.push(`${cursor.getUTCFullYear()}-${String(cursor.getUTCMonth() + 1).padStart(2, "0")}`);
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return months;
}

function nextMonth(month: string) {
  const [yearRaw, monthRaw] = month.split("-");
  const date = new Date(Date.UTC(Number(yearRaw), Number(monthRaw) - 1, 1));
  date.setUTCMonth(date.getUTCMonth() + 1);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function quoteIdent(value: string) {
  return `"${value.replaceAll('"', '""')}"`;
}

function normalizeLineItemModifier(
  orderId: string,
  item: { lineItemFingerprint: string },
  modifier: JsonRecord,
  index: number
) {
  const nested = asRecord(modifier.modifier);
  const modifierId = asString(modifier.id) ?? asString(modifier.modifierId) ?? asString(nested.id);
  const name = asString(modifier.name) ?? asString(modifier.label) ?? asString(nested.name) ?? "Unnamed modifier";
  const amountCents = cents(modifier.amount ?? nested.amount);
  const fingerprint = modifierId
    ? `modifier:${modifierId}`
    : `anon:${sha256Text(JSON.stringify([orderId, item.lineItemFingerprint, index, name, amountCents]))}`;
  return { modifierId, name, amountCents, fingerprint };
}

type RowWithPayload = {
  payload: JsonRecord;
};

type QueryClient = {
  query: <T = any>(sql: string, values?: unknown[]) => Promise<{ rows: T[] }>;
};

function notNull<T>(value: T | null): value is T {
  return value !== null;
}
