import { CREW_SESSION_COOKIE_NAME, signCrewSession } from "@rop/auth/crew";
import type { PrismaClient } from "@rop/db-inventory";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import type { AppConfig } from "../src/config.js";

const SESSION_SECRET = "test-session-secret-0000000000";
const INTERNAL = "test-internal-token-0000000000";

// Production so the CSRF Origin guard is active (it is a no-op in dev/test to
// mirror the all-origins CORS block).
const config: AppConfig = {
  nodeEnv: "production",
  apiPort: 4100,
  inventoryDatabaseUrl: "postgresql://test",
  backofficeBaseUrl: "http://localhost:3001",
  crewBaseUrl: "http://localhost:3003",
  internalToken: INTERNAL,
  crewSessionSecret: SESSION_SECRET,
  crewPinPepper: "test-pin-pepper-0000000000"
};

const employee = { id: "EMP-MR", name: "Maya Reyes", active: true };
const itemRow = {
  id: "ITEM-1",
  sku: "SKU-1",
  name: "Carnitas",
  categoryId: "food",
  unit: "lb",
  onHand: 10,
  parMin: 5,
  parMax: 20,
  costCents: 800,
  vendor: "Acme",
  shelfDays: 3,
  lastCounted: "2026-05-19",
  flagged86: false
};

const fakePrisma = {
  inventoryEmployee: {
    findUnique: async ({ where }: { where: { id?: string } }) =>
      where.id === employee.id ? employee : null
  },
  inventoryItem: {
    findUnique: async ({ where }: { where: { id: string } }) =>
      where.id === itemRow.id ? itemRow : null,
    update: async ({ where, data }: { where: { id: string }; data: { flagged86: boolean } }) => ({
      ...itemRow,
      id: where.id,
      flagged86: data.flagged86
    })
  },
  inventoryItemState: {
    findUnique: async () => null,
    upsert: async ({ create }: { create: Record<string, unknown> }) => create
  },
  inventoryPurchaseOrder: {
    findUnique: async () => null
  },
  inventoryActivityEntry: { create: async () => ({}) },
  inventoryStockMovement: { create: async () => ({}), createMany: async () => ({}), findUnique: async () => null },
  $transaction: async (fn: (tx: unknown) => unknown) => fn(fakePrisma),
  $disconnect: async () => {}
} as unknown as PrismaClient;

function crewToken() {
  return signCrewSession(
    { employeeId: employee.id, name: employee.name, exp: Date.now() + 60_000 },
    SESSION_SECRET
  );
}

let app: Awaited<ReturnType<typeof buildApp>>;

beforeAll(async () => {
  app = await buildApp({ config, prisma: fakePrisma });
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe("path-id length guard", () => {
  const oversizedId = "x".repeat(65);

  it("rejects an oversized toggle-86 item id with 400 (before Prisma)", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/inventory/items/${oversizedId}/toggle-86`,
      headers: { authorization: `Bearer ${INTERNAL}` },
      payload: { confirm: true }
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects an oversized PO id on the receive route with 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/inventory/pos/${oversizedId}/receive`,
      headers: { authorization: `Bearer ${INTERNAL}` },
      payload: { lines: [{ sku: "sku-001", qty: 1 }], who: "Backoffice" }
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects an oversized PO id on the GET detail route with 400", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/inventory/pos/${oversizedId}`
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("CSRF Origin guard (crew-session writes in production)", () => {
  it("rejects a crew-session write whose Origin is not allowed", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/inventory/items/ITEM-1/toggle-86",
      cookies: { [CREW_SESSION_COOKIE_NAME]: crewToken() },
      headers: { origin: "https://evil.example" },
      payload: { confirm: true }
    });
    expect(res.statusCode).toBe(403);
  });

  it("rejects a crew-session write whose Referer resolves to an untrusted origin", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/inventory/items/ITEM-1/toggle-86",
      cookies: { [CREW_SESSION_COOKIE_NAME]: crewToken() },
      headers: { referer: "https://evil.example/attack" },
      payload: { confirm: true }
    });
    expect(res.statusCode).toBe(403);
  });

  it("allows a crew-session write from an allowed Origin", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/inventory/items/ITEM-1/toggle-86",
      cookies: { [CREW_SESSION_COOKIE_NAME]: crewToken() },
      headers: { origin: "http://localhost:3003" },
      payload: { confirm: true }
    });
    expect(res.statusCode).toBe(200);
  });

  it("does not apply the Origin guard to the bearer path", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/inventory/items/ITEM-1/toggle-86",
      headers: { authorization: `Bearer ${INTERNAL}`, origin: "https://evil.example" },
      payload: { confirm: true }
    });
    expect(res.statusCode).toBe(200);
  });
});
