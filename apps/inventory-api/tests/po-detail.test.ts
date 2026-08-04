import type { PrismaClient } from "@rop/db-inventory";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/app.js";
import type { AppConfig } from "../src/config.js";

const INTERNAL = "test-internal-token-0000000000";

const config: AppConfig = {
  nodeEnv: "test",
  apiPort: 4100,
  inventoryDatabaseUrl: "postgresql://test",
  backofficeBaseUrl: "http://localhost:3001",
  crewBaseUrl: "http://localhost:3003",
  internalToken: INTERNAL,
  crewSessionSecret: "test-session-secret-0000000000",
  crewPinPepper: "test-pin-pepper-0000000000"
};

const po = {
  id: "PO-1",
  locationId: "default-location",
  vendor: "Acme",
  placed: "2026-05-20",
  expected: "2026-05-21",
  lines: 1,
  status: "in-transit",
  totalCents: 5000,
  lineItems: [{ id: "L1", poId: "PO-1", sku: "sku-001", qtyOrdered: 10, qtyReceived: 0 }]
};

const item = {
  id: "sku-001",
  sku: "PRT-CHK-THI",
  name: "Chicken thigh",
  categoryId: "food",
  unit: "lb",
  onHand: 5,
  parMin: 5,
  parMax: 20,
  costCents: 320,
  vendor: "Acme",
  shelfDays: 4,
  lastCounted: "2026-05-19",
  flagged86: false
};

const poLineUpdateMany = vi.fn(async () => ({ count: 1 }));
const itemStateUpsert = vi.fn(async ({ create }: { create: Record<string, unknown> }) => create);

const fakePrisma = {
  inventoryPurchaseOrder: {
    // getPurchaseOrder is location-scoped (ADR-0018 Phase 4): it now reads via
    // findFirst({ where: { id, locationId } }), so the PO only resolves for its
    // own store — a different-location actor gets null (→ 404).
    findFirst: async ({ where }: { where: { id: string; locationId?: string } }) =>
      where.id === po.id && (where.locationId === undefined || where.locationId === po.locationId)
        ? po
        : null,
    findUnique: async ({ where }: { where: { id: string } }) => (where.id === po.id ? po : null),
    update: async ({ where }: { where: { id: string } }) => ({ ...po, id: where.id, status: "received" })
  },
  inventoryItem: {
    findMany: async () => [item],
    findUnique: async ({ where }: { where: { id: string } }) => (where.id === item.id ? item : null)
  },
  inventoryItemState: {
    findUnique: async () => null,
    upsert: itemStateUpsert
  },
  inventoryPoLine: { updateMany: poLineUpdateMany },
  inventoryActivityEntry: { create: async () => ({}) },
  inventoryStockMovement: { create: async () => ({}), createMany: async () => ({}), findUnique: async () => null },
  // receivePurchaseOrder now takes a per-location advisory lock as its first
  // statement (2026-06-16 audit #1); the mocked tx must answer $executeRaw.
  $executeRaw: async () => 0,
  $transaction: async (fn: (tx: unknown) => unknown) => fn(fakePrisma),
  $disconnect: async () => {}
} as unknown as PrismaClient;

let app: Awaited<ReturnType<typeof buildApp>>;

beforeAll(async () => {
  app = await buildApp({ config, prisma: fakePrisma });
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe("GET /api/inventory/pos/:id", () => {
  it("returns the PO with line items (name/unit joined from the item)", async () => {
    const res = await app.inject({ method: "GET", url: "/api/inventory/pos/PO-1" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.id).toBe("PO-1");
    expect(body.line_items).toHaveLength(1);
    expect(body.line_items[0]).toMatchObject({
      sku: "sku-001",
      name: "Chicken thigh",
      unit: "lb",
      qty_ordered: 10,
      qty_received: 0
    });
  });

  it("404s for an unknown PO", async () => {
    const res = await app.inject({ method: "GET", url: "/api/inventory/pos/NOPE" });
    expect(res.statusCode).toBe(404);
  });

  it("404s when the PO exists but belongs to a different location (cross-store read denied, #429)", async () => {
    // The bearer/BFF path resolves the store from `?location=` (locationFor).
    // PO-1 lives in default-location, so a location-B caller must NOT see it —
    // location-scoped read closes the cross-store PO enumeration (ADR-0018 Phase 4).
    const res = await app.inject({
      method: "GET",
      url: "/api/inventory/pos/PO-1?location=location-b",
      headers: { authorization: `Bearer ${INTERNAL}` }
    });
    expect(res.statusCode).toBe(404);

    // Sanity: the same PO id IS readable from its own location.
    const own = await app.inject({
      method: "GET",
      url: "/api/inventory/pos/PO-1?location=default-location",
      headers: { authorization: `Bearer ${INTERNAL}` }
    });
    expect(own.statusCode).toBe(200);
    expect(own.json().id).toBe("PO-1");
  });
});

describe("POST /api/inventory/pos/:id/receive", () => {
  it("bumps on_hand and records qty_received per line", async () => {
    poLineUpdateMany.mockClear();
    itemStateUpsert.mockClear();
    const res = await app.inject({
      method: "POST",
      url: "/api/inventory/pos/PO-1/receive",
      headers: { authorization: `Bearer ${INTERNAL}` },
      payload: { lines: [{ sku: "sku-001", qty: 8 }], who: "Backoffice" }
    });
    expect(res.statusCode).toBe(200);
    expect(itemStateUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: expect.objectContaining({ onHand: 13 }) })
    );
    expect(poLineUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { poId: "PO-1", sku: "sku-001" },
        data: { qtyReceived: 8 }
      })
    );
  });
});
