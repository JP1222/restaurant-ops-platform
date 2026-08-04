import type { SquareEnvironment, SquareLocationSummary } from "@rop/contracts";
import {
  SquareClient as VendorSquareClient,
  SquareEnvironment as SquareSdkEnvironment,
  SquareError,
  SquareTimeoutError
} from "square";

import type { SquareCatalogObject } from "../domain/normalize-square-catalog.js";
import type { SquareOrder } from "../domain/normalize-square-order.js";

// The minimal surface of the vendor `square` client this integration uses. We
// validate a token that is NOT yet persisted, so the credential is supplied
// per-call (not at construction) via a factory. The factory is injectable so
// unit tests pass a fake without mocking the whole `square` module.
//
// `catalog.list` returns the SDK's auto-paginating Page (an AsyncIterable that
// fetches subsequent pages on demand); we model it structurally as an async
// iterable of catalog objects so a fake is a plain `async function*`.
export type SquareVendorClient = {
  locations: {
    list(): Promise<{
      locations?:
        | Array<{
            id?: string | null;
            name?: string | null;
            timezone?: string | null;
            currency?: string | null;
            merchantId?: string | null;
            status?: string | null;
          }>
        | null;
    }>;
  };
  merchants: {
    get(request: { merchantId: string }): Promise<{
      merchant?: { id?: string; businessName?: string | null };
    }>;
  };
  catalog: {
    list(request: { types: string }): Promise<AsyncIterable<SquareCatalogObject>>;
  };
  orders: {
    search(request: {
      locationIds: string[];
      cursor?: string;
      limit?: number;
      query?: {
        filter?: { dateTimeFilter?: { updatedAt?: { startAt?: string } } };
        sort?: { sortField: string; sortOrder: string };
      };
    }): Promise<{ orders?: SquareOrder[] | null; cursor?: string | null }>;
    get(request: { orderId: string }): Promise<{ order?: SquareOrder | null }>;
  };
};

export type SquareVendorFactory = (token: string, environment: SquareEnvironment) => SquareVendorClient;

// The Square-Version this integration is built + tested against. Pinning it keeps
// the SDK from silently shifting behavior on a Developer-Console default change
// (the v44 SDK only accepts this exact literal).
const SQUARE_API_VERSION = "2026-05-20" as const;

// The catalog object types the menu transform needs (items carry their variations
// embedded; modifier lists carry their modifiers embedded). Comma-separated per
// the ListCatalog `types` param.
const SQUARE_CATALOG_TYPES = "ITEM,MODIFIER_LIST,CATEGORY" as const;

// Defensive upper bound on objects pulled from one catalog. Square's own
// per-catalog ceiling is 10k objects, and a single merchant's menu is far
// smaller — exceeding this signals a pagination problem, so we fail LOUD rather
// than serve a silently-truncated menu.
const SQUARE_CATALOG_OBJECT_CAP = 10_000;

// Page size + a defensive total cap for an order-search poll window. One poll
// covers a short incremental window (orders updated since the last tick), so the
// real count is tiny; the cap is a runaway backstop (fail LOUD, never truncate).
const SQUARE_ORDER_PAGE_LIMIT = 200;
const SQUARE_ORDER_SEARCH_CAP = 5_000;

function defaultVendorFactory(token: string, environment: SquareEnvironment): SquareVendorClient {
  const client = new VendorSquareClient({
    token,
    environment: environment === "production" ? SquareSdkEnvironment.Production : SquareSdkEnvironment.Sandbox,
    version: SQUARE_API_VERSION
  });
  // The Fern client's list()/get() return HttpResponsePromise (awaitable to the
  // body), structurally compatible with our Promise-returning shape for `await`.
  return client as unknown as SquareVendorClient;
}

// A connect failure the routes translate to HTTP. Carries only a coarse reason
// (+ optional upstream status) — NEVER the token, NEVER the raw Square body.
export type SquareConnectErrorKind =
  | "invalid_token"
  | "insufficient_scope"
  | "timeout"
  | "no_locations"
  | "upstream";

export class SquareConnectError extends Error {
  constructor(
    readonly kind: SquareConnectErrorKind,
    readonly statusCode?: number
  ) {
    super(`square connect failed: ${kind}`);
    this.name = "SquareConnectError";
  }
}

function toConnectError(err: unknown): SquareConnectError {
  if (err instanceof SquareConnectError) {
    return err;
  }
  if (err instanceof SquareTimeoutError) {
    return new SquareConnectError("timeout");
  }
  if (err instanceof SquareError) {
    // 401 = bad token or token for the wrong environment (sandbox vs production);
    // 403 = token lacks MERCHANT_PROFILE_READ. Map by status, never echo the body.
    if (err.statusCode === 401) {
      return new SquareConnectError("invalid_token", 401);
    }
    if (err.statusCode === 403) {
      return new SquareConnectError("insufficient_scope", 403);
    }
    return new SquareConnectError("upstream", err.statusCode);
  }
  return new SquareConnectError("upstream");
}

export interface SquareConnectionInfo {
  merchantId: string;
  merchantName: string;
  locations: SquareLocationSummary[];
}

// Stateless: validates a Square access token by listing the seller's locations
// and merchant. The SINGLE source of truth backing both
// `/api/square/test-connection` (probe only) and `/api/square/connect` (which
// persists; PR4). It NEVER logs the token and never stringifies a Square payload.
export class SquareClient {
  private readonly makeVendor: SquareVendorFactory;

  constructor(vendorFactory: SquareVendorFactory = defaultVendorFactory) {
    this.makeVendor = vendorFactory;
  }

  async validateAndListLocations(token: string, environment: SquareEnvironment): Promise<SquareConnectionInfo> {
    const vendor = this.makeVendor(token, environment);

    let listResponse: Awaited<ReturnType<SquareVendorClient["locations"]["list"]>>;
    try {
      listResponse = await vendor.locations.list();
    } catch (err) {
      throw toConnectError(err);
    }

    // ACTIVE locations only (tolerate a missing status field). One Square token
    // maps to exactly one merchant, so merchantId rides on every location.
    const active = (listResponse.locations ?? []).filter((loc) => loc.status == null || loc.status === "ACTIVE");
    const merchantId = active.find((loc) => Boolean(loc.merchantId))?.merchantId ?? undefined;
    if (!merchantId || active.length === 0) {
      throw new SquareConnectError("no_locations");
    }

    let merchantName = "";
    try {
      const merchantResponse = await vendor.merchants.get({ merchantId });
      merchantName = merchantResponse.merchant?.businessName ?? "";
    } catch (err) {
      // The display name is cosmetic, but an auth/scope failure here is real (the
      // token can't read the merchant profile) — fail closed on those; otherwise
      // fall back to the merchant id as the name.
      const failure = toConnectError(err);
      if (failure.kind === "invalid_token" || failure.kind === "insufficient_scope") {
        throw failure;
      }
      // Non-auth failure: leave merchantName as "" so we fall back to the id below.
    }

    const locations: SquareLocationSummary[] = active.map((loc) => ({
      id: loc.id ?? "",
      name: loc.name ?? "",
      timezone: loc.timezone ?? "",
      currency: loc.currency ?? ""
    }));

    return { merchantId, merchantName: merchantName || merchantId, locations };
  }

  // Page the seller's full catalog (items + modifier lists + categories) into a
  // flat array for normalize-square-catalog. The SDK Page auto-fetches
  // subsequent pages as we iterate. Vendor errors map through toConnectError
  // (never echoing the token); an over-cap catalog throws LOUD (no silent
  // truncation). Used by the Phase-2 menu read + catalog-import paths.
  async fetchCatalog(token: string, environment: SquareEnvironment): Promise<SquareCatalogObject[]> {
    const vendor = this.makeVendor(token, environment);
    const objects: SquareCatalogObject[] = [];
    try {
      const page = await vendor.catalog.list({ types: SQUARE_CATALOG_TYPES });
      for await (const object of page) {
        objects.push(object);
        if (objects.length > SQUARE_CATALOG_OBJECT_CAP) {
          throw new Error(`square catalog exceeded ${SQUARE_CATALOG_OBJECT_CAP} objects`);
        }
      }
    } catch (err) {
      // A SquareError/timeout maps to a connect kind; the cap Error rethrows as-is
      // (it carries no token and surfaces as a 500 the import route logs).
      if (err instanceof SquareError || err instanceof SquareTimeoutError) {
        throw toConnectError(err);
      }
      throw err;
    }
    return objects;
  }

  // Poll a location's orders updated since `updatedSince` (ISO 8601), oldest
  // first. Square requires the sort field to MATCH the filtered field, so we
  // filter AND sort on UPDATED_AT. Pages until the cursor is exhausted; vendor
  // errors map through toConnectError (never echoes the token). Omitting
  // `updatedSince` returns all of the location's orders (bounded by the cap).
  async searchOrders(
    token: string,
    environment: SquareEnvironment,
    locationId: string,
    updatedSince?: string
  ): Promise<SquareOrder[]> {
    const vendor = this.makeVendor(token, environment);
    const orders: SquareOrder[] = [];
    try {
      let cursor: string | undefined;
      do {
        const response = await vendor.orders.search({
          locationIds: [locationId],
          limit: SQUARE_ORDER_PAGE_LIMIT,
          ...(cursor ? { cursor } : {}),
          query: {
            ...(updatedSince ? { filter: { dateTimeFilter: { updatedAt: { startAt: updatedSince } } } } : {}),
            sort: { sortField: "UPDATED_AT", sortOrder: "ASC" }
          }
        });
        for (const order of response.orders ?? []) {
          orders.push(order);
        }
        if (orders.length > SQUARE_ORDER_SEARCH_CAP) {
          throw new Error(`square order search exceeded ${SQUARE_ORDER_SEARCH_CAP} orders`);
        }
        cursor = response.cursor ?? undefined;
      } while (cursor);
    } catch (err) {
      if (err instanceof SquareError || err instanceof SquareTimeoutError) {
        throw toConnectError(err);
      }
      throw err;
    }
    return orders;
  }

  // Fetch a single order by id (the per-order re-fetch the sync job does, so a
  // ticket is always built from fresh data). Returns null when Square has no such
  // order; vendor errors map through toConnectError.
  async fetchOrder(
    token: string,
    environment: SquareEnvironment,
    orderId: string
  ): Promise<SquareOrder | null> {
    const vendor = this.makeVendor(token, environment);
    try {
      const response = await vendor.orders.get({ orderId });
      return response.order ?? null;
    } catch (err) {
      if (err instanceof SquareError || err instanceof SquareTimeoutError) {
        throw toConnectError(err);
      }
      throw err;
    }
  }
}
