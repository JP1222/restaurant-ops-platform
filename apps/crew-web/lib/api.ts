// Browser-side client for crew-web's own BFF route handlers (`/api/*`). The
// browser never calls inventory-api directly; the route handlers forward to it
// and own the httpOnly crew session cookie. Kept lean: plain fetch, no react-query.

import type {
  InventoryBarcodeEnrich,
  InventoryBarcodeResolve,
  InventoryBarcodeSource,
  InventoryDataset,
  InventoryEmojiSuggestResult,
  InventoryItem,
  InventoryItemPackSave,
  InventoryMatchSuggestResult,
  InventoryPurchaseOrderDetail,
  InventoryReceiptParseResult,
  InventoryUnitKind
} from "@rop/contracts";

import type { Employee } from "./types";

export type LoginResult =
  | { ok: true; employee: Employee }
  | { ok: false; reason: "invalid" | "locked" | "blocked" | "unavailable" };

const JSON_HEADERS = { "content-type": "application/json" };

// A failed write carries its HTTP status so the UI can tell the cook WHY it failed
// instead of a blanket "couldn't save" — a 401 means the shift session expired
// (log in again), a 0 means the network/API is unreachable, anything else is a
// generic server error. `status === 0` is our sentinel for "fetch threw" (offline).
export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message = "request failed") {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

// Coarse reason for a failed write, derived from the ApiError status. The flows map
// this to a localized message via `writeFailureKey` (lib/strings):
//   session     — 401, the shift session lapsed (log back in)
//   offline     — status 0 (fetch threw): the device genuinely has no network
//   unavailable — 502/503: we reached a server but it (or its upstream) is down /
//                 not configured. NOT the cook's network — escalate to a manager.
//   timeout     — 504: the upstream took too long (e.g. the vision parse hit its
//                 deadline, surfaced as 504 vision_timeout). Worth retrying as-is.
//   server      — any other non-2xx (a generic, usually-retryable error)
export type WriteFailure = "session" | "offline" | "unavailable" | "timeout" | "server";

// Window event fired when an authenticated write comes back 401 — the crew
// session expired (12h TTL) or was cleared. The httpOnly cookie can lapse while
// the SPA still shows the cook signed in (no remount = no /me re-check), so every
// write 401s with no clue. CrewApp listens for this and bounces back to PIN login
// with a notice, instead of leaving the cook stuck on "couldn't save".
export const CREW_SESSION_EXPIRED_EVENT = "crew:session-expired";

export function writeFailureReason(err: unknown): WriteFailure {
  if (err instanceof ApiError) {
    if (err.status === 401) return "session";
    // 502/503 = a reachable server reporting it (or its upstream) is down / not
    // ready — distinct from status 0 (fetch threw: truly no network). Conflating
    // them surfaced "check your internet" for a server-side outage.
    if (err.status === 502 || err.status === 503) return "unavailable";
    // 504 = the upstream timed out (the scan proxy passes backoffice's 504
    // vision_timeout straight through) — the fix is simply to try again.
    if (err.status === 504) return "timeout";
    if (err.status === 0) return "offline";
  }
  return "server";
}

// Shared write helper: POST/PUT/DELETE JSON and throw a status-bearing ApiError on
// any non-2xx (or a status-0 ApiError when the fetch itself throws — offline). The
// body is omitted for a DELETE.
async function writeJson(
  path: string,
  body: unknown,
  method: "POST" | "PUT" | "DELETE" = "POST"
): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers: JSON_HEADERS,
      body: body === null ? undefined : JSON.stringify(body)
    });
  } catch {
    throw new ApiError(0, "offline");
  }
  if (!res.ok) {
    // A 401 on an authenticated write means the session lapsed. Surface it
    // app-wide so the shell can return to login (every write routes through here).
    if (res.status === 401 && typeof window !== "undefined") {
      window.dispatchEvent(new Event(CREW_SESSION_EXPIRED_EVENT));
    }
    throw new ApiError(res.status);
  }
  return res;
}

export async function login(pin: string): Promise<LoginResult> {
  let res: Response;
  try {
    res = await fetch("/api/crew/login", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ pin })
    });
  } catch {
    return { ok: false, reason: "unavailable" };
  }
  if (res.ok) {
    const data = (await res.json()) as { employee: Employee };
    return { ok: true, employee: data.employee };
  }
  if (res.status === 429) {
    return { ok: false, reason: "locked" };
  }
  if (res.status === 403) {
    return { ok: false, reason: "blocked" };
  }
  if (res.status === 400 || res.status === 401) {
    return { ok: false, reason: "invalid" };
  }
  return { ok: false, reason: "unavailable" };
}

export async function logout(): Promise<void> {
  try {
    await fetch("/api/crew/logout", { method: "POST" });
  } catch {
    // best-effort; local state is cleared regardless
  }
}

export async function getMe(): Promise<Employee | null> {
  try {
    const res = await fetch("/api/crew/me");
    if (!res.ok) {
      return null;
    }
    return ((await res.json()) as { employee: Employee }).employee;
  } catch {
    return null;
  }
}

export async function fetchInventory(): Promise<InventoryDataset> {
  const res = await fetch("/api/inventory", { cache: "no-store" });
  if (!res.ok) {
    throw new Error("inventory unavailable");
  }
  return (await res.json()) as InventoryDataset;
}

// Resolve a typed/scanned barcode to { item, pack } (ADR-0737). null = unknown code (404),
// so the lookup UI can say "no encontrado" rather than treating it as an error.
export async function resolveBarcode(code: string): Promise<InventoryBarcodeResolve | null> {
  let res: Response;
  try {
    res = await fetch(`/api/inventory/barcode/${encodeURIComponent(code)}`, { cache: "no-store" });
  } catch {
    throw new ApiError(0);
  }
  if (res.status === 404) {
    return null;
  }
  if (!res.ok) {
    throw new ApiError(res.status);
  }
  return (await res.json()) as InventoryBarcodeResolve;
}

// Browser-side waste write shape. Deliberately NOT `InventoryWasteSubmission`
// from contracts: that DTO requires `who` and a narrowed reason union, but the
// floor never sends `who` (the BFF route injects it from the crew session) and
// the keypad tracks the reason id as a loose string.
export interface WasteInput {
  sku: string;
  qty: number;
  // When set, `qty` is a COUNT OF PACKS and inventory-api multiplies it by the pack's
  // base_qty_per_pack server-side (ADR-0737). cost_cents must already be the base-unit
  // total — the waste path trusts the client cost, it does not re-derive it from the pack.
  pack_id?: string;
  reason: string;
  notes: string;
  photo: boolean;
  cost_cents: number;
}

// `idempotencyKey` is minted + held by the calling flow's confirm state
// (lib/use-idempotency-key.ts) so a re-tap after a failed/lost response reuses it and
// inventory-api dedups the retry — see PR #519's per-submission guard. It is required
// (not internally defaulted) precisely so a flow can't accidentally mint a fresh key
// on every render and defeat the dedup.
export async function recordWaste(input: WasteInput, idempotencyKey: string): Promise<void> {
  await writeJson("/api/inventory/waste", { ...input, idempotency_key: idempotencyKey });
}

export async function applyCount(
  updates: Record<string, number>,
  scope: string | undefined,
  idempotencyKey: string
): Promise<void> {
  await writeJson("/api/inventory/counts", {
    updates,
    scope,
    idempotency_key: idempotencyKey
  });
}

// Floor "quick add" for a catalog item the cook can't find. Since the redesign
// (design handoff §4), the floor "＋ Nuevo" / new-SKU forms capture cost + vendor
// too, so this carries the optional `vendor` / `purchase_cost_cents` / `pack_qty`
// the contract's InventoryItemCreate accepts (cost_cents derives from the pair).
// Floor-created items use pack_qty 1, so purchase_cost_cents IS the per-usage cost.
// on_hand starts at 0 server-side; receive/count moves it. The BFF forwards it
// carrying the crew session.
export interface AddItemInput {
  name: string;
  category: string;
  unit: string;
  unit_kind?: InventoryUnitKind;
  par_min: number;
  par_max: number;
  vendor?: string;
  purchase_cost_cents?: number;
  pack_qty?: number;
  // Optional emoji glyph the cook picked for the item (lib/item-icons.ts).
  icon?: string;
}

export async function addItem(input: AddItemInput): Promise<InventoryItem> {
  const res = await writeJson("/api/inventory/items", input);
  return ((await res.json()) as { item: InventoryItem }).item;
}

// Scan-to-register enrichment (barcode-onboarding ADR, D3 — floor): resolve a registered code, else
// OFF auto-fill suggestions. The upstream FAILS OPEN (always 200), so a miss/outage returns
// registered:false with null suggestions; a non-200 here is infra, treated the same (blank miss) so
// the register form never gets blocked.
export async function lookupBarcodeEnrich(upc: string): Promise<InventoryBarcodeEnrich> {
  try {
    const res = await fetch(`/api/inventory/barcode/lookup/${encodeURIComponent(upc)}`, {
      cache: "no-store"
    });
    if (!res.ok) {
      return { registered: false, item: null, pack: null, off: null, suggestions: null };
    }
    return (await res.json()) as InventoryBarcodeEnrich;
  } catch {
    return { registered: false, item: null, pack: null, off: null, suggestions: null };
  }
}

// Create a packaging conversion (1 Caja = N) on a just-created item (ADR-0737); returns the updated
// item with the new pack so the caller can map the barcode to that exact pack.
export async function saveItemPack(itemId: string, input: InventoryItemPackSave): Promise<InventoryItem> {
  const res = await writeJson(`/api/inventory/items/${encodeURIComponent(itemId)}/packs`, input);
  return ((await res.json()) as { item: InventoryItem }).item;
}

// Map a scanned UPC to an item (+ optional pack), ADR-0737. Returns the updated item.
export async function saveBarcode(
  itemId: string,
  input: { code: string; pack_id?: string | null; source?: InventoryBarcodeSource }
): Promise<InventoryItem> {
  const res = await writeJson(`/api/inventory/items/${encodeURIComponent(itemId)}/barcodes`, input);
  return ((await res.json()) as { item: InventoryItem }).item;
}

export async function toggle86(id: string): Promise<void> {
  await writeJson(`/api/inventory/items/${encodeURIComponent(id)}/toggle-86`, null);
}

// Floor "edit item" — catalog fields a line cook can fix. The redesign (design
// handoff §4) folds the per-item editor into the Artículos catalog and adds
// Precio unit. + Proveedor to that form, so cost + vendor are now floor-editable
// (the API + BFF always allowed it; only this client shape restricted it). cost
// rides as `purchase_cost_cents` + `pack_qty` since the API derives cost_cents
// from the pair. Returns the updated item.
export interface EditItemInput {
  name: string;
  category: string;
  unit: string;
  unit_kind?: InventoryUnitKind;
  vendor?: string;
  purchase_cost_cents?: number;
  pack_qty?: number;
  // Emoji glyph for the item; "" clears it (falls back to the category glyph).
  icon?: string;
}

export async function saveItemInfo(id: string, input: EditItemInput): Promise<InventoryItem> {
  const res = await writeJson(`/api/inventory/items/${encodeURIComponent(id)}`, input, "PUT");
  return ((await res.json()) as { item: InventoryItem }).item;
}

// "Delete" an item from the floor. Implemented as a soft archive (never a hard
// delete — items are referenced by loose sku/id strings across recipes, POs, waste
// and movement history with no FK, so a hard delete would orphan them). The item
// drops out of the active dataset; a manager can restore it from Backoffice.
export async function archiveItem(id: string, archived = true): Promise<void> {
  await writeJson(`/api/inventory/items/${encodeURIComponent(id)}/archive`, { archived });
}

// Set just an item's per-usage cost without touching its other catalog fields —
// used by the scan reprice path (an existing matched line with "Actualizar precio"
// on). cost_cents = purchase_cost_cents / pack_qty, so to land on `costCents` we
// send purchase_cost_cents = round(costCents * packQty) and echo the item's
// current pack_qty, preserving its pack structure (a new floor item has pack_qty 1).
export async function saveItemCost(id: string, costCents: number, packQty: number): Promise<void> {
  const qty = packQty > 0 ? packQty : 1;
  await writeJson(
    `/api/inventory/items/${encodeURIComponent(id)}`,
    { purchase_cost_cents: Math.round(costCents * qty), pack_qty: qty },
    "PUT"
  );
}

// Low-stock alert (par) is per-location state, so it has its own path.
export async function updateItemPar(
  id: string,
  par: { par_min: number; par_max: number }
): Promise<void> {
  await writeJson(`/api/inventory/items/${encodeURIComponent(id)}/par`, par, "PUT");
}

// Upload / replace an item photo. `dataBase64` is the bare base64 (no data: prefix);
// the resize happens in lib/image.ts before this call.
export async function uploadItemImage(
  id: string,
  contentType: string,
  dataBase64: string
): Promise<void> {
  await writeJson(
    `/api/inventory/items/${encodeURIComponent(id)}/image`,
    { content_type: contentType, data_base64: dataBase64 },
    "PUT"
  );
}

export async function removeItemImage(id: string): Promise<void> {
  await writeJson(`/api/inventory/items/${encodeURIComponent(id)}/image`, null, "DELETE");
}

// Same-origin URL for an item's photo. `version` busts the browser cache after a
// re-upload (the bytes change but the URL wouldn't). Callers pass any item field
// that changes on save, or a timestamp.
export function itemImageUrl(id: string, version?: string | number): string {
  const base = `/api/inventory/items/${encodeURIComponent(id)}/image`;
  return version === undefined ? base : `${base}?v=${encodeURIComponent(String(version))}`;
}

export async function fetchPo(id: string): Promise<InventoryPurchaseOrderDetail> {
  const res = await fetch(`/api/inventory/pos/${encodeURIComponent(id)}`, { cache: "no-store" });
  if (!res.ok) {
    throw new Error("po fetch failed");
  }
  return (await res.json()) as InventoryPurchaseOrderDetail;
}

export async function receivePo(
  id: string,
  // pack_id (ADR-0737): when set, qty is a COUNT OF PACKS and inventory-api multiplies it
  // by the pack's base_qty_per_pack server-side. Omit it for a plain base-unit qty.
  lines: { sku: string; qty: number; pack_id?: string }[],
  idempotencyKey: string
): Promise<void> {
  await writeJson(`/api/inventory/pos/${encodeURIComponent(id)}/receive`, {
    lines,
    idempotency_key: idempotencyKey
  });
}

// Invoice-scan extraction (design handoff §3). Posts the photo to crew-web's BFF,
// which proxies it to backoffice's Gemini vision parse (ADR-0538; a deterministic
// live-catalog stub is the dev-only fallback when unconfigured). The result carries
// RAW descriptions; matching them to catalog items is a separate deterministic step
// (lib/scan.ts), never the model's job.
export async function scanReceipt(
  imageBase64: string,
  mimeType: string
): Promise<InventoryReceiptParseResult> {
  const res = await writeJson("/api/inventory/scan", {
    image_base64: imageBase64,
    mime_type: mimeType
  });
  return (await res.json()) as InventoryReceiptParseResult;
}

// AI semantic match (ADR-0587). Ask the backoffice chat brain (proxied) to resolve the
// residual scanned lines the deterministic matcher couldn't, among existing catalog items.
// Best-effort: any failure returns an empty result so the scan flow keeps its deterministic
// matches and never blocks on the AI. The model never invents a SKU (guarded server-side).
export async function suggestMatches(
  lines: { index: number; text: string }[],
  candidates: { id: string; name: string }[]
): Promise<InventoryMatchSuggestResult> {
  try {
    const res = await fetch("/api/inventory/match-suggest", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ lines, candidates })
    });
    if (!res.ok) {
      return { suggestions: [], threshold: 1 };
    }
    return (await res.json()) as InventoryMatchSuggestResult;
  } catch {
    return { suggestions: [], threshold: 1 };
  }
}

// AI emoji-icon suggestion. Ask the backoffice chat brain (proxied) to pick an emoji glyph
// for one or more item names. Best-effort + purely cosmetic: any failure returns empty so
// item create / rename / scan-import never blocks on the AI. The caller fills the icon only
// when the item has none yet. Returns a map of input index -> sanitized glyph (a missing
// index = no suggestion for that item).
export async function suggestEmojis(
  names: { index: number; name: string }[]
): Promise<Map<number, string>> {
  const empty = new Map<number, string>();
  if (names.length === 0) {
    return empty;
  }
  try {
    const res = await fetch("/api/inventory/emoji-suggest", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ names })
    });
    if (!res.ok) {
      return empty;
    }
    const data = (await res.json()) as InventoryEmojiSuggestResult;
    const out = new Map<number, string>();
    for (const s of data.suggestions) {
      if (s.emoji) {
        out.set(s.index, s.emoji);
      }
    }
    return out;
  } catch {
    return empty;
  }
}

// Single-item convenience for the create / rename triggers. Returns the glyph or "".
export async function suggestEmoji(name: string): Promise<string> {
  const trimmed = name.trim();
  if (!trimmed) {
    return "";
  }
  const map = await suggestEmojis([{ index: 0, name: trimmed }]);
  return map.get(0) ?? "";
}

// One ad-hoc receive line: an existing item by `sku` (= item id), or a new item
// to inline-create (`name` + `category` + `unit`). `unit_cost_cents` seeds the
// created item's cost; on an existing item the API only moves on_hand (reprice is
// a separate item PUT — see saveItemCost). `description` (the raw vendor-printed text)
// + brand/pack let the API learn a vendor->item alias (ADR-0586 D2) so the
// next invoice from this vendor auto-matches.
export interface AdHocReceiveLineInput {
  sku?: string;
  name?: string;
  category?: string;
  unit?: string;
  qty: number;
  // For a matched `sku`, `qty` may be a COUNT OF PACKS — inventory-api multiplies it by the
  // pack's base_qty_per_pack server-side (ADR-0737). Only valid with an existing item.
  pack_id?: string;
  unit_cost_cents?: number;
  description?: string;
  brand?: string;
  pack?: string;
  // AI-suggested emoji glyph for a NEW item line (ignored for a matched `sku`).
  icon?: string;
  // Optional par levels for a NEW item line (ignored for a matched `sku`). par_max is
  // the overstock ceiling + reorder target; omit / 0 = "no ceiling" (see AddItemInput).
  par_min?: number;
  par_max?: number;
  // ADR-882: a NEW pack (size) to create for this line's item, then book `qty` packs into it.
  // qty = number of packs; unit_cost_cents is per-pack; inventory-api converts via base_qty_per_pack.
  // Mutually exclusive with pack_id (an existing pack).
  new_pack?: { label: string; base_qty_per_pack: number };
  // ADR-882: ties several NEW lines that are the same product at different sizes into ONE created
  // item — the receive creates it once (from the first such line) and attaches each line's pack.
  item_group?: string;
}

// Confirm a scanned invoice → real receiving (ADR-0538 D2). One idempotent
// ad-hoc receive for every included line; matched lines move on_hand, unmatched
// lines inline-create then receive. `who` is injected by the BFF + overridden
// server-side from the crew session. Returns { received, created } counts.
export async function receiveAdHoc(
  vendor: string | undefined,
  lines: AdHocReceiveLineInput[],
  idempotencyKey: string,
  // Optional original scan image to archive alongside the receive (receipt-archive).
  // The capture pipeline (resizeImageForUpload / renderPdfFirstPage) always emits
  // image/jpeg, which is in the contract's allowed set. Server-side archiving is
  // best-effort, so even a rejected/oversized image never fails the receive there;
  // omit it and the receive proceeds exactly as before.
  receipt?: { imageBase64: string; contentType: string; invoiceDate?: string }
): Promise<{ received: number; created: number }> {
  const res = await writeJson("/api/inventory/receive", {
    vendor,
    lines,
    idempotency_key: idempotencyKey,
    ...(receipt
      ? {
          receipt_image_base64: receipt.imageBase64,
          receipt_content_type: receipt.contentType,
          invoice_date: receipt.invoiceDate
        }
      : {})
  });
  return (await res.json()) as { received: number; created: number };
}
