import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import {
  CreateOrderRequestSchema,
  type CreateOrderResponse,
  type OrderConfirmation,
  OrderCheckoutRequestSchema,
  type OrderMenuResponse,
  type OrderStatusResponse,
  type OrderStatusState,
  type OrderTotals,
} from "@rop/contracts";
import { buildOrderCart } from "../domain/build-order-cart.js";
import { pickExternalPaymentTenderId, pickTaxableOrderTypeId } from "../domain/merchant-config.js";
import { normalizeMenu } from "../domain/normalize-menu.js";
import { priceCart } from "../domain/price-cart.js";
import { getConfiguredCloverMerchantId } from "../lib/clover-runtime.js";
import { resolveOrderStore, type ResolvedOrderStore } from "../lib/order-store.js";
import { loadSquareMenu } from "../lib/square-menu.js";
import { deleteDraft, loadDraft, saveDraft } from "../lib/order-draft.js";
import { CheckoutError, checkoutOrder } from "../lib/order-checkout.js";
import type { AppServices } from "../lib/services.js";

// Menus + merchant config change rarely; short caches spare Clover round-trips.
const MENU_CACHE_TTL_MS = 60_000;
const CONFIG_CACHE_TTL_MS = 5 * 60_000;

interface MenuCacheEntry {
  expiresAt: number;
  menu: OrderMenuResponse;
}

interface MerchantConfigEntry {
  expiresAt: number;
  orderTypeId: string | null;
  tenderId: string | null;
}

// Paid → accepted and in the kitchen. Richer ready/completed states come from
// the KDS ticket (follow-up); for now an order is "preparing" once paid.
function mapOrderStatus(order: Record<string, unknown>): OrderStatusState {
  return order.paymentState === "PAID" ? "preparing" : "pending_payment";
}

export async function registerOrderRoutes(app: FastifyInstance, services: AppServices) {
  // PUBLIC customer surface: /api/order/* deliberately sits OUTSIDE the
  // /api/kds/* auth preHandler (app.ts) — anyone can read the menu and order.
  const menuCache = new Map<string, MenuCacheEntry>();
  const configCache = new Map<string, MerchantConfigEntry>();

  // Shared by the menu read + the draft pricing: read the store's LIVE catalog,
  // normalize to the POS-neutral OrderMenuResponse, and cache. Provider-aware —
  // a Square store reads its Square catalog (else it would 502 calling Clover).
  // Cache is keyed by the per-store id (Clover merchantId / `square:{loc}`), which
  // is unique across providers. Throws on upstream failure so callers can decide
  // whether to serve a stale copy.
  async function loadMenu(store: ResolvedOrderStore): Promise<OrderMenuResponse> {
    const now = Date.now();
    const cacheKey = store.merchantId;
    const cached = menuCache.get(cacheKey);
    if (cached && cached.expiresAt > now) {
      return cached.menu;
    }
    let menu: OrderMenuResponse;
    if (store.provider === "square") {
      menu = await loadSquareMenu(services.prisma, services.square, store.merchantId);
    } else {
      const [rawItems, rawModifierGroups] = await Promise.all([
        services.clover.fetchMenuItems(store.merchantId),
        services.clover.fetchModifierGroups(store.merchantId),
      ]);
      menu = normalizeMenu(rawItems, rawModifierGroups);
    }
    menuCache.set(cacheKey, { expiresAt: now + MENU_CACHE_TTL_MS, menu });
    return menu;
  }

  // Resolve (and cache) the merchant config needed to build + settle orders: the
  // taxable order type id (for tax) and the External Payment tender id (to mark
  // an order paid). Both come from Clover; both change rarely.
  async function resolveMerchantConfig(merchantId: string): Promise<MerchantConfigEntry> {
    const now = Date.now();
    const cached = configCache.get(merchantId);
    if (cached && cached.expiresAt > now) {
      return cached;
    }
    const [rawOrderTypes, rawTenders] = await Promise.all([
      services.clover.fetchOrderTypes(merchantId),
      services.clover.fetchTenders(merchantId),
    ]);
    const resolved: MerchantConfigEntry = {
      expiresAt: now + CONFIG_CACHE_TTL_MS,
      orderTypeId: pickTaxableOrderTypeId(rawOrderTypes),
      tenderId: pickExternalPaymentTenderId(rawTenders),
    };
    configCache.set(merchantId, resolved);
    return resolved;
  }

  app.get<{ Querystring: { location?: string } }>("/api/order/menu", async (request, reply) => {
    const requestedLocation = request.query.location;
    const store = await resolveOrderStore(
      services.prisma,
      services.config,
      requestedLocation,
      request.log,
    );
    if (!store) {
      reply.code(requestedLocation ? 404 : 503);
      return {
        error: requestedLocation
          ? "We couldn't find that store."
          : "Menu is not available right now.",
      };
    }
    const { merchantId } = store;
    try {
      // "menu = POS inventory" decision (ADR-0027): production serves the real
      // store menu (Clover or Square); nothing is seeded.
      return await loadMenu(store);
    } catch (err) {
      request.log.error({ err, provider: store.provider }, "order: failed to load store menu");
      const stale = menuCache.get(merchantId);
      if (stale) {
        return stale.menu;
      }
      reply.code(502);
      return { error: "Menu is temporarily unavailable." };
    }
  });

  // Draft = a priced, tax-quoted cart held in Redis until the customer pays. No
  // money moves; no Clover order is created yet.
  app.post<{ Querystring: { location?: string } }>("/api/order", async (request, reply) => {
    const parsed = CreateOrderRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "Invalid order." };
    }
    const order = parsed.data;

    const requestedLocation = request.query.location;
    const store = await resolveOrderStore(
      services.prisma,
      services.config,
      requestedLocation,
      request.log,
    );
    if (!store) {
      reply.code(requestedLocation ? 404 : 503);
      return {
        error: requestedLocation
          ? "We couldn't find that store."
          : "Ordering is unavailable right now.",
      };
    }

    // Online ordering + checkout are deferred for Square (the draft pricing +
    // settlement path below is Clover-only — checkoutAtomicOrder, the External
    // Payment tender, the #723 fail-closed gate). Refuse a Square store HERE with
    // a clear message instead of letting it surface a misleading Clover 502 mid-
    // pricing. The menu read above stays available for Square.
    if (store.provider === "square") {
      reply.code(503);
      return { error: "Online ordering isn't available for this store yet." };
    }
    const { merchantId } = store;

    let menu: OrderMenuResponse;
    try {
      menu = await loadMenu(store);
    } catch (err) {
      request.log.error({ err }, "order: draft could not load the menu");
      reply.code(502);
      return { error: "Could not price your order. Please try again." };
    }

    // Server-authoritative pricing: re-price from the catalog, never trust the
    // client unitPrice. Rejects (409) if the menu changed under the customer.
    const priced = priceCart(order, menu);
    if (!priced.ok) {
      reply.code(409);
      return { error: priced.reason, lineId: priced.lineId };
    }

    // Let Clover compute the authoritative total + tax from the catalog prices so
    // the quote equals what the order will cost at checkout. The order type (for
    // tax) is resolved from the merchant — an inline orderType is rejected.
    let totalCents = priced.cart.subtotalCents;
    let taxCents = 0;
    try {
      const { orderTypeId } = await resolveMerchantConfig(merchantId);
      const orderCart = buildOrderCart(priced.cart.lines, orderTypeId);
      const quote = await services.clover.checkoutAtomicOrder(merchantId, orderCart);
      // total + tax are TOP-LEVEL on the checkouts response (not under orderCart).
      if (typeof quote.total === "number") {
        totalCents = quote.total;
      }
      if (typeof quote.totalTaxAmount === "number") {
        taxCents = quote.totalTaxAmount;
      }
    } catch (err) {
      request.log.error({ err }, "order: Clover checkout quote failed");
      reply.code(502);
      return { error: "Could not price your order. Please try again." };
    }

    const totals: OrderTotals = {
      subtotalCents: priced.cart.subtotalCents,
      taxCents,
      tipCents: 0,
      totalCents,
      currency: "USD",
    };

    const draftId = randomUUID();
    await saveDraft(services.redisPublisher, draftId, {
      merchantId,
      locationId: store.locationId,
      order,
      lines: priced.cart.lines,
      totals,
    });

    const body: CreateOrderResponse = {
      orderId: draftId,
      // Provisional human label until the Clover order (with its real number)
      // exists at checkout; mirrors order-web's optimistic ticket.
      ticketNumber: `R-${draftId.slice(0, 4).toUpperCase()}`,
      totals,
      locationId: store.locationId,
      checkoutUrl: null,
      correlationId: null,
    };
    return body;
  });

  // Checkout = the money. Charge the clv_ token, create + settle a Clover order
  // so it reaches the KDS, and refund automatically if anything fails after the
  // charge. See lib/order-checkout.ts.
  app.post("/api/order/checkout", async (request, reply) => {
    const parsed = OrderCheckoutRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "Invalid checkout request." };
    }
    const { orderId: draftId, paymentToken, tipCents } = parsed.data;

    const draft = await loadDraft(services.redisPublisher, draftId);
    if (!draft) {
      reply.code(404);
      return { error: "Your order has expired. Please start again." };
    }

    // Phase A store-aware payment gate (FAIL-CLOSED): we hold ONE Clover Ecommerce
    // credential, which belongs to the configured merchant, and the hosted-iframe
    // token is minted for THAT merchant. An explicitly-selected store that isn't
    // the configured merchant — INCLUDING when no merchant is env-configured at all
    // (configuredMerchantId undefined → we can't confirm the store is payable) —
    // would settle the wrong account (pay merchant A, order from B), so refuse.
    // The default single-store path (draft.locationId == null) is untouched: its
    // merchant has always been the chargeable one.
    const configuredMerchantId = getConfiguredCloverMerchantId(services.config);
    if (draft.locationId && draft.merchantId !== configuredMerchantId) {
      request.log.warn(
        { selectedMerchant: draft.merchantId, configuredMerchant: configuredMerchantId },
        "checkout: online payment not configured for the selected store — refusing",
      );
      reply.code(503);
      return { error: "Online ordering isn't available at this store yet." };
    }

    const config = await resolveMerchantConfig(draft.merchantId);
    if (!config.tenderId) {
      request.log.error(
        { merchantId: draft.merchantId },
        "checkout: merchant has no External Payment tender — cannot settle online orders",
      );
      reply.code(503);
      return { error: "Online ordering is temporarily unavailable." };
    }

    // Customer IP for Clover's required x-forwarded-for on the charge.
    const forwarded = request.headers["x-forwarded-for"];
    const clientIp =
      (typeof forwarded === "string" ? forwarded.split(",")[0]?.trim() : undefined) || request.ip;

    let result;
    try {
      result = await checkoutOrder(services, {
        merchantId: draft.merchantId,
        draft,
        config: { orderTypeId: config.orderTypeId, tenderId: config.tenderId },
        paymentToken,
        tipCents,
        clientIp,
        // Deterministic per draft → a client retry can never double-charge.
        idempotencyKey: draftId,
        log: request.log,
      });
    } catch (err) {
      if (err instanceof CheckoutError) {
        const status = err.code === "payment_failed" ? 402 : err.code === "not_configured" ? 503 : 502;
        reply.code(status);
        return { error: err.message };
      }
      request.log.error({ err }, "checkout: unexpected failure");
      reply.code(500);
      return { error: "Something went wrong placing your order." };
    }

    // Single-use draft: consume it so a retry can't re-charge.
    await deleteDraft(services.redisPublisher, draftId).catch(() => undefined);

    const confirmation: OrderConfirmation = {
      orderId: result.cloverOrderId,
      ticketNumber: `R-${result.cloverOrderId.slice(-4).toUpperCase()}`,
      state: "paid",
      totals: {
        subtotalCents: draft.totals.subtotalCents,
        taxCents: draft.totals.taxCents,
        tipCents,
        totalCents: draft.totals.totalCents + tipCents,
        currency: draft.totals.currency,
      },
      locationId: draft.locationId,
      updatedAt: new Date().toISOString(),
    };
    return confirmation;
  });

  app.get<{ Params: { orderId: string } }>("/api/order/:orderId/status", async (request, reply) => {
    // Status resolves the DEFAULT merchant only — it deliberately does NOT honor a
    // client `?location=`. Clover order ids are merchant-scoped, so trusting a
    // caller-supplied store here would let a customer probe another store's order
    // by id. Per-order merchant resolution (from the order's own binding) is a
    // Phase B follow-up; order-web does not poll status with a store today.
    const store = await resolveOrderStore(services.prisma, services.config, undefined, request.log);
    if (!store) {
      reply.code(503);
      return { error: "Unavailable right now." };
    }
    const { merchantId } = store;

    const { orderId } = request.params;
    let order: Record<string, unknown>;
    try {
      order = await services.clover.fetchOrder(merchantId, orderId);
    } catch (err) {
      request.log.error({ err, orderId }, "order: status fetch failed");
      reply.code(404);
      return { error: "Order not found." };
    }

    const status: OrderStatusResponse = {
      orderId,
      ticketNumber: `R-${orderId.slice(-4).toUpperCase()}`,
      state: mapOrderStatus(order),
      locationId: store.locationId,
      updatedAt: new Date().toISOString(),
    };
    return status;
  });
}
