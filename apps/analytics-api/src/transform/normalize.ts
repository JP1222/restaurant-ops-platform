import { DateTime } from "luxon";
import { sha256Text } from "../lib/hash.js";
import { asArray, asBoolean, asNumber, asRecord, asString } from "../lib/json.js";
import { parseCloverTimestamp, toLocalParts } from "../lib/time.js";
import type { JsonRecord, LocalTimeParts, TenderType } from "../types.js";

export type NormalizedTender = {
  tenderId: string;
  label: string | null;
  type: TenderType;
  raw: JsonRecord;
};

export type NormalizedEmployee = {
  employeeId: string;
  displayName: string | null;
  raw: JsonRecord;
};

export type NormalizedOrderType = {
  orderTypeId: string;
  label: string | null;
  raw: JsonRecord;
};

export type NormalizedPayment = {
  paymentId: string;
  orderId: string | null;
  businessDate: string;
  createdAt: Date;
  local: LocalTimeParts;
  employeeId: string | null;
  tenderId: string | null;
  tenderType: TenderType;
  result: string | null;
  currency: string | null;
  amountCents: number;
  tipCents: number;
  taxCents: number;
};

export type NormalizedRefund = {
  refundId: string;
  paymentId: string | null;
  orderId: string | null;
  businessDate: string;
  createdAt: Date;
  local: LocalTimeParts;
  employeeId: string | null;
  amountCents: number;
  taxCents: number;
  reason: string | null;
};

export type NormalizedOrder = {
  orderId: string;
  businessDate: string;
  createdAt: Date;
  modifiedAt: Date | null;
  local: LocalTimeParts;
  employeeId: string | null;
  orderTypeId: string | null;
  orderLabel: string | null;
  paymentState: string | null;
  orderState: string | null;
  currency: string | null;
  orderTotalCents: number;
  discountTotalCents: number;
  lineItems: NormalizedLineItem[];
};

export type NormalizedLineItem = {
  orderId: string;
  lineItemFingerprint: string;
  lineItemId: string | null;
  businessDate: string;
  createdAt: Date;
  itemFingerprint: string;
  itemId: string | null;
  itemName: string;
  alternateName: string | null;
  quantity: number;
  unitPriceCents: number;
  modifierTotalCents: number;
  grossSalesCents: number;
  discountTotalCents: number;
  taxTotalCents: number;
  refunded: boolean;
  modifiers: JsonRecord[];
  raw: JsonRecord;
};

export function normalizeTender(raw: JsonRecord): NormalizedTender | null {
  const tenderId = asString(raw.id);
  if (!tenderId) {
    return null;
  }
  const label = asString(raw.label) ?? asString(raw.name);
  return {
    tenderId,
    label,
    type: normalizeTenderType(label, raw),
    raw
  };
}

export function normalizeEmployee(raw: JsonRecord): NormalizedEmployee | null {
  const employeeId = asString(raw.id);
  if (!employeeId) {
    return null;
  }
  const displayNameParts = [asString(raw.nickname), asString(raw.firstName), asString(raw.lastName)]
    .filter((part): part is string => Boolean(part))
    .join(" ")
    .trim();
  const displayName = asString(raw.name) ?? (displayNameParts || null);
  return { employeeId, displayName, raw };
}

export function normalizeOrderType(raw: JsonRecord): NormalizedOrderType | null {
  const orderTypeId = asString(raw.id);
  if (!orderTypeId) {
    return null;
  }
  const label = asString(raw.label) ?? asString(raw.name);
  return { orderTypeId, label, raw };
}

export function normalizePayment(
  raw: JsonRecord,
  timezone: string,
  tenderLookup: Map<string, TenderType>
): NormalizedPayment | null {
  const paymentId = asString(raw.id) ?? asString(raw.paymentId);
  if (!paymentId || !isSuccessfulPayment(raw)) {
    return null;
  }

  const createdAt = parseCloverTimestamp(raw.createdTime ?? raw.clientCreatedTime) ?? new Date(0);
  const local = toLocalParts(createdAt, timezone);
  const tenderId = asString(asRecord(raw.tender).id) ?? asString(raw.tenderId);
  const fallbackTenderType = normalizeTenderType(
    asString(asRecord(raw.tender).label) ?? asString(asRecord(raw.tender).name),
    asRecord(raw.tender)
  );

  return {
    paymentId,
    orderId: extractOrderId(raw),
    businessDate: local.businessDate,
    createdAt,
    local,
    employeeId: extractEmployeeId(raw),
    tenderId,
    tenderType: tenderId ? tenderLookup.get(tenderId) ?? fallbackTenderType : fallbackTenderType,
    result: asString(raw.result) ?? asString(raw.status),
    currency: asString(raw.currency),
    amountCents: cents(raw.amount ?? raw.total),
    tipCents: cents(raw.tipAmount ?? raw.tip),
    taxCents: cents(raw.taxAmount ?? raw.tax)
  };
}

export function normalizeRefund(raw: JsonRecord, timezone: string): NormalizedRefund | null {
  const refundId = asString(raw.id) ?? asString(raw.refundId);
  if (!refundId) {
    return null;
  }

  const createdAt = parseCloverTimestamp(raw.createdTime ?? raw.clientCreatedTime) ?? new Date(0);
  const local = toLocalParts(createdAt, timezone);

  return {
    refundId,
    paymentId: asString(asRecord(raw.payment).id) ?? asString(raw.paymentId),
    orderId: extractOrderId(raw),
    businessDate: local.businessDate,
    createdAt,
    local,
    employeeId: extractEmployeeId(raw),
    amountCents: Math.abs(cents(raw.amount ?? raw.total)),
    taxCents: Math.abs(cents(raw.taxAmount ?? raw.tax)),
    reason: asString(raw.reason) ?? asString(raw.note)
  };
}

export function normalizeOrder(raw: JsonRecord, timezone: string): NormalizedOrder | null {
  const orderId = asString(raw.id) ?? asString(raw.orderId);
  if (!orderId) {
    return null;
  }

  const createdAt = parseCloverTimestamp(raw.clientCreatedTime ?? raw.createdTime) ?? new Date(0);
  const modifiedAt = parseCloverTimestamp(raw.modifiedTime ?? raw.updatedTime);
  const local = toLocalParts(createdAt, timezone);
  const lineItems = normalizeLineItems(raw, orderId, createdAt, local);

  return {
    orderId,
    businessDate: local.businessDate,
    createdAt,
    modifiedAt,
    local,
    employeeId: extractEmployeeId(raw),
    orderTypeId: asString(asRecord(raw.orderType).id) ?? asString(raw.orderTypeId),
    orderLabel: asString(raw.title) ?? asString(raw.orderNumber) ?? asString(raw.displayCode),
    paymentState: asString(raw.paymentState),
    orderState: asString(raw.state),
    currency: asString(raw.currency),
    orderTotalCents: cents(raw.total),
    discountTotalCents: discountTotal(raw),
    lineItems
  };
}

export function normalizeTenderType(label: string | null, raw: JsonRecord = {}): TenderType {
  const type = [
    label,
    asString(raw.label),
    asString(raw.name),
    asString(raw.tenderType),
    asString(raw.type)
  ].filter(Boolean).join(" ").toLowerCase();

  if (type.includes("cash")) {
    return "CASH";
  }
  if (type.includes("gift")) {
    return "GIFT_CARD";
  }
  if (type.includes("credit") || type.includes("card") || type.includes("visa") || type.includes("mastercard") || type.includes("amex") || type.includes("discover")) {
    return "CREDIT_CARD";
  }
  if (type.trim().length === 0) {
    return "UNKNOWN";
  }
  return "OTHER";
}

export function cents(value: unknown): number {
  return Math.trunc(asNumber(value) ?? 0);
}

export function dateDimensionRows(start: Date, end: Date, timezone: string) {
  const rows: Array<{
    businessDate: string;
    year: number;
    quarter: number;
    month: number;
    dayOfMonth: number;
    isoWeek: number;
    weekday: number;
    weekdayName: string;
    isWeekend: boolean;
    yearMonth: string;
  }> = [];

  let cursor = DateTime.fromJSDate(start, { zone: "utc" }).setZone(timezone).startOf("day");
  const last = DateTime.fromJSDate(end, { zone: "utc" }).setZone(timezone).startOf("day");
  while (cursor <= last) {
    rows.push({
      businessDate: cursor.toISODate() ?? "1970-01-01",
      year: cursor.year,
      quarter: cursor.quarter,
      month: cursor.month,
      dayOfMonth: cursor.day,
      isoWeek: cursor.weekNumber,
      weekday: cursor.weekday,
      weekdayName: cursor.weekdayLong ?? cursor.toFormat("cccc"),
      isWeekend: cursor.weekday >= 6,
      yearMonth: cursor.toFormat("yyyy-MM")
    });
    cursor = cursor.plus({ days: 1 });
  }

  return rows;
}

function normalizeLineItems(
  order: JsonRecord,
  orderId: string,
  createdAt: Date,
  local: LocalTimeParts
): NormalizedLineItem[] {
  return asArray(order.lineItems).filter(isRecord).map((lineItem, index) => {
    const lineItemId = asString(lineItem.id);
    const item = asRecord(lineItem.item);
    const itemId = asString(item.id) ?? asString(lineItem.itemId);
    const itemName = asString(lineItem.name) ?? asString(item.name) ?? "Unnamed item";
    const alternateName = asString(lineItem.alternateName) ?? asString(item.alternateName);
    const quantity = normalizeQuantity(lineItem.unitQty ?? lineItem.quantity);
    const unitPriceCents = cents(lineItem.price ?? lineItem.unitPrice);
    const modifiers = asArray(lineItem.modifications).filter(isRecord);
    const modifierTotalCents = modifiers.reduce((sum, modifier) => sum + cents(modifier.amount), 0);
    const itemFingerprint = itemId ? `item:${itemId}` : `name:${sha256Text(itemName.toLowerCase())}`;
    const lineItemFingerprint = lineItemId
      ? `line:${lineItemId}`
      : `anon:${sha256Text(JSON.stringify([orderId, index, itemName, modifiers]))}`;

    return {
      orderId,
      lineItemFingerprint,
      lineItemId,
      businessDate: local.businessDate,
      createdAt,
      itemFingerprint,
      itemId,
      itemName,
      alternateName,
      quantity,
      unitPriceCents,
      modifierTotalCents,
      grossSalesCents: Math.round((unitPriceCents + modifierTotalCents) * quantity),
      discountTotalCents: discountTotal(lineItem),
      taxTotalCents: cents(lineItem.taxAmount ?? lineItem.tax),
      refunded: asBoolean(lineItem.refunded),
      modifiers,
      raw: lineItem
    };
  });
}

function normalizeQuantity(value: unknown): number {
  const raw = asNumber(value);
  if (!raw || raw <= 0) {
    return 1;
  }
  if (raw > 100 && Number.isInteger(raw) && raw % 1000 === 0) {
    return raw / 1000;
  }
  return raw;
}

function discountTotal(raw: JsonRecord): number {
  const direct = cents(raw.discountAmount ?? raw.discount);
  const discounts = asArray(raw.discounts)
    .filter(isRecord)
    .reduce((sum, discount) => sum + Math.abs(cents(discount.amount)), 0);
  return Math.abs(direct) + discounts;
}

function isSuccessfulPayment(raw: JsonRecord) {
  const text = [asString(raw.result), asString(raw.status), asString(raw.state)]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  if (asBoolean(raw.voided) || (asBoolean(raw.offline) && text.includes("declined"))) {
    return false;
  }
  if (/(fail|failed|declin|void|cancel|error)/.test(text)) {
    return false;
  }
  return true;
}

function extractOrderId(raw: JsonRecord): string | null {
  return asString(asRecord(raw.order).id)
    ?? asString(asRecord(raw.orderRef).id)
    ?? asString(raw.orderId);
}

function extractEmployeeId(raw: JsonRecord): string | null {
  return asString(asRecord(raw.employee).id)
    ?? asString(asRecord(raw.employeeRef).id)
    ?? asString(asRecord(raw.server).id)
    ?? asString(raw.employeeId);
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
