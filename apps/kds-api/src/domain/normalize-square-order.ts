import type { NormalizedOrder, NormalizedOrderItem } from "@rop/contracts";

import { buildStableItemKey } from "./normalize-order.js";
import { squareMoneyToCents, type SquareMoneyLike } from "./square-money.js";

/**
 * Normalize a Square `Order` (from `orders.search` / `orders.get`) into the
 * POS-neutral NormalizedOrder the sync pipeline consumes — the Square sibling of
 * normalize-order.ts (Clover) and normalize-deliverect-order.ts.
 *
 * Typed against a minimal structural slice of the v44 `Order` model (decoupled
 * from the SDK, testable with plain fixtures). The seams that differ from Clover:
 *  - **Money is bigint** → coerced via the shared squareMoneyToCents seam.
 *  - **`quantity` is a string** ("1", "2", "1.5") → parsed to an int ≥ 1.
 *  - **Payment is gated on `net_amount_due_money == 0`** (fully paid), surfaced as
 *    a `paymentState` of "PAID" / "UNPAID"; an UNPAID order is kept off the board
 *    by shouldSkipForUnpaidState (sync-order.ts).
 *  - **Customer** for loyalty comes from the pickup fulfillment's recipient
 *    (display name + phone), not a top-level customer object.
 */

export interface SquareOrderLineItemModifier {
  uid?: string | null;
  catalogObjectId?: string | null;
  name?: string | null;
  totalPriceMoney?: SquareMoneyLike | null;
}

export interface SquareOrderLineItem {
  uid?: string | null;
  name?: string | null;
  variationName?: string | null;
  quantity?: string | null;
  note?: string | null;
  catalogObjectId?: string | null;
  modifiers?: SquareOrderLineItemModifier[] | null;
  totalMoney?: SquareMoneyLike | null;
  grossSalesMoney?: SquareMoneyLike | null;
  basePriceMoney?: SquareMoneyLike | null;
}

export interface SquareFulfillmentRecipient {
  displayName?: string | null;
  phoneNumber?: string | null;
}

export interface SquareFulfillmentPickupDetails {
  recipient?: SquareFulfillmentRecipient | null;
  note?: string | null;
}

export interface SquareFulfillment {
  type?: string | null; // PICKUP | DELIVERY | SHIPMENT | DIGITAL
  state?: string | null;
  pickupDetails?: SquareFulfillmentPickupDetails | null;
}

export interface SquareOrder {
  id?: string | null;
  locationId?: string | null;
  referenceId?: string | null;
  ticketName?: string | null;
  source?: { name?: string | null } | null;
  state?: string | null; // OPEN | COMPLETED | CANCELED | DRAFT
  createdAt?: string | null;
  updatedAt?: string | null;
  lineItems?: SquareOrderLineItem[] | null;
  fulfillments?: SquareFulfillment[] | null;
  totalMoney?: SquareMoneyLike | null;
  totalTaxMoney?: SquareMoneyLike | null;
  totalTipMoney?: SquareMoneyLike | null;
  netAmountDueMoney?: SquareMoneyLike | null;
}

// Square "PAID" marker = net_amount_due_money == 0. Exported so the payment gate
// (sync-order.ts) and tests share the exact literal.
export const SQUARE_PAYMENT_STATE_PAID = "PAID";
export const SQUARE_PAYMENT_STATE_UNPAID = "UNPAID";

// Fully paid iff nothing is still owed. If Square omits net_amount_due (some
// states), a COMPLETED order is treated as paid (Square has closed it out);
// anything else stays UNPAID → off the board (fail closed).
function isFullyPaid(order: SquareOrder): boolean {
  if (order.netAmountDueMoney != null) {
    return squareMoneyToCents(order.netAmountDueMoney) === 0;
  }
  return (order.state ?? "").toUpperCase() === "COMPLETED";
}

// Square line `quantity` is a decimal string; menu items are whole units. Floor
// to an int ≥ 1 (NormalizedOrderItem requires quantity ≥ 1).
function parseQuantity(raw: string | null | undefined): number {
  const parsed = Number.parseInt((raw ?? "1").trim(), 10);
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : 1;
}

function firstFulfillment(order: SquareOrder): SquareFulfillment | null {
  return (order.fulfillments ?? []).find((entry): entry is SquareFulfillment => Boolean(entry)) ?? null;
}

export function normalizeSquareOrder(order: SquareOrder, merchantId: string): NormalizedOrder {
  const orderId = order.id ?? "";
  const fulfillment = firstFulfillment(order);
  const fulfillmentType = (fulfillment?.type ?? "").toUpperCase();

  const items: NormalizedOrderItem[] = (order.lineItems ?? []).map((line, index) => {
    const base = {
      cloverLineItemId: null,
      providerLineItemId: line.uid ?? null,
      itemId: line.catalogObjectId ?? null,
      name: line.name ?? "",
      note: line.note ?? null,
      modifiers: (line.modifiers ?? [])
        .map((modifier) => modifier.name ?? "")
        .filter((name) => name.length > 0),
    };
    return {
      ...base,
      itemKey: buildStableItemKey(base, index),
      alternateName: line.variationName ?? null,
      quantity: parseQuantity(line.quantity),
      priceCents: line.totalMoney ? squareMoneyToCents(line.totalMoney) : null,
      refunded: false,
      printed: false,
    };
  });

  const totalCents = order.totalMoney ? squareMoneyToCents(order.totalMoney) : null;
  const taxCents = order.totalTaxMoney ? squareMoneyToCents(order.totalTaxMoney) : null;
  const tipCents = order.totalTipMoney ? squareMoneyToCents(order.totalTipMoney) : null;
  // Square has no single "subtotal" field — derive it (ignores discounts/service
  // charges, which is fine for kitchen display; checkout/pricing is deferred).
  const subtotalCents =
    totalCents != null ? Math.max(0, totalCents - (taxCents ?? 0) - (tipCents ?? 0)) : null;

  const recipient = fulfillment?.pickupDetails?.recipient ?? null;
  const customer =
    recipient && (recipient.displayName || recipient.phoneNumber)
      ? { name: recipient.displayName ?? null, phone: recipient.phoneNumber ?? null }
      : null;

  const createdAt = order.createdAt ?? order.updatedAt ?? new Date(0).toISOString();

  return {
    provider: "square",
    merchantId,
    orderId,
    sourceOrderId: orderId,
    // Kitchen label: the cashier's ticket name, else a customer reference, else a
    // short id slug.
    orderLabel: order.ticketName?.trim() || order.referenceId?.trim() || `#${orderId.slice(0, 6)}`,
    source: order.source?.name ?? null,
    orderType: fulfillment?.type ?? null,
    paymentState: isFullyPaid(order) ? SQUARE_PAYMENT_STATE_PAID : SQUARE_PAYMENT_STATE_UNPAID,
    note: fulfillment?.pickupDetails?.note ?? null,
    priority: fulfillmentType === "DELIVERY" ? 2 : 0,
    createdAt,
    modifiedAt: order.updatedAt ?? createdAt,
    items,
    amounts: {
      subtotalCents,
      taxCents,
      tipCents,
      totalCents,
      currency: order.totalMoney?.currency ?? "USD",
    },
    customer,
  };
}
