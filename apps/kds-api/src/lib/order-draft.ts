import { z } from "zod";
import type { Redis } from "ioredis";
import { CreateOrderRequestSchema, OrderTotalsSchema } from "@rop/contracts";

// A priced, quoted order awaiting payment. Kept in Redis (not a DB table — no
// migration, shared across replicas, auto-expiring) between POST /api/order
// (draft) and POST /api/order/checkout (charge). 30 min is long enough for a
// customer to finish the Clover iframe but short enough that abandoned carts
// evaporate.
const DRAFT_TTL_SECONDS = 30 * 60;

const keyFor = (id: string) => `order:draft:${id}`;

// Runtime mirror of the domain `PricedLine` (src/domain/price-cart.ts). It lives
// here rather than next to the interface because that pricing module is
// deliberately zod-free — the Redis (de)serialization boundary is this file's
// concern. Numeric guardrails match the cart contract (OrderLineSchema): a
// non-negative integer unit price and a positive integer quantity. Drift is
// caught at compile time for free — checkout feeds `draft.lines` straight into
// `buildOrderCart(_: PricedLine[])`, so if `PricedLine` gains a field this schema
// omits, that call site stops type-checking.
const PricedLineSchema = z.object({
  name: z.string(),
  unitPriceCents: z.number().int().min(0),
  quantity: z.number().int().min(1),
  modifierNames: z.array(z.string()),
});

// The draft is the SOLE authority for the money path (lib/order-checkout.ts) and
// the per-store payment gate (routes/order.ts): `merchantId` / `locationId`
// decide whether — and which account — to charge, and `totals.totalCents` becomes
// the charge amount. It is read back from Redis, which is untrusted as far as
// type-safety goes, so `loadDraft` validates every field here instead of a bare
// `as OrderDraft` cast. Mirrors the former hand-written interface field-for-field.
export const OrderDraftSchema = z.object({
  merchantId: z.string(),
  // The store the order is bound to (multi-location). Null on the default
  // single-store path. Carried so checkout can gate payment per store + echo it.
  locationId: z.string().nullable(),
  // The shared customer-order contract: re-validates the name + cart lines that
  // get attached to the Clover order downstream.
  order: CreateOrderRequestSchema,
  // Authoritative priced lines, locked at draft time, used to build the Clover
  // order at checkout.
  lines: z.array(PricedLineSchema),
  // Server-authoritative money; OrderTotalsSchema enforces integer-cents ≥ 0 so a
  // tampered totalCents can never reach the charge.
  totals: OrderTotalsSchema,
});

// Derived from the schema so the validator is the single source of truth — the
// runtime check and the compile-time type can never drift apart.
export type OrderDraft = z.infer<typeof OrderDraftSchema>;

export async function saveDraft(redis: Redis, id: string, draft: OrderDraft): Promise<void> {
  await redis.set(keyFor(id), JSON.stringify(draft), "EX", DRAFT_TTL_SECONDS);
}

export async function loadDraft(redis: Redis, id: string): Promise<OrderDraft | null> {
  const raw = await redis.get(keyFor(id));
  if (!raw) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Malformed JSON (truncation / corruption) — treat as an expired draft.
    return null;
  }
  // Defense-in-depth (PR #723 follow-up): a structurally-valid JSON that violates
  // the draft contract — a tampered totalCents, a missing or retyped locationId —
  // is rejected here rather than flowing into the charge and the per-store payment
  // gate. The checkout route maps a null draft to a clean 404 "your order has
  // expired", so the caller already handles this path.
  const result = OrderDraftSchema.safeParse(parsed);
  return result.success ? result.data : null;
}

export async function deleteDraft(redis: Redis, id: string): Promise<void> {
  await redis.del(keyFor(id));
}
