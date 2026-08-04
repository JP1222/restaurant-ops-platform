import {
  SquareClient as VendorSquareClient,
  SquareEnvironment as SquareSdkEnvironment,
} from "square";

import type { JsonRecord } from "../types.js";

export type SquareEnvironment = "sandbox" | "production";

// The Square-Version this ingest is built + tested against (pinned so a Developer
// Console default change can't silently shift behavior; the v44 SDK only accepts
// this exact literal). Mirrors apps/kds-api/src/lib/square-client.ts.
const SQUARE_API_VERSION = "2026-05-20" as const;

// Page size + defensive per-sweep caps. A sweep covers a short incremental window
// (one store), so real counts are tiny; the caps are runaway backstops — we fail
// LOUD rather than silently truncate a window (which would corrupt the mart).
const PAGE_LIMIT = 200;
const ORDER_CAP = 10_000;
const PAYMENT_CAP = 20_000;
const REFUND_CAP = 20_000;

// The minimal vendor surface this ingest uses. orders.search is manual-cursor
// (returns one response page); payments.list / refunds.list return the SDK's
// auto-paginating Page (an AsyncIterable). Injectable so unit tests pass a fake
// without the real `square` module.
type OrderSearchRequest = {
  locationIds: string[];
  limit?: number;
  cursor?: string;
  query?: {
    filter?: { dateTimeFilter?: { updatedAt?: { startAt?: string } } };
    sort?: { sortField: string; sortOrder: string };
  };
};
type ListByLocationRequest = { locationId: string; beginTime?: string; sortOrder?: string };

export type SquareVendorClient = {
  orders: {
    search(request: OrderSearchRequest): Promise<{ orders?: JsonRecord[] | null; cursor?: string | null }>;
  };
  payments: {
    list(request: ListByLocationRequest): Promise<AsyncIterable<JsonRecord>>;
  };
  refunds: {
    list(request: ListByLocationRequest): Promise<AsyncIterable<JsonRecord>>;
  };
};

export type SquareVendorFactory = (token: string, environment: SquareEnvironment) => SquareVendorClient;

function defaultVendorFactory(token: string, environment: SquareEnvironment): SquareVendorClient {
  const client = new VendorSquareClient({
    token,
    environment: environment === "production" ? SquareSdkEnvironment.Production : SquareSdkEnvironment.Sandbox,
    version: SQUARE_API_VERSION,
  });
  return client as unknown as SquareVendorClient;
}

// Square `Money.amount` is a bigint in the v44 SDK. We PERSIST these payloads as
// jsonb, and `JSON.stringify` throws on bigint — so deep-coerce bigint→number
// (cents fit well under 2^53) BEFORE the payload leaves the client. This is the
// single boundary where a Square bigint is read; normalize-square (PR-D) then
// reads plain numbers. (kds-api keeps bigint because it passes the SDK object
// straight to its normalizer without persisting it; analytics differs.)
export function toJsonSafe(value: unknown): unknown {
  if (typeof value === "bigint") {
    return Number(value);
  }
  if (Array.isArray(value)) {
    return value.map(toJsonSafe);
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      out[key] = toJsonSafe(val);
    }
    return out;
  }
  return value;
}

// Read-only Square ingest client for ONE store (location), built per-merchant by
// SquareClientFactory. Returns raw, JSON-safe payloads for the raw.square_*
// landing tables — it does NOT normalize (that's PR-D).
export class SquareClient {
  constructor(
    private readonly locationId: string,
    private readonly vendor: SquareVendorClient
  ) {}

  // Orders updated since `since`, oldest first. Square requires the sort field to
  // match the filtered field, so we filter AND sort on UPDATED_AT (mirrors the
  // kds-api poll). The caller applies the overlap window (eventual consistency).
  async listOrders(since: Date): Promise<JsonRecord[]> {
    const out: JsonRecord[] = [];
    let cursor: string | undefined;
    do {
      const response = await this.vendor.orders.search({
        locationIds: [this.locationId],
        limit: PAGE_LIMIT,
        ...(cursor ? { cursor } : {}),
        query: {
          filter: { dateTimeFilter: { updatedAt: { startAt: since.toISOString() } } },
          sort: { sortField: "UPDATED_AT", sortOrder: "ASC" },
        },
      });
      for (const order of response.orders ?? []) {
        out.push(toJsonSafe(order) as JsonRecord);
      }
      if (out.length > ORDER_CAP) {
        throw new Error(`square order search exceeded ${ORDER_CAP} orders for ${this.locationId}`);
      }
      cursor = response.cursor ?? undefined;
    } while (cursor);
    return out;
  }

  // Payments created since `since` (the SDK Page auto-paginates).
  async listPayments(since: Date): Promise<JsonRecord[]> {
    const out: JsonRecord[] = [];
    const page = await this.vendor.payments.list({
      locationId: this.locationId,
      beginTime: since.toISOString(),
      sortOrder: "ASC",
    });
    for await (const payment of page) {
      out.push(toJsonSafe(payment) as JsonRecord);
      if (out.length > PAYMENT_CAP) {
        throw new Error(`square payment list exceeded ${PAYMENT_CAP} payments for ${this.locationId}`);
      }
    }
    return out;
  }

  // Refunds created since `since`.
  async listRefunds(since: Date): Promise<JsonRecord[]> {
    const out: JsonRecord[] = [];
    const page = await this.vendor.refunds.list({
      locationId: this.locationId,
      beginTime: since.toISOString(),
      sortOrder: "ASC",
    });
    for await (const refund of page) {
      out.push(toJsonSafe(refund) as JsonRecord);
      if (out.length > REFUND_CAP) {
        throw new Error(`square refund list exceeded ${REFUND_CAP} refunds for ${this.locationId}`);
      }
    }
    return out;
  }
}

export { defaultVendorFactory };
