/**
 * Customer-facing **online-ordering** DTOs (apps/order-web ↔ kds-api
 * `/api/order/*`).
 *
 * Deliberately **POS-neutral** — no Clover/Square/Toast field names leak in
 * here (Iron Law #4 + contracts/AGENTS.md "keep provider-neutral app-facing
 * shapes separate from provider-specific webhook payloads"). The only payment
 * value that crosses the wire is an **opaque** token in `paymentToken` (a
 * Clover `clv_…` value today), never named after a POS.
 *
 * Money is **integer cents** everywhere (house rule — mirror NormalizedOrder*
 * in ./index.ts), NOT the dollars the order-web prototype's `lib/types.ts`
 * currently uses. The dollars↔cents conversion happens at the order-web BFF
 * boundary when its mock `lib/api.ts` is swapped for real fetches.
 *
 * Flow (ADR-0027): read menu → submit cart (CreateOrderRequest) → server
 * prices a draft (CreateOrderResponse) → browser tokenizes the card in a
 * Clover hosted iframe → charge (OrderCheckoutRequest carrying paymentToken)
 * → kds-api charges + creates a Clover Atomic Order (which bridges onto the
 * KDS via the existing webhook→sync pipeline) → confirmation, then poll
 * status. See docs/design/online-ordering/clover-integration-recipe.md.
 */
import { z } from "zod";

/* ── Menu (GET /api/order/menu) ─────────────────────────────────────────── */

export const OrderMenuModifierSchema = z.object({
  id: z.string(),
  name: z.string(),
  priceDeltaCents: z.number().int().default(0), // 0 = free topping; >0 = upgrade
  group: z.string(), // "Base" | "Mix-in" | "Topping" | "Vessel" …
});
export type OrderMenuModifier = z.infer<typeof OrderMenuModifierSchema>;

export const OrderMenuModifierGroupSchema = z.object({
  id: z.string(),
  name: z.string(),
  minSelections: z.number().int().min(0),
  maxSelections: z.number().int().min(1),
  modifiers: z.array(OrderMenuModifierSchema).default([]),
});
export type OrderMenuModifierGroup = z.infer<typeof OrderMenuModifierGroupSchema>;

export const OrderMenuItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable().default(null),
  priceCents: z.number().int().min(0),
  category: z.string(),
  imageUrl: z.string().nullable().default(null),
  available: z.boolean().default(true),
  modifierGroups: z.array(OrderMenuModifierGroupSchema).default([]),
});
export type OrderMenuItem = z.infer<typeof OrderMenuItemSchema>;

export const OrderMenuResponseSchema = z.object({
  categories: z.array(z.string()),
  items: z.array(OrderMenuItemSchema),
});
export type OrderMenuResponse = z.infer<typeof OrderMenuResponseSchema>;

/* ── Cart line + order draft (POST /api/order) ──────────────────────────── */

export const OrderLineModifierSchema = z.object({
  id: z.string(),
  name: z.string(),
  priceDeltaCents: z.number().int().default(0),
});
export type OrderLineModifier = z.infer<typeof OrderLineModifierSchema>;

export const OrderLineSchema = z.object({
  // Stable client id so the same item with different mods is a distinct line.
  lineId: z.string().min(1),
  itemId: z.string().min(1),
  itemName: z.string(),
  // Client-computed (base price + modifier deltas), in cents. ADVISORY ONLY —
  // kds-api re-prices authoritatively from the catalog at checkout, so a
  // tampered client total can never become the charge.
  unitPriceCents: z.number().int().min(0),
  quantity: z.number().int().min(1),
  modifiers: z.array(OrderLineModifierSchema).default([]),
  notes: z.string().trim().max(500).optional(),
});
export type OrderLine = z.infer<typeof OrderLineSchema>;

export const CreateOrderRequestSchema = z.object({
  // Pickup-ticket label shown on the KDS — NOT the cardholder name (the card is
  // captured in the Clover iframe and never reaches our server).
  customerName: z.string().trim().min(1).max(120),
  // Optional → guest checkout still works. When present this is the loyalty
  // accrual key (ADR-0027/0024); crm-api owns E.164 canonicalization, so it is
  // intentionally a loose string here.
  customerPhone: z.string().trim().max(32).optional(),
  customerEmail: z.string().trim().max(254).optional(),
  notes: z.string().trim().max(500).optional(),
  lines: z.array(OrderLineSchema).min(1),
});
export type CreateOrderRequest = z.infer<typeof CreateOrderRequestSchema>;

/* ── Totals ─────────────────────────────────────────────────────────────── */

// Server-authoritative money for a customer order, integer cents. Unlike the
// provider-best-effort NormalizedOrderAmounts (all-nullable), these are always
// computed by kds-api, so they are required.
export const OrderTotalsSchema = z.object({
  subtotalCents: z.number().int().min(0),
  taxCents: z.number().int().min(0),
  tipCents: z.number().int().min(0).default(0),
  totalCents: z.number().int().min(0),
  currency: z.string().default("USD"),
});
export type OrderTotals = z.infer<typeof OrderTotalsSchema>;

export const CreateOrderResponseSchema = z.object({
  orderId: z.string(),
  ticketNumber: z.string(), // short human label, e.g. "R-042"
  totals: OrderTotalsSchema,
  // The store this order is bound to (multi-location, ADR-0018). Null on the
  // default single-store path (no store selected). POS-neutral — the canonical
  // Location id, never a merchant/POS id.
  locationId: z.string().nullable().default(null),
  // ADR-0027 moved capture to an in-page Clover iframe, so there is no off-site
  // redirect; kept nullable for a same-origin confirmation path or a Hosted-
  // Checkout fallback. Null in the iframe flow.
  checkoutUrl: z.string().nullable().default(null),
  correlationId: z.string().nullable().default(null),
});
export type CreateOrderResponse = z.infer<typeof CreateOrderResponseSchema>;

/* ── Checkout / charge (POST /api/order/checkout) ───────────────────────── */

export const OrderCheckoutRequestSchema = z.object({
  orderId: z.string().min(1), // the draft from CreateOrderResponse
  // Opaque single-use payment token minted by the Clover hosted iframe (a
  // `clv_…` value). Neutral name on purpose — never `cloverToken`.
  paymentToken: z.string().min(1),
  tipCents: z.number().int().min(0).default(0),
});
export type OrderCheckoutRequest = z.infer<typeof OrderCheckoutRequestSchema>;

/* ── Status (checkout result + GET /api/order/{id}/status) ──────────────── */

// The customer-facing order lifecycle. Hard contract with the order-web status
// ladder (Confirmation.tsx `stepIndexFor`) — do not rename a state.
export const orderStatusStates = [
  "pending_payment",
  "paid",
  "preparing",
  "ready",
  "completed",
  "cancelled",
] as const;
export const OrderStatusStateSchema = z.enum(orderStatusStates);
export type OrderStatusState = z.infer<typeof OrderStatusStateSchema>;

export const OrderConfirmationSchema = z.object({
  orderId: z.string(),
  ticketNumber: z.string(),
  state: OrderStatusStateSchema,
  totals: OrderTotalsSchema,
  // The store the order is bound to (multi-location, ADR-0018). Null on the
  // default single-store path. POS-neutral (canonical Location id).
  locationId: z.string().nullable().default(null),
  updatedAt: z.string(), // ISO 8601
});
export type OrderConfirmation = z.infer<typeof OrderConfirmationSchema>;

export const OrderStatusResponseSchema = z.object({
  orderId: z.string(),
  ticketNumber: z.string(),
  state: OrderStatusStateSchema,
  // The store the order is bound to (multi-location, ADR-0018). Null on the
  // default single-store path. POS-neutral (canonical Location id).
  locationId: z.string().nullable().default(null),
  updatedAt: z.string(), // ISO 8601
});
export type OrderStatusResponse = z.infer<typeof OrderStatusResponseSchema>;

/* ── Queue estimate (GET /api/order/queue) ──────────────────────────────── */

export const QueueEstimateSchema = z.object({
  minutes: z.number().int().min(0), // estimated minutes until ready
  queueDepth: z.number().int().min(0), // tickets currently ahead
  asOf: z.string(), // ISO 8601 — when the estimate was computed
  source: z.enum(["live", "fallback"]), // "fallback" = backend was unreachable
});
export type QueueEstimate = z.infer<typeof QueueEstimateSchema>;
