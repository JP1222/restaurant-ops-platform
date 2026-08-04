import {
  inventoryWasteReasonIds,
  InventoryWasteReasonIdSchema,
  type InventoryAdHocReceive,
  type InventoryCountSubmission,
  type InventoryDataset,
  type InventoryItem,
  type InventoryWasteReasonId,
  type InventoryWasteSubmission,
} from "@rop/contracts";
import { z } from "zod";

/**
 * Server-side resolution + submission-building for the AI write tools
 * (record_receiving / record_waste / set_inventory_count). The model proposes an
 * action by item NAME; this layer resolves it to exactly one active item and maps
 * it onto the existing inventory-api write contracts. Pure + tested — the route is
 * a thin shell. The write itself is gated behind the SDK's tool approval, so this
 * only ever runs after the operator confirmed in the UI.
 */

export { inventoryWasteReasonIds };

// What the AI tools forward to /api/ai/inventory/apply. `idempotency_key` is the
// tool-call id, so a retried execute of the same approved call is a no-op.
export const AiInventoryActionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("receive"),
    item: z.string().min(1).max(80),
    quantity: z.number().positive(),
    note: z.string().max(200).optional(),
    idempotency_key: z.string().min(1).max(120),
  }),
  z.object({
    action: z.literal("waste"),
    item: z.string().min(1).max(80),
    quantity: z.number().positive(),
    reason: InventoryWasteReasonIdSchema,
    note: z.string().max(200).optional(),
    idempotency_key: z.string().min(1).max(120),
  }),
  z.object({
    action: z.literal("count"),
    item: z.string().min(1).max(80),
    counted_quantity: z.number().nonnegative(),
    note: z.string().max(200).optional(),
    idempotency_key: z.string().min(1).max(120),
  }),
]);
export type AiInventoryAction = z.infer<typeof AiInventoryActionSchema>;

type InventorySource = Pick<InventoryDataset, "items">;

export type ResolveResult =
  | { ok: true; item: InventoryItem }
  | { ok: false; error: "not_found" }
  | { ok: false; error: "ambiguous"; candidates: string[] };

/**
 * Resolve a free-text item reference to exactly one active item. Tiered so an
 * exact id/sku/name always wins over a looser substring, and an ambiguous
 * substring returns candidates instead of guessing (never write to the wrong row).
 */
export function resolveInventoryItem(source: InventorySource, query: string): ResolveResult {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return { ok: false, error: "not_found" };
  const items = source.items.filter((item) => !item.archived);

  const byId = items.find((item) => item.id.toLowerCase() === q);
  if (byId) return { ok: true, item: byId };

  const bySku = items.filter((item) => item.sku.toLowerCase() === q);
  if (bySku.length === 1) return { ok: true, item: bySku[0]! };

  const byName = items.filter((item) => item.name.toLowerCase() === q);
  if (byName.length === 1) return { ok: true, item: byName[0]! };

  const bySubstring = items.filter(
    (item) => item.name.toLowerCase().includes(q) || item.sku.toLowerCase().includes(q),
  );
  if (bySubstring.length === 1) return { ok: true, item: bySubstring[0]! };
  if (bySubstring.length > 1) {
    return { ok: false, error: "ambiguous", candidates: bySubstring.slice(0, 8).map((i) => i.name) };
  }
  return { ok: false, error: "not_found" };
}

// The inventory-api write contracts key the item by its `id` (the `sku` field and
// the count `updates` keys are item ids — see inventory-store.ts where:{id}).

export function buildReceiveBody(
  item: InventoryItem,
  quantity: number,
  who: string,
  idempotencyKey: string,
  vendor?: string,
): InventoryAdHocReceive {
  return {
    who,
    idempotency_key: idempotencyKey,
    ...(vendor && vendor.trim().length > 0 ? { vendor: vendor.trim() } : {}),
    lines: [{ sku: item.id, qty: quantity }],
  };
}

export function buildWasteBody(
  item: InventoryItem,
  quantity: number,
  reason: InventoryWasteReasonId,
  who: string,
  idempotencyKey: string,
  note?: string,
): InventoryWasteSubmission {
  return {
    sku: item.id,
    qty: quantity,
    reason,
    notes: note ?? "",
    photo: false,
    // Per-usage cost is cents (possibly sub-cent); the contract wants an int.
    cost_cents: Math.max(0, Math.round((item.cost_cents ?? 0) * quantity)),
    who,
    idempotency_key: idempotencyKey,
  };
}

export function buildCountBody(
  item: InventoryItem,
  countedQuantity: number,
  who: string,
  idempotencyKey: string,
  note?: string,
): InventoryCountSubmission {
  return {
    updates: { [item.id]: countedQuantity },
    who,
    ...(note && note.trim().length > 0 ? { scope: note.trim() } : {}),
    idempotency_key: idempotencyKey,
  };
}
