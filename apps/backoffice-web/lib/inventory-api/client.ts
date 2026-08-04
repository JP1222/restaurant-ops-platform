import { cookies } from "next/headers";

import { getServerEnv } from "@/lib/env";
import { ACTIVE_LOCATION_COOKIE, ALL_STORES } from "@/lib/location/constants";
import type {
  InventoryAdHocReceive,
  InventoryCountSubmission,
  InventoryDataset,
  InventoryDepletionRunResult,
  InventoryEmployeeCreateRequest,
  InventoryEmployeeListResponse,
  InventoryEmployeePinResetRequest,
  InventoryEmployeeResponse,
  InventoryEmployeeUpdateRequest,
  InventoryItem,
  InventoryItemCreate,
  InventoryItemImageUpload,
  InventoryItemSave,
  InventoryItemPackSave,
  InventoryBarcodeResolve,
  InventoryBarcodeEnrich,
  InventoryBarcodeMintRequest,
  InventoryBarcodeMintResponse,
  InventoryBarcodeSave,
  InventoryParUpdate,
  InventoryReceiptListResponse,
  LaborCostSave,
  InventoryPoCancel,
  InventoryPurchaseOrderCreate,
  InventoryPurchaseOrderDetail,
  InventoryPurchaseOrderUpdate,
  InventoryReceiveSubmission,
  InventoryRecipeCreate,
  InventoryRecipeDetail,
  InventoryRecipeSave,
  InventorySecuritySettings,
  InventorySecuritySettingsSave,
  InventoryVendorSave,
  InventoryWasteSubmission
} from "@rop/contracts";

export class InventoryApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly bodyText: string,
    public readonly url: string,
    public readonly requestId?: string
  ) {
    super(`inventory-api ${status}: ${bodyText.slice(0, 200)}`);
    this.name = "InventoryApiError";
  }
}

export class InventoryApiNotConfiguredError extends Error {
  constructor(public readonly missing: string[]) {
    super(`inventory-api not configured (missing: ${missing.join(", ")})`);
    this.name = "InventoryApiNotConfiguredError";
  }
}

interface RequestOptions {
  signal?: AbortSignal;
  // Correlation id forwarded as `x-request-id`; inventory-api adopts it as its
  // request.id so this BFF call and the upstream logs share one id in Loki.
  // Generated per call when omitted.
  requestId?: string;
}

// The store the active backoffice session is managing, read from the
// StoreSwitcher's `yr_active_location` cookie. inventory-api scopes its
// store-level reads/writes by this `location` (locationFor() in
// routes/inventory.ts); without it every backoffice inventory call falls back to
// the single-store default (DEFAULT_LOCATION_ID), so a manager who selected
// store #2 would read/write store #1's stock. Returns null on the single-store
// path (no cookie) or "All stores", where the upstream default is the right
// scope. Server-only (BFF route scope), like every caller of `request`.
async function activeLocationParam(): Promise<string | null> {
  const value = (await cookies()).get(ACTIVE_LOCATION_COOKIE)?.value ?? null;
  return !value || value === ALL_STORES ? null : value;
}

async function request<T>(
  path: string,
  init: { method: "GET" | "POST" | "PATCH" | "PUT"; body?: unknown } = { method: "GET" },
  opts: RequestOptions = {}
): Promise<T> {
  const env = getServerEnv();
  if (!env.INTERNAL_INVENTORY_API_URL) {
    throw new InventoryApiNotConfiguredError(["INTERNAL_INVENTORY_API_URL"]);
  }

  const target = new URL(path, env.INTERNAL_INVENTORY_API_URL);
  const activeLocation = await activeLocationParam();
  if (activeLocation) {
    target.searchParams.set("location", activeLocation);
  }
  const url = target.toString();
  const requestId = opts.requestId ?? crypto.randomUUID();
  const headers: Record<string, string> = { Accept: "application/json", "x-request-id": requestId };
  // inventory-api requires the bearer for writes in production; reads are open.
  // Attach whenever it's configured so prod writes succeed and dev stays simple.
  if (env.INVENTORY_INTERNAL_TOKEN) {
    headers.Authorization = `Bearer ${env.INVENTORY_INTERNAL_TOKEN}`;
  }
  if (init.body !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  const res = await fetch(url, {
    method: init.method,
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: opts.signal,
    credentials: "omit",
    cache: "no-store"
  });

  if (!res.ok) {
    const bodyText = await res.text().catch(() => "");
    throw new InventoryApiError(res.status, bodyText, url, requestId);
  }

  return res.json() as Promise<T>;
}

// Like `request`, but for endpoints that answer 204 No Content (the item-image
// PUT/DELETE) — never parse the (empty) body, just surface a non-2xx as an error.
async function requestVoid(
  path: string,
  init: { method: "POST" | "PUT" | "DELETE"; body?: unknown },
  opts: RequestOptions = {}
): Promise<void> {
  const env = getServerEnv();
  if (!env.INTERNAL_INVENTORY_API_URL) {
    throw new InventoryApiNotConfiguredError(["INTERNAL_INVENTORY_API_URL"]);
  }
  const target = new URL(path, env.INTERNAL_INVENTORY_API_URL);
  const activeLocation = await activeLocationParam();
  if (activeLocation) {
    target.searchParams.set("location", activeLocation);
  }
  const url = target.toString();
  const requestId = opts.requestId ?? crypto.randomUUID();
  const headers: Record<string, string> = { "x-request-id": requestId };
  if (env.INVENTORY_INTERNAL_TOKEN) {
    headers.Authorization = `Bearer ${env.INVENTORY_INTERNAL_TOKEN}`;
  }
  if (init.body !== undefined) {
    headers["Content-Type"] = "application/json";
  }
  const res = await fetch(url, {
    method: init.method,
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: opts.signal,
    credentials: "omit",
    cache: "no-store"
  });
  if (!res.ok) {
    const bodyText = await res.text().catch(() => "");
    throw new InventoryApiError(res.status, bodyText, url, requestId);
  }
}

// Fetch an item's photo bytes from inventory-api for the BFF GET proxy. Returns the
// raw upstream Response (so the route can stream bytes + content-type straight
// through) rather than parsing JSON. The read is open upstream; the browser is gated
// by the backoffice session proxy before it ever reaches this route.
export async function fetchItemImageUpstream(
  id: string,
  opts: RequestOptions = {}
): Promise<Response> {
  const env = getServerEnv();
  if (!env.INTERNAL_INVENTORY_API_URL) {
    throw new InventoryApiNotConfiguredError(["INTERNAL_INVENTORY_API_URL"]);
  }
  const url = new URL(
    `/api/inventory/items/${encodeURIComponent(id)}/image`,
    env.INTERNAL_INVENTORY_API_URL
  ).toString();
  return fetch(url, { method: "GET", signal: opts.signal, cache: "no-store", credentials: "omit" });
}

// Fetch an archived receipt image (receipt-archive) for the BFF GET proxy — same
// stream-through pattern as the item photo: raw upstream Response, bytes + content-type
// passed straight on, browser gated by the backoffice session before reaching here.
export async function fetchReceiptImageUpstream(
  id: string,
  opts: RequestOptions = {}
): Promise<Response> {
  const env = getServerEnv();
  if (!env.INTERNAL_INVENTORY_API_URL) {
    throw new InventoryApiNotConfiguredError(["INTERNAL_INVENTORY_API_URL"]);
  }
  const url = new URL(
    `/api/inventory/receipts/${encodeURIComponent(id)}/image`,
    env.INTERNAL_INVENTORY_API_URL
  ).toString();
  return fetch(url, { method: "GET", signal: opts.signal, cache: "no-store", credentials: "omit" });
}

export const inventoryApi = {
  getDataset(opts: RequestOptions & { includeArchived?: boolean } = {}) {
    const path = opts.includeArchived ? "/api/inventory?include=archived" : "/api/inventory";
    return request<InventoryDataset>(path, { method: "GET" }, opts);
  },
  toggle86(id: string, opts: RequestOptions = {}) {
    return request<unknown>(
      `/api/inventory/items/${encodeURIComponent(id)}/toggle-86`,
      { method: "POST", body: { confirm: true } },
      opts
    );
  },
  createItem(body: InventoryItemCreate, opts: RequestOptions = {}) {
    return request<unknown>("/api/inventory/items", { method: "POST", body }, opts);
  },
  saveItem(id: string, body: InventoryItemSave, opts: RequestOptions = {}) {
    return request<unknown>(
      `/api/inventory/items/${encodeURIComponent(id)}`,
      { method: "PUT", body },
      opts
    );
  },
  uploadItemImage(id: string, body: InventoryItemImageUpload, opts: RequestOptions = {}) {
    return requestVoid(
      `/api/inventory/items/${encodeURIComponent(id)}/image`,
      { method: "PUT", body },
      opts
    );
  },
  deleteItemImage(id: string, opts: RequestOptions = {}) {
    return requestVoid(
      `/api/inventory/items/${encodeURIComponent(id)}/image`,
      { method: "DELETE" },
      opts
    );
  },
  updatePar(id: string, body: InventoryParUpdate, opts: RequestOptions = {}) {
    return request<unknown>(
      `/api/inventory/items/${encodeURIComponent(id)}/par`,
      { method: "PUT", body },
      opts
    );
  },
  // Packaging conversions (ADR-0737). create (no packId) or edit (packId); each returns the
  // fresh { item }. Delete answers with the item too, but the hook just refetches, so void.
  savePack(id: string, packId: string | undefined, body: InventoryItemPackSave, opts: RequestOptions = {}) {
    return request<{ item: InventoryItem }>(
      `/api/inventory/items/${encodeURIComponent(id)}/packs${packId ? `/${encodeURIComponent(packId)}` : ""}`,
      { method: packId ? "PUT" : "POST", body },
      opts
    );
  },
  deletePack(id: string, packId: string, opts: RequestOptions = {}) {
    return requestVoid(
      `/api/inventory/items/${encodeURIComponent(id)}/packs/${encodeURIComponent(packId)}`,
      { method: "DELETE" },
      opts
    );
  },
  saveBarcode(id: string, body: InventoryBarcodeSave, opts: RequestOptions = {}) {
    return request<{ item: InventoryItem }>(
      `/api/inventory/items/${encodeURIComponent(id)}/barcodes`,
      { method: "POST", body },
      opts
    );
  },
  deleteBarcode(id: string, code: string, opts: RequestOptions = {}) {
    return requestVoid(
      `/api/inventory/items/${encodeURIComponent(id)}/barcodes/${encodeURIComponent(code)}`,
      { method: "DELETE" },
      opts
    );
  },
  // Resolve a scanned/typed code to { item, pack } (ADR-0737). Returns null on a 404 so the
  // scan-to-register lookup treats "unknown code" as data (registered: false), not an error.
  async resolveBarcode(code: string, opts: RequestOptions = {}): Promise<InventoryBarcodeResolve | null> {
    try {
      return await request<InventoryBarcodeResolve>(
        `/api/inventory/barcode/${encodeURIComponent(code)}`,
        { method: "GET" },
        opts
      );
    } catch (error) {
      if (error instanceof InventoryApiError && error.status === 404) {
        return null;
      }
      throw error;
    }
  },
  // Scan-to-register lookup (barcode-onboarding ADR, D3): resolve a code against registered
  // barcodes, else enrich from the self-hosted Open Food Facts index. The upstream fails open
  // (always 200), so no 404 handling — an unknown code returns registered:false.
  barcodeLookup(upc: string, opts: RequestOptions = {}) {
    return request<InventoryBarcodeEnrich>(
      `/api/inventory/barcode/lookup/${encodeURIComponent(upc)}`,
      { method: "GET" },
      opts
    );
  },
  // Mint an internal house code for a no-UPC item (barcode-onboarding ADR, D4). Server generates
  // the YR-##### code; idempotent per (item, pack).
  mintBarcode(id: string, body: InventoryBarcodeMintRequest, opts: RequestOptions = {}) {
    return request<InventoryBarcodeMintResponse>(
      `/api/inventory/items/${encodeURIComponent(id)}/barcodes/mint`,
      { method: "POST", body },
      opts
    );
  },
  setArchived(id: string, archived: boolean, opts: RequestOptions = {}) {
    return request<unknown>(
      `/api/inventory/items/${encodeURIComponent(id)}/archive`,
      { method: "POST", body: { archived } },
      opts
    );
  },
  createVendor(body: InventoryVendorSave, opts: RequestOptions = {}) {
    return request<unknown>("/api/inventory/vendors", { method: "POST", body }, opts);
  },
  saveVendor(id: string, body: InventoryVendorSave, opts: RequestOptions = {}) {
    return request<unknown>(
      `/api/inventory/vendors/${encodeURIComponent(id)}`,
      { method: "PUT", body },
      opts
    );
  },
  setVendorArchived(id: string, archived: boolean, opts: RequestOptions = {}) {
    return request<unknown>(
      `/api/inventory/vendors/${encodeURIComponent(id)}/archive`,
      { method: "POST", body: { archived } },
      opts
    );
  },
  syncSales(opts: RequestOptions = {}) {
    return request<InventoryDepletionRunResult>(
      "/api/inventory/sync-sales",
      { method: "POST" },
      opts
    );
  },
  // Labor-cost editor write-source (ADR-0033 Phase 4b). Bearer-only manager config;
  // merchant_id is stamped server-side from inventory-api's configured store.
  saveLaborCost(body: LaborCostSave, opts: RequestOptions = {}) {
    return request<{
      labor_cost: {
        effective_from: string;
        daily_labor_cost_cents: number;
        currency: string;
        note: string | null;
      };
    }>("/api/admin/labor-costs", { method: "PUT", body }, opts);
  },
  applyCounts(body: InventoryCountSubmission, opts: RequestOptions = {}) {
    return request<unknown>("/api/inventory/counts", { method: "POST", body }, opts);
  },
  recordWaste(body: InventoryWasteSubmission, opts: RequestOptions = {}) {
    return request<unknown>("/api/inventory/waste", { method: "POST", body }, opts);
  },
  getPurchaseOrder(id: string, opts: RequestOptions = {}) {
    return request<InventoryPurchaseOrderDetail>(
      `/api/inventory/pos/${encodeURIComponent(id)}`,
      { method: "GET" },
      opts
    );
  },
  createPurchaseOrder(body: InventoryPurchaseOrderCreate, opts: RequestOptions = {}) {
    return request<unknown>("/api/inventory/pos", { method: "POST", body }, opts);
  },
  updatePurchaseOrder(id: string, body: InventoryPurchaseOrderUpdate, opts: RequestOptions = {}) {
    return request<unknown>(
      `/api/inventory/pos/${encodeURIComponent(id)}`,
      { method: "PUT", body },
      opts
    );
  },
  cancelPurchaseOrder(id: string, body: InventoryPoCancel = {}, opts: RequestOptions = {}) {
    return request<unknown>(
      `/api/inventory/pos/${encodeURIComponent(id)}/cancel`,
      { method: "POST", body },
      opts
    );
  },
  receivePurchaseOrder(id: string, body: InventoryReceiveSubmission, opts: RequestOptions = {}) {
    return request<unknown>(
      `/api/inventory/pos/${encodeURIComponent(id)}/receive`,
      { method: "POST", body },
      opts
    );
  },
  receiveAdHoc(body: InventoryAdHocReceive, opts: RequestOptions = {}) {
    return request<{ received: number; created: number }>(
      "/api/inventory/receive",
      { method: "POST", body },
      opts
    );
  },
  // Archived receipt scans for the Receiving "history" view (receipt-archive). Optional
  // from/to are opaque "YYYY-MM-DD" day bounds; omitted => the recent default window.
  getReceipts(opts: RequestOptions & { from?: string; to?: string } = {}) {
    const params = new URLSearchParams();
    if (opts.from) {
      params.set("from", opts.from);
    }
    if (opts.to) {
      params.set("to", opts.to);
    }
    const qs = params.toString();
    return request<InventoryReceiptListResponse>(
      `/api/inventory/receipts${qs ? `?${qs}` : ""}`,
      { method: "GET" },
      opts
    );
  },
  getRecipeDetail(id: string, opts: RequestOptions = {}) {
    return request<InventoryRecipeDetail>(
      `/api/inventory/recipes/${encodeURIComponent(id)}`,
      { method: "GET" },
      opts
    );
  },
  saveRecipe(id: string, body: InventoryRecipeSave, opts: RequestOptions = {}) {
    return request<InventoryRecipeDetail>(
      `/api/inventory/recipes/${encodeURIComponent(id)}`,
      { method: "PUT", body },
      opts
    );
  },
  createRecipe(body: InventoryRecipeCreate, opts: RequestOptions = {}) {
    return request<InventoryRecipeDetail>(
      "/api/inventory/recipes",
      { method: "POST", body },
      opts
    );
  },
  listCrew(opts: RequestOptions = {}) {
    return request<InventoryEmployeeListResponse>("/api/admin/crew", { method: "GET" }, opts);
  },
  createCrew(body: InventoryEmployeeCreateRequest, opts: RequestOptions = {}) {
    return request<InventoryEmployeeResponse>("/api/admin/crew", { method: "POST", body }, opts);
  },
  updateCrew(id: string, body: InventoryEmployeeUpdateRequest, opts: RequestOptions = {}) {
    return request<InventoryEmployeeResponse>(
      `/api/admin/crew/${encodeURIComponent(id)}`,
      { method: "PATCH", body },
      opts
    );
  },
  resetCrewPin(id: string, body: InventoryEmployeePinResetRequest, opts: RequestOptions = {}) {
    return request<InventoryEmployeeResponse>(
      `/api/admin/crew/${encodeURIComponent(id)}/pin`,
      { method: "POST", body },
      opts
    );
  },
  getCrewSecurity(opts: RequestOptions = {}) {
    return request<InventorySecuritySettings>("/api/admin/crew/security", { method: "GET" }, opts);
  },
  saveCrewSecurity(body: InventorySecuritySettingsSave, opts: RequestOptions = {}) {
    return request<InventorySecuritySettings>(
      "/api/admin/crew/security",
      { method: "PUT", body },
      opts
    );
  }
};
