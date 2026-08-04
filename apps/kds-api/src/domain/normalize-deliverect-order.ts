import type { NormalizedOrder, NormalizedOrderItem } from "@rop/contracts";
import { buildStableItemKey } from "./normalize-order.js";

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord {
  return typeof value === "object" && value !== null ? (value as JsonRecord) : {};
}

function asString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function asNumber(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function timestampToIso(value: unknown) {
  if (typeof value === "number") {
    return new Date(value).toISOString();
  }
  if (typeof value === "string") {
    const asNumeric = Number(value);
    if (Number.isFinite(asNumeric)) {
      return new Date(asNumeric).toISOString();
    }

    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString();
    }
  }

  return new Date().toISOString();
}

function collectModifierNames(item: JsonRecord) {
  const buckets = [
    item.subItems,
    item.subProducts,
    item.modifiers,
    item.options
  ];

  const names = new Set<string>();
  for (const bucket of buckets) {
    const values = Array.isArray(bucket)
      ? bucket
      : Array.isArray(asRecord(bucket).items)
        ? (asRecord(bucket).items as unknown[])
        : [];

    for (const entry of values) {
      const record = asRecord(entry);
      const name = asString(record.name) ?? asString(record.productName) ?? asString(record.pluName);
      if (name) {
        names.add(name);
      }
    }
  }

  return [...names];
}

function lineItemsFromOrder(rawOrder: JsonRecord) {
  const candidates = [rawOrder.items, rawOrder.products, asRecord(rawOrder.cart).items];

  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      return candidate.map(asRecord);
    }
  }

  return [];
}

export function normalizeDeliverectOrder(rawOrder: JsonRecord, merchantId: string): NormalizedOrder {
  const sourceOrderId = asString(rawOrder._id) ?? asString(rawOrder.id) ?? crypto.randomUUID();
  const channelOrderId = asString(rawOrder.channelOrderId);
  const createdAt = timestampToIso(rawOrder.createdAt ?? rawOrder.created);
  const modifiedAt = timestampToIso(rawOrder.updatedAt ?? rawOrder.createdAt ?? rawOrder.created);
  const note = asString(rawOrder.note) ?? asString(rawOrder.remark) ?? asString(rawOrder.customerNote);
  const source = asString(rawOrder.channel) ?? asString(asRecord(rawOrder.channelLink).name) ?? "Deliverect";
  const orderType = asString(rawOrder.orderType) ?? asString(rawOrder.deliveryType) ?? asString(rawOrder.serviceType);

  const items: NormalizedOrderItem[] = lineItemsFromOrder(rawOrder).map((item, index) => {
    const normalizedItem = {
      cloverLineItemId: null,
      providerLineItemId: asString(item._id) ?? asString(item.id) ?? asString(item.lineId),
      itemId: asString(item.plu) ?? asString(item.productId) ?? asString(item.id),
      name: asString(item.name) ?? asString(item.productName) ?? asString(item.pluName) ?? "Unnamed item",
      alternateName: asString(item.nameNl) ?? asString(item.shortName),
      note: asString(item.note) ?? asString(item.remark),
      modifiers: collectModifierNames(item),
      quantity: Math.max(1, Math.trunc(asNumber(item.quantity) ?? 1)),
      priceCents: asNumber(item.price) ?? null,
      refunded: false,
      printed: false
    };

    return {
      ...normalizedItem,
      itemKey: buildStableItemKey(normalizedItem, index)
    };
  });

  const searchable = [note, source, orderType, channelOrderId].filter(Boolean).join(" ").toLowerCase();
  const priority = searchable.includes("rush") || searchable.includes("priority") ? 2 : 1;
  const orderLabel = channelOrderId ?? `#${sourceOrderId.slice(-6).toUpperCase()}`;

  return {
    provider: "deliverect",
    merchantId,
    orderId: `deliverect:${sourceOrderId}`,
    sourceOrderId,
    orderLabel,
    source,
    orderType,
    paymentState: null,
    note,
    priority,
    createdAt,
    modifiedAt,
    items,
    // Deliverect is a non-earning provider (no reliable payment signal); order
    // amounts are left null. Per-line priceCents is captured above when present.
    amounts: null,
    // 3rd-party delivery orders don't accrue loyalty (the customer belongs to
    // the aggregator, phone is often masked) → no attached customer.
    customer: null
  };
}
