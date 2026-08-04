import {
  CREW_SESSION_COOKIE_NAME,
  hashPin,
  pinLookupHash,
  signCrewSession
} from "@rop/auth/crew";
import type { PrismaClient } from "@rop/db-inventory";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/app.js";
import type { AppConfig } from "../src/config.js";

const PEPPER = "test-pin-pepper-0000000000";
const SESSION_SECRET = "test-session-secret-0000000000";
const INTERNAL = "test-internal-token-0000000000";

const config: AppConfig = {
  nodeEnv: "test",
  apiPort: 4100,
  inventoryDatabaseUrl: "postgresql://test",
  backofficeBaseUrl: "http://localhost:3001",
  crewBaseUrl: "http://localhost:3003",
  internalToken: INTERNAL,
  crewSessionSecret: SESSION_SECRET,
  crewPinPepper: PEPPER
};

const employee = {
  id: "EMP-MR",
  name: "Maya Reyes",
  role: "Prep Lead",
  shift: "AM",
  initials: "MR",
  color: "#1F8A5B",
  active: true,
  pinHash: "",
  pinLookup: ""
};

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

const disabledEmployee = { ...employee, id: "EMP-OFF", name: "Off Duty", active: false };

const activityCreate = vi.fn(async () => ({}));

const fakePrisma = {
  inventoryEmployee: {
    findUnique: async ({ where }: { where: { pinLookup?: string; id?: string } }) => {
      if (where.pinLookup !== undefined) {
        return where.pinLookup === employee.pinLookup ? employee : null;
      }
      if (where.id !== undefined) {
        if (where.id === employee.id) return employee;
        if (where.id === disabledEmployee.id) return disabledEmployee;
        return null;
      }
      return null;
    }
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
  inventoryActivityEntry: { create: activityCreate },
  inventoryStockMovement: { create: async () => ({}), createMany: async () => ({}), findUnique: async () => null },
  $transaction: async (fn: (tx: unknown) => unknown) => fn(fakePrisma),
  $disconnect: async () => {}
} as unknown as PrismaClient;

let app: Awaited<ReturnType<typeof buildApp>>;

beforeAll(async () => {
  employee.pinHash = await hashPin("1234");
  employee.pinLookup = pinLookupHash("1234", PEPPER);
  app = await buildApp({ config, prisma: fakePrisma });
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe("POST /api/crew/login", () => {
  it("issues a token + safe employee for a valid PIN", async () => {
    const res = await app.inject({ method: "POST", url: "/api/crew/login", payload: { pin: "1234" } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.employee).toMatchObject({ id: "EMP-MR", name: "Maya Reyes" });
    expect(body.employee.pinHash).toBeUndefined();
    expect(body.employee.pinLookup).toBeUndefined();
    expect(typeof body.token).toBe("string");
  });

  it("rejects a wrong PIN", async () => {
    const res = await app.inject({ method: "POST", url: "/api/crew/login", payload: { pin: "0000" } });
    expect(res.statusCode).toBe(401);
  });

  // Issue #121: the limiter key is now (ip, pin-prefix). A different prefix
  // from the same IP must NOT see the same bucket — otherwise one cook's
  // fat-finger locks every other cook out at the shared ingress IP. Uses
  // prefix "77" (unique to this test) so bucket state can't leak across tests.
  it("isolates rate-limit buckets per PIN prefix from the same IP", async () => {
    for (let i = 0; i < 5; i++) {
      const res = await app.inject({
        method: "POST",
        url: "/api/crew/login",
        payload: { pin: "7777" }
      });
      expect(res.statusCode).toBe(401);
    }
    const locked = await app.inject({
      method: "POST",
      url: "/api/crew/login",
      payload: { pin: "7777" }
    });
    expect(locked.statusCode).toBe(429);

    // A different prefix from the same client IP must still be allowed in:
    // PIN "1234" lives in bucket (ip, "12"), not (ip, "77").
    const allowed = await app.inject({
      method: "POST",
      url: "/api/crew/login",
      payload: { pin: "1234" }
    });
    expect(allowed.statusCode).toBe(200);
  });
});

// Issue #121: X-Forwarded-For must only be trusted when the request comes
// from a configured proxy IP/CIDR. The default test app has trustProxyCidr
// unset (= trustProxy: false), so a spoofed XFF must be ignored — request.ip
// resolves to the socket peer, not the forwarded value. Uses prefix "88"
// (unique to this test) so bucket state can't leak across tests.
describe("trustProxy: spoofed X-Forwarded-For is ignored without trust config", () => {
  it("does not pin the rate-limit bucket to a spoofed XFF", async () => {
    for (let i = 0; i < 5; i++) {
      const res = await app.inject({
        method: "POST",
        url: "/api/crew/login",
        payload: { pin: "8888" },
        headers: { "x-forwarded-for": "1.2.3.4" }
      });
      expect(res.statusCode).toBe(401);
    }
    // Switch XFF to a "fresh" IP. If trustProxy were on, the limiter would
    // see a brand-new key and let the attacker in. With trustProxy: false
    // request.ip is still the socket peer, so the bucket stays locked.
    const res = await app.inject({
      method: "POST",
      url: "/api/crew/login",
      payload: { pin: "8888" },
      headers: { "x-forwarded-for": "9.9.9.9" }
    });
    expect(res.statusCode).toBe(429);
  });
});

// Issue #121: when TRUST_PROXY_CIDR includes the test socket peer (127.0.0.1),
// the limiter MUST key on the forwarded client IP so two devices behind the
// ingress get separate buckets. Builds a fresh app instance because trustProxy
// is fixed at construction.
describe("trustProxy: configured CIDR consumes X-Forwarded-For", () => {
  it("buckets separately by forwarded client IP from the same proxy", async () => {
    const proxiedApp = await buildApp({
      config: { ...config, trustProxyCidr: "127.0.0.1,::1" },
      prisma: fakePrisma
    });
    try {
      // Burn the (1.1.1.1, "66") bucket from device A behind the proxy.
      for (let i = 0; i < 5; i++) {
        const res = await proxiedApp.inject({
          method: "POST",
          url: "/api/crew/login",
          payload: { pin: "6666" },
          headers: { "x-forwarded-for": "1.1.1.1" }
        });
        expect(res.statusCode).toBe(401);
      }
      const lockedA = await proxiedApp.inject({
        method: "POST",
        url: "/api/crew/login",
        payload: { pin: "6666" },
        headers: { "x-forwarded-for": "1.1.1.1" }
      });
      expect(lockedA.statusCode).toBe(429);

      // Device B behind the same proxy must still get in — pre-fix this would
      // have been 429 because both devices shared the ingress IP key.
      const okB = await proxiedApp.inject({
        method: "POST",
        url: "/api/crew/login",
        payload: { pin: "1234" },
        headers: { "x-forwarded-for": "2.2.2.2" }
      });
      expect(okB.statusCode).toBe(200);
    } finally {
      await proxiedApp.close();
    }
  });
});

describe("POST /api/crew/logout", () => {
  // Issue #202: logout must clear the session cookie server-side. It's
  // best-effort (the token stays valid until TTL), but the Set-Cookie clear
  // header stops a shared-device handoff from leaking the previous session.
  it("returns 204 and emits a Set-Cookie that clears the crew session", async () => {
    const res = await app.inject({ method: "POST", url: "/api/crew/logout" });
    expect(res.statusCode).toBe(204);
    const setCookie = res.headers["set-cookie"];
    const header = Array.isArray(setCookie) ? setCookie.join("; ") : (setCookie ?? "");
    expect(header).toContain(`${CREW_SESSION_COOKIE_NAME}=`);
    // A clear is an empty value + an expiry in the past (Fastify/cookie emits
    // `Expires=Thu, 01 Jan 1970` and/or `Max-Age=0`).
    expect(header).toMatch(/Expires=Thu, 01 Jan 1970|Max-Age=0/);
    expect(header).toContain("Path=/");
  });
});

describe("GET /api/crew/me", () => {
  it("returns the employee for a valid session cookie", async () => {
    const token = signCrewSession(
      { employeeId: "EMP-MR", name: "Maya Reyes", exp: Date.now() + 60_000 },
      SESSION_SECRET
    );
    const res = await app.inject({
      method: "GET",
      url: "/api/crew/me",
      cookies: { [CREW_SESSION_COOKIE_NAME]: token }
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().employee).toMatchObject({ id: "EMP-MR" });
  });

  it("401s without a session", async () => {
    const res = await app.inject({ method: "GET", url: "/api/crew/me" });
    expect(res.statusCode).toBe(401);
  });
});

describe("write dual-auth + server-side actor", () => {
  it("rejects a write with neither a crew session nor the bearer token", async () => {
    const res = await app.inject({ method: "POST", url: "/api/inventory/items/ITEM-1/toggle-86" });
    expect(res.statusCode).toBe(401);
  });

  it("accepts a crew session and records the actor from the session", async () => {
    activityCreate.mockClear();
    const token = signCrewSession(
      { employeeId: "EMP-MR", name: "Maya Reyes", exp: Date.now() + 60_000 },
      SESSION_SECRET
    );
    const res = await app.inject({
      method: "POST",
      url: "/api/inventory/items/ITEM-1/toggle-86",
      cookies: { [CREW_SESSION_COOKIE_NAME]: token },
      payload: { confirm: true }
    });
    expect(res.statusCode).toBe(200);
    expect(activityCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ who: "Maya Reyes" }) })
    );
  });

  it("rejects a write from a disabled employee's still-valid session", async () => {
    const token = signCrewSession(
      { employeeId: "EMP-OFF", name: "Off Duty", exp: Date.now() + 60_000 },
      SESSION_SECRET
    );
    const res = await app.inject({
      method: "POST",
      url: "/api/inventory/items/ITEM-1/toggle-86",
      cookies: { [CREW_SESSION_COOKIE_NAME]: token }
    });
    expect(res.statusCode).toBe(401);
  });

  it("accepts the internal bearer token (backoffice path)", async () => {
    activityCreate.mockClear();
    const res = await app.inject({
      method: "POST",
      url: "/api/inventory/items/ITEM-1/toggle-86",
      headers: { authorization: `Bearer ${INTERNAL}` },
      payload: { confirm: true }
    });
    expect(res.statusCode).toBe(200);
    expect(activityCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ who: "Backoffice" }) })
    );
  });

  it("rejects a write with a wrong bearer token", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/inventory/items/ITEM-1/toggle-86",
      headers: { authorization: `Bearer wrong-${INTERNAL}` },
      payload: { confirm: true }
    });
    expect(res.statusCode).toBe(401);
  });

  it("rejects toggle-86 with a missing or malformed body (unsafe verb requires confirm)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/inventory/items/ITEM-1/toggle-86",
      headers: { authorization: `Bearer ${INTERNAL}` }
    });
    expect(res.statusCode).toBe(400);
  });
});
