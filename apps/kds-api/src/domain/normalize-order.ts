import type { NormalizedOrder, NormalizedOrderItem } from "@rop/contracts";

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
  if (typeof value === "string" && value.trim().length > 0) {
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
    const asNumberValue = Number(value);
    if (Number.isFinite(asNumberValue)) {
      return new Date(asNumberValue).toISOString();
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
    asRecord(item.modifications).elements,
    asRecord(item.modifiers).elements,
    item.modifications,
    item.modifiers
  ];

  const names = new Set<string>();
  for (const bucket of buckets) {
    const values = Array.isArray(bucket) ? bucket : Array.isArray(asRecord(bucket).elements) ? (asRecord(bucket).elements as unknown[]) : [];
    for (const entry of values) {
      const record = asRecord(entry);
      const modifierName = asString(record.name) ?? asString(asRecord(record.modifier).name);
      if (modifierName) {
        names.add(modifierName);
      }
    }
  }
  return [...names];
}

function lineItemsFromOrder(rawOrder: JsonRecord) {
  const lineItems = rawOrder.lineItems;
  if (Array.isArray(lineItems)) {
    return lineItems.map(asRecord);
  }

  const expanded = asRecord(lineItems).elements;
  if (Array.isArray(expanded)) {
    return expanded.map(asRecord);
  }

  return [];
}

// The order's attached customer, for loyalty accrual. Clover nests it as
// order.customers.elements[0] with phoneNumbers.elements[0].phoneNumber — and
// only when the fetch used `expand=customers.phoneNumbers` (plain
// `expand=customers` returns phoneNumbers: []). Returns null for anonymous /
// in-store orders (no customer, or neither phone nor name) → no accrual.
function extractCustomer(rawOrder: JsonRecord): NormalizedOrder["customer"] {
  const customers = asRecord(rawOrder.customers).elements;
  const first = Array.isArray(customers) && customers.length > 0 ? asRecord(customers[0]) : null;
  if (!first) {
    return null;
  }
  const phones = asRecord(first.phoneNumbers).elements;
  const firstPhone = Array.isArray(phones) && phones.length > 0 ? asRecord(phones[0]) : {};
  const phone = asString(firstPhone.phoneNumber);
  const name = asString(first.firstName) ?? asString(first.name);
  if (!phone && !name) {
    return null;
  }
  return { phone, name };
}

export function buildStableItemKey(item: {
  providerLineItemId: string | null;
  cloverLineItemId: string | null;
  itemId: string | null;
  name: string;
  note: string | null;
  modifiers: string[];
}, index: number) {
  const explicitId = item.providerLineItemId ?? item.cloverLineItemId;
  if (explicitId) {
    return explicitId;
  }

  if (item.itemId) {
    return `${item.itemId}:${index}`;
  }

  const signature = [
    item.name.trim().toLowerCase(),
    item.note?.trim().toLowerCase() ?? "",
    ...item.modifiers.map((modifier) => modifier.trim().toLowerCase())
  ].join("|");

  return `${signature}:${index}`;
}

export function normalizeOrder(rawOrder: JsonRecord, merchantId: string): NormalizedOrder {
  const orderId = asString(rawOrder.id) ?? crypto.randomUUID();
  const createdAt = timestampToIso(rawOrder.clientCreatedTime ?? rawOrder.createdTime);
  const modifiedAt = timestampToIso(rawOrder.modifiedTime ?? rawOrder.clientCreatedTime ?? rawOrder.createdTime);
  const note = asString(rawOrder.note) ?? asString(rawOrder.customerNote);
  const source = asString(rawOrder.source) ?? asString(asRecord(rawOrder.device).name);
  const orderType = asString(asRecord(rawOrder.orderType).label) ?? asString(asRecord(rawOrder.orderType).name);
  const paymentState = asString(rawOrder.paymentState) ?? asString(rawOrder.state);
  const customer = extractCustomer(rawOrder);

  const items: NormalizedOrderItem[] = lineItemsFromOrder(rawOrder).map((item, index) => {
    const normalizedItem = {
      cloverLineItemId: asString(item.id),
      providerLineItemId: asString(item.id),
      itemId: asString(asRecord(item.item).id),
      name: asString(item.name) ?? "Unnamed item",
      alternateName: asString(item.alternateName),
      note: asString(item.note),
      modifiers: collectModifierNames(item),
      quantity: Math.max(1, Math.round((asNumber(item.unitQty) ?? 1000) / 1000)),
      // Clover line `price` is the charged amount in cents (the dominant qty-1
      // case for a dessert shop). Null when the provider omits it.
      priceCents: asNumber(item.price) ?? null,
      refunded: Boolean(item.refunded),
      printed: Boolean(item.printed)
    };

    return {
      ...normalizedItem,
      itemKey: buildStableItemKey(normalizedItem, index)
    };
  });

  const sourceText = [note, source, orderType, paymentState].filter(Boolean).join(" ").toLowerCase();
  const priority = note || sourceText.includes("rush") || sourceText.includes("delivery") ? 2 : 1;
  const displayCode = asString(rawOrder.displayCode) ?? asString(rawOrder.title) ?? asString(rawOrder.orderNumber);
  const orderLabel = displayCode ? `#${displayCode.replace(/^#/, "")}` : `#${orderId.slice(-6).toUpperCase()}`;

  // Order-level money for audit + the loyalty liability dashboard. Subtotal is
  // summed from line prices; total comes from Clover; tax is the rough remainder
  // (Clover doesn't surface a reliable order-level tax field); tip lives on
  // payments, not the order. The accrual basis is recomputed from eligible line
  // prices, NOT from these — so a soft tax estimate here is harmless.
  const subtotalCents = items.reduce<number | null>(
    (sum, item) => (item.priceCents === null ? sum : (sum ?? 0) + item.priceCents),
    null
  );
  const totalCents = asNumber(rawOrder.total) ?? null;
  const taxCents =
    totalCents !== null && subtotalCents !== null ? Math.max(0, totalCents - subtotalCents) : null;
  const amounts = {
    subtotalCents,
    taxCents,
    tipCents: null,
    totalCents,
    currency: asString(rawOrder.currency) ?? "USD"
  };

  return {
    provider: "clover",
    merchantId,
    orderId,
    sourceOrderId: orderId,
    orderLabel,
    source,
    orderType,
    paymentState,
    note,
    priority,
    createdAt,
    modifiedAt,
    items,
    amounts,
    customer
  };
}

export function buildSearchText(order: NormalizedOrder) {
  return [
    order.orderLabel,
    order.note,
    order.orderType,
    order.source,
    order.paymentState,
    ...order.items.flatMap((item) => [item.name, item.alternateName, item.note, ...item.modifiers])
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}
