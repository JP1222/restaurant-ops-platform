import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppServices } from "../src/lib/services.js";
import { registerOrderRoutes } from "../src/routes/order.js";

const ITEMS = {
  elements: [
    {
      id: "I1",
      name: "Strawberry Roll",
      price: 899,
      available: true,
      categories: { elements: [{ id: "C1", name: "Signature Rolls" }] },
      modifierGroups: { elements: [] },
    },
  ],
};
const MODIFIER_GROUPS = { elements: [] };
const ORDER_TYPES = { elements: [] }; // bare merchant → no tax order type
const TENDERS = { elements: [{ id: "T1", labelKey: "com.clover.tender.external_payment" }] };

// Stateful Redis so a draft saved by POST /api/order can be read by checkout.
function makeRedis() {
  const store = new Map<string, string>();
  return {
    set: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
      return "OK";
    }),
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    del: vi.fn(async (key: string) => (store.delete(key) ? 1 : 0)),
  };
}

function makeServices(
  options: {
    merchantConfigured?: boolean;
    clover?: Record<string, ReturnType<typeof vi.fn>>;
    ecommerce?: Record<string, unknown>;
    // The active store `prisma.location.findFirst` resolves for a `?location=`
    // request (null = unknown/inactive store).
    location?: { id: string; cloverMerchants: Array<{ id: string }> } | null;
  } = {},
) {
  const merchantConfigured = options.merchantConfigured ?? true;
  const clover = {
    fetchMenuItems: vi.fn().mockResolvedValue(ITEMS),
    fetchModifierGroups: vi.fn().mockResolvedValue(MODIFIER_GROUPS),
    fetchOrderTypes: vi.fn().mockResolvedValue(ORDER_TYPES),
    fetchTenders: vi.fn().mockResolvedValue(TENDERS),
    // top-level total + totalTaxAmount (the real checkouts response shape).
    checkoutAtomicOrder: vi.fn().mockResolvedValue({ total: 987, totalTaxAmount: 88 }),
    createAtomicOrder: vi.fn().mockResolvedValue({ id: "ORDER1" }),
    createCustomer: vi.fn().mockResolvedValue({ id: "CUST1" }),
    attachCustomerToOrder: vi.fn().mockResolvedValue({}),
    recordOrderPayment: vi.fn().mockResolvedValue({ id: "pay1" }),
    fetchOrder: vi.fn().mockResolvedValue({ paymentState: "PAID" }),
    ...options.clover,
  };
  const cloverEcommerce = {
    configured: true,
    charge: vi.fn().mockResolvedValue({ id: "ch1", status: "succeeded", paid: true, amountCents: 1087 }),
    refund: vi.fn().mockResolvedValue({ id: "re1", status: "succeeded" }),
    ...options.ecommerce,
  };
  const services = {
    config: {
      cloverBaseUrl: "https://api.clover.com",
      cloverRegion: "US",
      ...(merchantConfigured
        ? { cloverMerchantId: "M1", cloverToken: "tok" }
        : { cloverMerchantId: undefined, cloverToken: undefined }),
    },
    prisma: {
      providerAppState: { findUnique: vi.fn().mockResolvedValue(null) },
      cloverMerchant: {
        findFirst: vi.fn().mockResolvedValue(null),
        findUnique: vi.fn().mockResolvedValue(null),
      },
      location: { findFirst: vi.fn().mockResolvedValue(options.location ?? null) },
    },
    clover,
    cloverEcommerce,
    redisPublisher: makeRedis(),
  };
  return { services: services as unknown as AppServices, clover, cloverEcommerce };
}

async function buildApp(services: AppServices) {
  const app = Fastify();
  await registerOrderRoutes(app, services);
  return app;
}

const DRAFT_LINE = {
  lineId: "l1",
  itemId: "I1",
  itemName: "Strawberry Roll",
  unitPriceCents: 1,
  quantity: 1,
  modifiers: [],
};

async function createDraft(app: Awaited<ReturnType<typeof buildApp>>, location?: string) {
  const res = await app.inject({
    method: "POST",
    url: location ? `/api/order?location=${encodeURIComponent(location)}` : "/api/order",
    payload: { customerName: "Jamie", customerPhone: "+19015550100", lines: [DRAFT_LINE] },
  });
  return res.json().orderId as string;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GET /api/order/menu", () => {
  it("serves the normalized Clover menu", async () => {
    const { services } = makeServices();
    const app = await buildApp(services);
    const res = await app.inject({ method: "GET", url: "/api/order/menu" });
    expect(res.statusCode).toBe(200);
    expect(res.json().items.map((item: { id: string }) => item.id)).toEqual(["I1"]);
    await app.close();
  });

  it("returns 503 when no merchant is resolved", async () => {
    const { services } = makeServices({ merchantConfigured: false });
    const app = await buildApp(services);
    const res = await app.inject({ method: "GET", url: "/api/order/menu" });
    expect(res.statusCode).toBe(503);
    await app.close();
  });
});

describe("POST /api/order (draft)", () => {
  it("prices authoritatively + reads the TOP-LEVEL Clover quote total/tax", async () => {
    const { services } = makeServices();
    const app = await buildApp(services);
    const res = await app.inject({
      method: "POST",
      url: "/api/order",
      payload: { customerName: "Jamie", lines: [DRAFT_LINE] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().totals).toMatchObject({
      subtotalCents: 899, // catalog (ignores client unitPriceCents: 1)
      taxCents: 88, // quote.totalTaxAmount (top-level)
      totalCents: 987, // quote.total (top-level)
      tipCents: 0,
    });
    await app.close();
  });

  it("rejects a draft whose item left the catalog (409)", async () => {
    const { services } = makeServices();
    const app = await buildApp(services);
    const res = await app.inject({
      method: "POST",
      url: "/api/order",
      payload: { customerName: "Jamie", lines: [{ ...DRAFT_LINE, itemId: "GONE" }] },
    });
    expect(res.statusCode).toBe(409);
    await app.close();
  });
});

describe("POST /api/order/checkout", () => {
  it("charges, places the order, and returns a paid confirmation", async () => {
    const { services, clover, cloverEcommerce } = makeServices();
    const app = await buildApp(services);
    const draftId = await createDraft(app);

    const res = await app.inject({
      method: "POST",
      url: "/api/order/checkout",
      payload: { orderId: draftId, paymentToken: "clv_test", tipCents: 100 },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ orderId: "ORDER1", state: "paid" });
    expect(body.totals.totalCents).toBe(1087); // 987 + 100 tip
    expect(cloverEcommerce.charge).toHaveBeenCalledTimes(1);
    expect(clover.recordOrderPayment).toHaveBeenCalledWith(
      "M1",
      "ORDER1",
      expect.objectContaining({ tenderId: "T1", tipAmount: 100 }),
    );
    await app.close();
  });

  it("returns 404 when the draft has expired", async () => {
    const { services } = makeServices();
    const app = await buildApp(services);
    const res = await app.inject({
      method: "POST",
      url: "/api/order/checkout",
      payload: { orderId: "missing-draft", paymentToken: "clv_test", tipCents: 0 },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("returns 402 when the card is declined and creates no order", async () => {
    const { services, clover } = makeServices({
      ecommerce: {
        charge: vi.fn().mockResolvedValue({ id: "ch1", status: "declined", paid: false, amountCents: 0 }),
      },
    });
    const app = await buildApp(services);
    const draftId = await createDraft(app);
    const res = await app.inject({
      method: "POST",
      url: "/api/order/checkout",
      payload: { orderId: draftId, paymentToken: "clv_test", tipCents: 0 },
    });
    expect(res.statusCode).toBe(402);
    expect(clover.createAtomicOrder).not.toHaveBeenCalled();
    await app.close();
  });
});

describe("GET /api/order/:orderId/status", () => {
  it("maps a paid Clover order to 'preparing'", async () => {
    const { services } = makeServices();
    const app = await buildApp(services);
    const res = await app.inject({ method: "GET", url: "/api/order/ORDER1/status" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ orderId: "ORDER1", state: "preparing" });
    await app.close();
  });
});

describe("store-aware routing (?location=)", () => {
  // M2 is a DIFFERENT store from the configured/payment merchant (M1).
  const STORE2 = { id: "loc2", cloverMerchants: [{ id: "M2" }] };
  // loc1 binds the configured merchant M1 — the one our Ecommerce key belongs to.
  const CONFIGURED_STORE = { id: "loc1", cloverMerchants: [{ id: "M1" }] };

  it("serves the selected store's menu when ?location= resolves", async () => {
    const { services, clover } = makeServices({ location: STORE2 });
    const app = await buildApp(services);
    const res = await app.inject({ method: "GET", url: "/api/order/menu?location=loc2" });
    expect(res.statusCode).toBe(200);
    expect(clover.fetchMenuItems).toHaveBeenCalledWith("M2");
    await app.close();
  });

  it("returns 404 (never the default store) for an unknown ?location=", async () => {
    const { services, clover } = makeServices(); // location.findFirst → null
    const app = await buildApp(services);
    const res = await app.inject({ method: "GET", url: "/api/order/menu?location=ghost" });
    expect(res.statusCode).toBe(404);
    // Crucially it did NOT silently fall back to the default merchant's menu.
    expect(clover.fetchMenuItems).not.toHaveBeenCalled();
    await app.close();
  });

  it("binds the draft to the selected store and echoes its locationId", async () => {
    const { services } = makeServices({ location: CONFIGURED_STORE });
    const app = await buildApp(services);
    const res = await app.inject({
      method: "POST",
      url: "/api/order?location=loc1",
      payload: { customerName: "Jamie", lines: [DRAFT_LINE] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().locationId).toBe("loc1");
    await app.close();
  });

  it("refuses checkout for a store that isn't the payment-configured merchant", async () => {
    const { services, cloverEcommerce } = makeServices({ location: STORE2 }); // M2 != M1
    const app = await buildApp(services);
    const draftId = await createDraft(app, "loc2");
    const res = await app.inject({
      method: "POST",
      url: "/api/order/checkout",
      payload: { orderId: draftId, paymentToken: "clv_test", tipCents: 0 },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toMatch(/isn't available at this store/i);
    // The wrong account is never charged.
    expect(cloverEcommerce.charge).not.toHaveBeenCalled();
    await app.close();
  });

  it("refuses an explicit store when no merchant is env-configured (fail-closed)", async () => {
    // configuredMerchantId is undefined here. The gate must still fire for an
    // explicitly-selected store — we can't confirm it's the payment merchant, so
    // we must NOT charge (the old `configuredMerchantId &&` guard fell open here).
    const { services, cloverEcommerce } = makeServices({
      merchantConfigured: false,
      location: STORE2,
    });
    const app = await buildApp(services);
    const draftId = await createDraft(app, "loc2");
    const res = await app.inject({
      method: "POST",
      url: "/api/order/checkout",
      payload: { orderId: draftId, paymentToken: "clv_test", tipCents: 0 },
    });
    expect(res.statusCode).toBe(503);
    expect(cloverEcommerce.charge).not.toHaveBeenCalled();
    await app.close();
  });

  it("allows checkout when the selected store IS the configured merchant", async () => {
    const { services, clover, cloverEcommerce } = makeServices({ location: CONFIGURED_STORE });
    const app = await buildApp(services);
    const draftId = await createDraft(app, "loc1");
    const res = await app.inject({
      method: "POST",
      url: "/api/order/checkout",
      payload: { orderId: draftId, paymentToken: "clv_test", tipCents: 0 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().locationId).toBe("loc1");
    expect(cloverEcommerce.charge).toHaveBeenCalledTimes(1);
    expect(clover.recordOrderPayment).toHaveBeenCalledWith("M1", "ORDER1", expect.anything());
    await app.close();
  });
});
