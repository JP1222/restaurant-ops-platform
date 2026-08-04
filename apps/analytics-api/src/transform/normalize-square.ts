import { sha256Text } from "../lib/hash.js";
import { asArray, asNumber, asRecord, asString } from "../lib/json.js";
import { parseCloverTimestamp, toLocalParts } from "../lib/time.js";
import type { JsonRecord, LocalTimeParts, TenderType } from "../types.js";
import type {
  NormalizedLineItem,
  NormalizedOrder,
  NormalizedPayment,
  NormalizedRefund,
} from "./normalize.js";

// Square → mart normalizers. Produce the EXACT same Normalized* shapes as the
// Clover normalizers (normalize.ts) so the mart-loader's fact INSERTs never
// branch. Read the SDK camelCase JSON stored in raw.square_* (Money.amount is
// already a NUMBER — the SquareClient deep-coerced the SDK bigint before persist).
//
// Lean scope (no employees/dim_employee): employeeId is always null. Tax is on
// the order/line items (Square doesn't split tax onto the payment), so payment /
// refund taxCents is 0.

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Square Money → integer cents. The nested `.amount` is already a number in the
// stored payload; this just extracts + truncates.
function moneyCents(money: unknown): number {
  return Math.trunc(asNumber(asRecord(money).amount) ?? 0);
}

// Square line `quantity` is a decimal string ("1", "2"); menu items are whole
// units. parseCloverTimestamp handles Square's ISO-8601 strings via new Date().
function squareQuantity(value: unknown): number {
  const parsed = Number.parseInt((asString(value) ?? "1").trim(), 10);
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : 1;
}

function parseSquareTimestamp(value: unknown): Date {
  return parseCloverTimestamp(value) ?? new Date(0);
}

// Map a Square payment's source_type to the mart's constrained tender_type set
// (CASH/CREDIT_CARD/GIFT_CARD/OTHER/UNKNOWN — the fact_payments CHECK).
export function normalizeSquareTenderType(payment: JsonRecord): TenderType {
  const sourceType = (asString(payment.sourceType) ?? "").toUpperCase();
  if (sourceType.length === 0) {
    return "UNKNOWN";
  }
  if (sourceType === "CASH") {
    return "CASH";
  }
  if (sourceType === "SQUARE_GIFT_CARD") {
    return "GIFT_CARD";
  }
  if (sourceType === "CARD") {
    return "CREDIT_CARD";
  }
  return "OTHER";
}

export function normalizeSquarePayment(raw: JsonRecord, timezone: string): NormalizedPayment | null {
  const paymentId = asString(raw.id);
  if (!paymentId) {
    return null;
  }
  // Skip non-completed payments (failed/canceled) so they don't inflate revenue.
  const status = (asString(raw.status) ?? "").toUpperCase();
  if (status === "FAILED" || status === "CANCELED") {
    return null;
  }
  const createdAt = parseSquareTimestamp(raw.createdAt);
  const local = toLocalParts(createdAt, timezone);
  return {
    paymentId,
    orderId: asString(raw.orderId),
    businessDate: local.businessDate,
    createdAt,
    local,
    employeeId: null,
    tenderId: null,
    tenderType: normalizeSquareTenderType(raw),
    result: asString(raw.status),
    currency: asString(asRecord(raw.amountMoney).currency),
    amountCents: moneyCents(raw.amountMoney),
    tipCents: moneyCents(raw.tipMoney),
    taxCents: 0,
  };
}

export function normalizeSquareRefund(raw: JsonRecord, timezone: string): NormalizedRefund | null {
  const refundId = asString(raw.id);
  if (!refundId) {
    return null;
  }
  const createdAt = parseSquareTimestamp(raw.createdAt);
  const local = toLocalParts(createdAt, timezone);
  return {
    refundId,
    paymentId: asString(raw.paymentId),
    orderId: asString(raw.orderId),
    businessDate: local.businessDate,
    createdAt,
    local,
    employeeId: null,
    amountCents: Math.abs(moneyCents(raw.amountMoney)),
    taxCents: 0,
    reason: asString(raw.reason),
  };
}

export function normalizeSquareOrder(raw: JsonRecord, timezone: string): NormalizedOrder | null {
  const orderId = asString(raw.id);
  if (!orderId) {
    return null;
  }
  const createdAt = parseSquareTimestamp(raw.createdAt);
  const modifiedAt = parseCloverTimestamp(raw.updatedAt);
  const local = toLocalParts(createdAt, timezone);
  const fulfillment = asArray(raw.fulfillments).filter(isRecord)[0];
  const state = asString(raw.state);

  return {
    orderId,
    businessDate: local.businessDate,
    createdAt,
    modifiedAt,
    local,
    employeeId: null,
    orderTypeId: asString(fulfillment?.type),
    orderLabel: asString(raw.ticketName) ?? asString(raw.referenceId),
    paymentState: state,
    orderState: state,
    currency: asString(asRecord(raw.totalMoney).currency),
    orderTotalCents: moneyCents(raw.totalMoney),
    discountTotalCents: moneyCents(raw.totalDiscountMoney),
    lineItems: normalizeSquareLineItems(raw, orderId, createdAt, local),
  };
}

function normalizeSquareLineItems(
  order: JsonRecord,
  orderId: string,
  createdAt: Date,
  local: LocalTimeParts
): NormalizedLineItem[] {
  return asArray(order.lineItems)
    .filter(isRecord)
    .map((lineItem, index) => {
      const lineItemId = asString(lineItem.uid);
      const itemId = asString(lineItem.catalogObjectId);
      const itemName = asString(lineItem.name) ?? "Unnamed item";
      const alternateName = asString(lineItem.variationName);
      const quantity = squareQuantity(lineItem.quantity);
      const unitPriceCents = moneyCents(lineItem.basePriceMoney);

      // Reshape Square modifiers into {id, name, amount(cents)} so the shared
      // normalizeLineItemModifier (mart-loader) reads them unchanged (it expects
      // modifier.name + modifier.amount). The full original line is in `raw`.
      const modifiers: JsonRecord[] = asArray(lineItem.modifiers)
        .filter(isRecord)
        .map((modifier) => ({
          id: asString(modifier.catalogObjectId) ?? asString(modifier.uid),
          name: asString(modifier.name) ?? "Unnamed modifier",
          amount: moneyCents(modifier.totalPriceMoney),
        }));
      const modifierTotalCents = modifiers.reduce((sum, modifier) => sum + Number(modifier.amount ?? 0), 0);

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
        grossSalesCents: lineItem.grossSalesMoney
          ? moneyCents(lineItem.grossSalesMoney)
          : Math.round((unitPriceCents + modifierTotalCents) * quantity),
        discountTotalCents: moneyCents(lineItem.totalDiscountMoney),
        taxTotalCents: moneyCents(lineItem.totalTaxMoney),
        refunded: false,
        modifiers,
        raw: lineItem,
      };
    });
}
