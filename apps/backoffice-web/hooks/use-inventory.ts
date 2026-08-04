"use client";

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useIdempotencyKey } from "./use-idempotency-key";
import type {
  InventoryAdHocReceive,
  InventoryDataset,
  InventoryDepletionRunResult,
  InventoryEmojiSuggestRequest,
  InventoryEmojiSuggestResult,
  InventoryItem,
  InventoryItemCreate,
  InventoryItemSave,
  InventoryItemPackSave,
  InventoryBarcodeEnrich,
  InventoryBarcodeMintRequest,
  InventoryBarcodeMintResponse,
  InventoryBarcodeSave,
  InventoryBarcodeSource,
  InventoryPurchaseOrderCreate,
  InventoryPurchaseOrderDetail,
  InventoryPurchaseOrderUpdate,
  InventoryMatchSuggestRequest,
  InventoryMatchSuggestResult,
  InventoryReceiptListResponse,
  InventoryReceiptParseResult,
  InventoryRecipeCreate,
  InventoryRecipeDetail,
  InventoryVendor,
  InventoryVendorSave,
  InventoryWasteReasonId
} from "@rop/contracts";

export interface WasteSubmission {
  sku: string;
  qty: number;
  reason: InventoryWasteReasonId;
  notes: string;
  photo: boolean;
  cost_cents: number;
}

export interface UseInventoryReturn {
  data: InventoryDataset | undefined;
  isLoading: boolean;
  isError: boolean;
  toggle86: (id: string) => void;
  applyCountAdjustments: (updates: Record<string, number>) => void;
  recordWaste: (entry: WasteSubmission) => void;
  saveItem: (id: string, body: InventoryItemSave) => void;
  updatePar: (id: string, parMin: number, parMax: number) => void;
  archiveItem: (id: string, archived: boolean) => void;
  syncSales: () => Promise<InventoryDepletionRunResult>;
  isSyncing: boolean;
}

const QUERY_KEY = ["inventory"] as const;
const ARCHIVED_QUERY_KEY = ["inventory", "archived"] as const;
const ARCHIVED_VENDORS_QUERY_KEY = ["inventory", "archived-vendors"] as const;
const RECEIPTS_QUERY_KEY = ["inventory", "receipts"] as const;
const STALE_MS = 60_000;

// Non-2xx from a BFF route. Carries the HTTP status and the machine-readable
// `error` code from the JSON body (e.g. "vision_timeout") so consumers can branch
// on WHAT failed; the message keeps the old `url status: body` shape that the
// generic error alerts already display.
export class InventoryApiError extends Error {
  readonly status: number;
  readonly code: string | undefined;

  constructor(url: string, status: number, body: string) {
    super(`${url} ${status}: ${body.slice(0, 200)}`);
    this.name = "InventoryApiError";
    this.status = status;
    this.code = extractErrorCode(body);
  }
}

function extractErrorCode(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as { error?: unknown };
    return typeof parsed.error === "string" ? parsed.error : undefined;
  } catch {
    return undefined;
  }
}

// The vision parse exceeded its server-side deadline (504 vision_timeout from the
// receipt-parse route). Also matches a bare infra 504 (gateway timeout, non-JSON
// body) since the right user guidance — try the scan again — is the same.
export function isVisionTimeout(error: unknown): boolean {
  return (
    error instanceof InventoryApiError &&
    (error.code === "vision_timeout" || error.status === 504)
  );
}

async function fetchJson<T>(url: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, {
    credentials: "include",
    ...init,
    headers: {
      Accept: "application/json",
      ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...init.headers
    }
  });

  if (response.status === 401) {
    throw new Error("unauthenticated");
  }
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new InventoryApiError(url, response.status, body);
  }
  return response.json() as Promise<T>;
}

export function useInventory(): UseInventoryReturn {
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: QUERY_KEY,
    queryFn: () => fetchJson<InventoryDataset>("/api/inventory"),
    staleTime: STALE_MS,
    refetchInterval: STALE_MS
  });

  const invalidate = React.useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: QUERY_KEY });
  }, [queryClient]);

  // One idempotency key per stock-moving mutation, minted from the submission's content
  // and held across re-taps so a retried POST after a failed/lost response dedups
  // server-side (PR #519). Reset on success so the NEXT submission — even an identical
  // one — starts fresh. See hooks/use-idempotency-key.ts.
  const countKey = useIdempotencyKey();
  const wasteKey = useIdempotencyKey();

  const toggle86Mutation = useMutation({
    mutationFn: (id: string) =>
      fetchJson(`/api/inventory/items/${encodeURIComponent(id)}/toggle-86`, { method: "POST" }),
    onSuccess: invalidate
  });

  // `who` is intentionally omitted: the BFF derives the actor from the session
  // (see app/api/inventory/{counts,waste}/route.ts) and overrides any body value.
  // `idempotency_key` rides in the body so a re-tap reuses it; a count is an absolute
  // set so a deduped retry is harmless, but it shares the same guard for consistency.
  const countMutation = useMutation({
    mutationFn: (body: { updates: Record<string, number> }) =>
      fetchJson("/api/inventory/counts", {
        method: "POST",
        body: JSON.stringify({ ...body, idempotency_key: countKey.keyFor(JSON.stringify(body)) })
      }),
    onSuccess: () => {
      countKey.reset();
      invalidate();
    }
  });

  const wasteMutation = useMutation({
    mutationFn: (body: WasteSubmission) =>
      fetchJson("/api/inventory/waste", {
        method: "POST",
        body: JSON.stringify({ ...body, idempotency_key: wasteKey.keyFor(JSON.stringify(body)) })
      }),
    onSuccess: () => {
      wasteKey.reset();
      invalidate();
    }
  });

  // Catalog edit (S3): name/unit/vendor/shelf + the purchase->usage conversion.
  // The inventory-api re-derives cost_cents; we just invalidate to refetch.
  const saveItemMutation = useMutation({
    mutationFn: ({ id, body }: { id: string; body: InventoryItemSave }) =>
      fetchJson(`/api/inventory/items/${encodeURIComponent(id)}`, {
        method: "PUT",
        body: JSON.stringify(body)
      }),
    onSuccess: invalidate
  });

  // Par edit (catalog D1): writes the per-location state row (inventory-api routes
  // par away from the brand-catalog columns), distinct from the cost editor above.
  const updateParMutation = useMutation({
    mutationFn: ({ id, par_min, par_max }: { id: string; par_min: number; par_max: number }) =>
      fetchJson(`/api/inventory/items/${encodeURIComponent(id)}/par`, {
        method: "PUT",
        body: JSON.stringify({ par_min, par_max })
      }),
    onSuccess: invalidate
  });

  // Archive / restore (catalog D1, soft-delete): archived items leave the active
  // dataset, so invalidate BOTH the active query and the archived-list query.
  const archiveMutation = useMutation({
    mutationFn: ({ id, archived }: { id: string; archived: boolean }) =>
      fetchJson(`/api/inventory/items/${encodeURIComponent(id)}/archive`, {
        method: "POST",
        body: JSON.stringify({ archived })
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: QUERY_KEY });
      void queryClient.invalidateQueries({ queryKey: ARCHIVED_QUERY_KEY });
    }
  });

  // Manual "Sync sales" (S4b): pull recent Clover sales from analytics and deplete
  // their BOMs once. mutateAsync so the button can toast the applied/unmatched result.
  const syncSalesMutation = useMutation({
    mutationFn: () =>
      fetchJson<InventoryDepletionRunResult>("/api/inventory/sync-sales", { method: "POST" }),
    onSuccess: invalidate
  });

  const toggle86 = React.useCallback(
    (id: string) => toggle86Mutation.mutate(id),
    [toggle86Mutation]
  );
  const applyCountAdjustments = React.useCallback(
    (updates: Record<string, number>) => countMutation.mutate({ updates }),
    [countMutation]
  );
  const recordWaste = React.useCallback(
    (entry: WasteSubmission) => wasteMutation.mutate(entry),
    [wasteMutation]
  );
  const saveItem = React.useCallback(
    (id: string, body: InventoryItemSave) => saveItemMutation.mutate({ id, body }),
    [saveItemMutation]
  );
  const updatePar = React.useCallback(
    (id: string, parMin: number, parMax: number) =>
      updateParMutation.mutate({ id, par_min: parMin, par_max: parMax }),
    [updateParMutation]
  );
  const archiveItem = React.useCallback(
    (id: string, archived: boolean) => archiveMutation.mutate({ id, archived }),
    [archiveMutation]
  );
  const syncSales = React.useCallback(
    () => syncSalesMutation.mutateAsync(),
    [syncSalesMutation]
  );

  return {
    data: query.data,
    isLoading: query.isLoading,
    isError: query.isError,
    toggle86,
    applyCountAdjustments,
    recordWaste,
    saveItem,
    updatePar,
    archiveItem,
    syncSales,
    isSyncing: syncSalesMutation.isPending
  };
}

// Item photo upload / removal (floor + backoffice item icon). Reuses the existing
// inventory-api image endpoints via the BFF; on success invalidate the dataset so the
// new `has_image` flag (and thus the thumbnail) refreshes. Keyed by item id so the
// icon control can call it directly (rule 10: data access via a use-*.ts hook).
export interface ItemImageInput {
  contentType: string;
  dataBase64: string;
}

export function useItemImage(id: string) {
  const queryClient = useQueryClient();
  const invalidate = () => void queryClient.invalidateQueries({ queryKey: QUERY_KEY });

  const uploadMutation = useMutation({
    mutationFn: (img: ItemImageInput) =>
      fetchJson(`/api/inventory/items/${encodeURIComponent(id)}/image`, {
        method: "PUT",
        body: JSON.stringify({ content_type: img.contentType, data_base64: img.dataBase64 })
      }),
    onSuccess: invalidate
  });
  const removeMutation = useMutation({
    mutationFn: () =>
      fetchJson(`/api/inventory/items/${encodeURIComponent(id)}/image`, { method: "DELETE" }),
    onSuccess: invalidate
  });

  const upload = React.useCallback(
    (img: ItemImageInput) => uploadMutation.mutateAsync(img),
    [uploadMutation]
  );
  const remove = React.useCallback(() => removeMutation.mutateAsync(), [removeMutation]);
  return { upload, remove, isPending: uploadMutation.isPending || removeMutation.isPending };
}

// Pack + barcode editor for one item (ADR-0737), keyed by item id like useItemImage.
// Each mutation hits the BFF CRUD route and invalidates the dataset so the item's
// packs[]/barcodes[] refresh. mutateAsync so the UI can await + surface a 409 (duplicate
// pack label) or 400 (unknown pack) to the operator.
export function useItemPackEditor(id: string) {
  const queryClient = useQueryClient();
  const invalidate = () => void queryClient.invalidateQueries({ queryKey: QUERY_KEY });

  const savePackMutation = useMutation({
    mutationFn: ({ packId, body }: { packId?: string; body: InventoryItemPackSave }) =>
      fetchJson(
        `/api/inventory/items/${encodeURIComponent(id)}/packs${packId ? `/${encodeURIComponent(packId)}` : ""}`,
        { method: packId ? "PUT" : "POST", body: JSON.stringify(body) }
      ),
    onSuccess: invalidate
  });
  const deletePackMutation = useMutation({
    mutationFn: (packId: string) =>
      fetchJson(`/api/inventory/items/${encodeURIComponent(id)}/packs/${encodeURIComponent(packId)}`, {
        method: "DELETE"
      }),
    onSuccess: invalidate
  });
  const saveBarcodeMutation = useMutation({
    mutationFn: (body: InventoryBarcodeSave) =>
      fetchJson(`/api/inventory/items/${encodeURIComponent(id)}/barcodes`, {
        method: "POST",
        body: JSON.stringify(body)
      }),
    onSuccess: invalidate
  });
  const deleteBarcodeMutation = useMutation({
    mutationFn: (code: string) =>
      fetchJson(`/api/inventory/items/${encodeURIComponent(id)}/barcodes/${encodeURIComponent(code)}`, {
        method: "DELETE"
      }),
    onSuccess: invalidate
  });

  const savePack = React.useCallback(
    (body: InventoryItemPackSave, packId?: string) => savePackMutation.mutateAsync({ packId, body }),
    [savePackMutation]
  );
  const deletePack = React.useCallback(
    (packId: string) => deletePackMutation.mutateAsync(packId),
    [deletePackMutation]
  );
  const saveBarcode = React.useCallback(
    (body: InventoryBarcodeSave) => saveBarcodeMutation.mutateAsync(body),
    [saveBarcodeMutation]
  );
  const deleteBarcode = React.useCallback(
    (code: string) => deleteBarcodeMutation.mutateAsync(code),
    [deleteBarcodeMutation]
  );

  return {
    savePack,
    deletePack,
    saveBarcode,
    deleteBarcode,
    isSaving: savePackMutation.isPending || saveBarcodeMutation.isPending,
    isDeleting: deletePackMutation.isPending || deleteBarcodeMutation.isPending
  };
}

// Scan-to-register lookup (barcode-onboarding ADR, D3): resolve a scanned/typed UPC to either an
// already-registered item or (Phase 2) OFF auto-fill suggestions. Enabled only when a code is
// present; cached briefly so re-opening the same scan in the register loop doesn't refetch.
export function useBarcodeLookup(upc: string | null) {
  return useQuery({
    queryKey: ["inventory", "barcode-lookup", upc] as const,
    queryFn: () =>
      fetchJson<InventoryBarcodeEnrich>(`/api/inventory/barcode/lookup/${encodeURIComponent(upc ?? "")}`),
    enabled: !!upc,
    staleTime: 5 * 60_000
  });
}

export interface ScanRegisterInput {
  // Attach the scanned code to this existing item (anti-duplicate path) — skips create + pack.
  existingItemId?: string;
  // Otherwise create a new item from these fields.
  item?: InventoryItemCreate;
  // Optional pack to create and map the barcode to (a case UPC vs an each UPC).
  pack?: InventoryItemPackSave;
  barcode: { code: string; source: InventoryBarcodeSource };
}

// Scan-to-register save chain (barcode-onboarding ADR, D2): create the item (or attach to an
// existing one), optionally create the pack the code maps to, then register the barcode. Each
// step reuses the shipped ADR-0737 write endpoints; the new pack's id is read back from the
// pack-save response so the barcode maps to the exact pack. One mutation so the sheet can await
// it and surface a partial failure (e.g. a 409 duplicate code) to the manager.
export function useScanRegisterSave() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: ScanRegisterInput): Promise<InventoryItem> => {
      let itemId: string;
      let packId: string | undefined;
      if (input.existingItemId) {
        itemId = input.existingItemId;
      } else if (input.item) {
        const created = await fetchJson<{ item: InventoryItem }>("/api/inventory/items", {
          method: "POST",
          body: JSON.stringify(input.item)
        });
        itemId = created.item.id;
        if (input.pack) {
          const afterPack = await fetchJson<{ item: InventoryItem }>(
            `/api/inventory/items/${encodeURIComponent(itemId)}/packs`,
            { method: "POST", body: JSON.stringify(input.pack) }
          );
          packId = afterPack.item.packs?.find((p) => p.label === input.pack?.label)?.id;
        }
      } else {
        throw new Error("scan-register requires an existing item or new-item fields");
      }
      const registered = await fetchJson<{ item: InventoryItem }>(
        `/api/inventory/items/${encodeURIComponent(itemId)}/barcodes`,
        {
          method: "POST",
          body: JSON.stringify({ code: input.barcode.code, pack_id: packId ?? null, source: input.barcode.source })
        }
      );
      return registered.item;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: QUERY_KEY });
    }
  });
}

// Book a receive immediately after scan-to-register (barcode-onboarding ADR, P4): the manager
// enters the delivered quantity for the just-created item, so a Sam's haul goes 0 -> on_hand in
// one motion. `who` is added server-side by the BFF (never client-supplied); the client supplies
// an idempotency key so a re-tap dedups. Reuses the same POST /api/inventory/receive path the
// floor receive uses. Invalidates the dataset so the item's on_hand updates at once.
export function useScanReceiveAdHoc() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: Omit<InventoryAdHocReceive, "who">) =>
      fetchJson("/api/inventory/receive", { method: "POST", body: JSON.stringify(body) }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: QUERY_KEY });
    }
  });
}

// Mint an internal house code for a no-UPC item (barcode-onboarding ADR, D4): cups/straws get a
// printed YR-##### Code128 label. Idempotent server-side; returns the item + code so the caller
// can open the print dialog. Invalidates the dataset so the new barcode shows on the item.
export function useMintBarcode(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: InventoryBarcodeMintRequest = {}) =>
      fetchJson<InventoryBarcodeMintResponse>(
        `/api/inventory/items/${encodeURIComponent(id)}/barcodes/mint`,
        { method: "POST", body: JSON.stringify(body) }
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: QUERY_KEY });
    }
  });
}

// Create a catalog item (catalog D1, "Add item"). Standalone mutation hook used by
// the AddItemDialog; invalidates the active dataset so the new SKU appears at once.
export function useCreateItem() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: InventoryItemCreate) =>
      fetchJson("/api/inventory/items", { method: "POST", body: JSON.stringify(body) }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: QUERY_KEY });
    }
  });
}

// Archived items for the Items tab "Archived" filter (catalog D1). A separate,
// lazily-enabled query so soft-deleted items never enter the active dataset that
// feeds KPIs/counts/waste — they're fetched only when the operator asks to see them.
export function useArchivedItems(enabled: boolean) {
  return useQuery<InventoryItem[]>({
    queryKey: ARCHIVED_QUERY_KEY,
    queryFn: async () => {
      const dataset = await fetchJson<InventoryDataset>("/api/inventory?include=archived");
      return dataset.items.filter((it) => it.archived);
    },
    enabled,
    staleTime: STALE_MS
  });
}

// Vendor create / edit / archive (catalog D2). Standalone mutation hooks used by the
// VendorDialog + vendor detail sheet; each invalidates the active dataset so the change
// shows at once. Archive also refreshes the archived-vendors list.
export function useCreateVendor() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: InventoryVendorSave) =>
      fetchJson("/api/inventory/vendors", { method: "POST", body: JSON.stringify(body) }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: QUERY_KEY });
    }
  });
}

export function useSaveVendor() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: InventoryVendorSave }) =>
      fetchJson(`/api/inventory/vendors/${encodeURIComponent(id)}`, {
        method: "PUT",
        body: JSON.stringify(body)
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: QUERY_KEY });
    }
  });
}

export function useArchiveVendor() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, archived }: { id: string; archived: boolean }) =>
      fetchJson(`/api/inventory/vendors/${encodeURIComponent(id)}/archive`, {
        method: "POST",
        body: JSON.stringify({ archived })
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: QUERY_KEY });
      void queryClient.invalidateQueries({ queryKey: ARCHIVED_VENDORS_QUERY_KEY });
    }
  });
}

// Create a purchase order (catalog D3, "New PO"). Invalidates the active dataset so
// the new PO shows in Receiving at once.
export function useCreatePurchaseOrder() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: InventoryPurchaseOrderCreate) =>
      fetchJson("/api/inventory/pos", { method: "POST", body: JSON.stringify(body) }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: QUERY_KEY });
    }
  });
}

// The PO was received or cancelled out from under the editor (409 from the BFF).
// The UI re-fetches and tells the operator instead of showing a generic failure.
export function isPoNotEditable(error: unknown): boolean {
  return error instanceof InventoryApiError && error.code === "po_not_editable";
}

// PO line detail for the edit drawer — fetched lazily when the drawer opens
// (`enabled`), since the dataset only carries a line count. Never cached stale:
// an edit/cancel/receive invalidates the whole inventory dataset, and this keyed
// query is short-lived (the drawer unmounts on close).
export function usePurchaseOrderDetail(id: string | null) {
  return useQuery({
    queryKey: [...QUERY_KEY, "po", id],
    queryFn: () => fetchJson<InventoryPurchaseOrderDetail>(`/api/inventory/pos/${encodeURIComponent(id as string)}`),
    enabled: id !== null,
    staleTime: 0,
    gcTime: 0
  });
}

// Edit an open PO (2026-06-12 audit P1). Full replace of vendor/expected/lines.
export function useUpdatePurchaseOrder() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: InventoryPurchaseOrderUpdate }) =>
      fetchJson(`/api/inventory/pos/${encodeURIComponent(id)}`, {
        method: "PUT",
        body: JSON.stringify(body)
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: QUERY_KEY });
    }
  });
}

// Cancel an open PO (2026-06-12 audit P1). Idempotent upstream.
export function useCancelPurchaseOrder() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      fetchJson(`/api/inventory/pos/${encodeURIComponent(id)}/cancel`, { method: "POST" }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: QUERY_KEY });
    }
  });
}

export function useArchivedVendors(enabled: boolean) {
  return useQuery<InventoryVendor[]>({
    queryKey: ARCHIVED_VENDORS_QUERY_KEY,
    queryFn: async () => {
      const dataset = await fetchJson<InventoryDataset>("/api/inventory?include=archived");
      return dataset.vendors.filter((v) => v.archived);
    },
    enabled,
    staleTime: STALE_MS
  });
}

// Read-only inventory dataset, gated by `enabled` and with no polling. Used by
// the AI assistant's receipt flow (matching + on-hand deltas) so it only fetches
// while the panel is open. Shares QUERY_KEY with useInventory, so a confirmed
// receive (useAdHocReceive) invalidates and refreshes both.
export function useInventoryDataset(enabled: boolean) {
  return useQuery({
    queryKey: QUERY_KEY,
    queryFn: () => fetchJson<InventoryDataset>("/api/inventory"),
    staleTime: STALE_MS,
    enabled
  });
}

// Invoice-scan (ADR-0538). useReceiptParse runs an image through the vision BFF and
// returns the extracted lines — no cache write (it's an extraction, not a stock move).
export function useReceiptParse() {
  return useMutation({
    mutationFn: (body: { image_base64: string; mime_type: string }) =>
      fetchJson<InventoryReceiptParseResult>("/api/inventory/receipt-parse", {
        method: "POST",
        body: JSON.stringify(body)
      })
  });
}

// AI semantic match (ADR-0586 Phase 2A). Resolves the residual scanned lines the
// deterministic tiers couldn't, returning per-line suggestions + the confidence threshold.
// No cache write — it's a read-only suggestion the operator still confirms.
export function useMatchSuggest() {
  return useMutation({
    mutationFn: (body: InventoryMatchSuggestRequest) =>
      fetchJson<InventoryMatchSuggestResult>("/api/inventory/match-suggest", {
        method: "POST",
        body: JSON.stringify(body)
      })
  });
}

// AI emoji-icon suggestion. Picks an emoji glyph per item name — used by the add-item
// dialog + item detail (on rename) and the receipt review (per new line). No cache write:
// it's a cosmetic suggestion the caller applies only to an icon-less item. Best-effort at the
// call site (a disabled / unconfigured AI just leaves the category-glyph fallback).
export function useEmojiSuggest() {
  return useMutation({
    mutationFn: (body: InventoryEmojiSuggestRequest) =>
      fetchJson<InventoryEmojiSuggestResult>("/api/inventory/emoji-suggest", {
        method: "POST",
        body: JSON.stringify(body)
      })
  });
}

// Commit a no-PO receipt (ADR-0538 D2): bumps on_hand and inline-creates any new
// items, so invalidate the active dataset. `who` is added by the BFF from the session.
export function useAdHocReceive() {
  const queryClient = useQueryClient();
  // A receive bumps on_hand (a relative write), so a re-tap after a failed/lost response
  // must reuse the key — the per-line `adhoc:<key>:<item>` source_ref dedups it. An
  // explicit key (e.g. an AI-confirmed receipt action) is respected; otherwise mint one
  // from the body and reset on success so the next receive starts fresh.
  const receiveKey = useIdempotencyKey();
  return useMutation({
    mutationFn: (body: Omit<InventoryAdHocReceive, "who">) =>
      fetchJson<{ received: number; created: number }>("/api/inventory/receive", {
        method: "POST",
        body: JSON.stringify({
          ...body,
          idempotency_key: body.idempotency_key ?? receiveKey.keyFor(JSON.stringify(body))
        })
      }),
    onSuccess: () => {
      receiveKey.reset();
      void queryClient.invalidateQueries({ queryKey: QUERY_KEY });
      // A scanned receive may have archived a receipt image (receipt-archive); refresh
      // the history so it appears at once rather than on the next 60s poll.
      void queryClient.invalidateQueries({ queryKey: RECEIPTS_QUERY_KEY });
    }
  });
}

// Archived receipt scans for the Receiving "history" view (receipt-archive). A separate
// query — receipts grow unbounded, so they're deliberately NOT in the hot dataset — so
// it's fetched only where the history renders. Same poll cadence as the dataset; a
// backoffice-side receive also invalidates it (useAdHocReceive) for an instant refresh.
export function useReceipts() {
  return useQuery<InventoryReceiptListResponse>({
    queryKey: RECEIPTS_QUERY_KEY,
    queryFn: () => fetchJson<InventoryReceiptListResponse>("/api/inventory/receipts"),
    staleTime: STALE_MS,
    refetchInterval: STALE_MS
  });
}

// Create a new recipe (menu item) header. Returns the created detail so the dialog can
// jump to the editor to build its BOM; invalidates the dataset so it shows in the list.
export function useCreateRecipe() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: InventoryRecipeCreate) =>
      fetchJson<InventoryRecipeDetail>("/api/inventory/recipes", {
        method: "POST",
        body: JSON.stringify(body)
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: QUERY_KEY });
    }
  });
}
