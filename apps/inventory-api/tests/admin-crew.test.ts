import { CREW_SESSION_COOKIE_NAME, pinLookupHash, signCrewSession } from "@rop/auth/crew";
import type { PrismaClient } from "@rop/db-inventory";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import type { AppConfig } from "../src/config.js";

const INTERNAL = "test-internal-token-0000000000";
const PEPPER = "test-pin-pepper-00000000000000";
const SESSION_SECRET = "test-session-secret-0000000000";

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

const bearer = { authorization: `Bearer ${INTERNAL}` };
const DUP_LOOKUP = pinLookupHash("999999", PEPPER);

function row(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: "e1",
    name: "Ana",
    role: "Line",
    shift: "AM",
    initials: "AN",
    color: "#111111",
    pinHash: "hash",
    pinLookup: "lookup-1",
    active: true,
    locationId: "default-location",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-02T00:00:00.000Z"),
    ...over
  };
}

let employees: ReturnType<typeof row>[];

const fakePrisma = {
  inventoryEmployee: {
    findMany: async (args?: { where?: { locationId?: string } }) => {
      const loc = args?.where?.locationId;
      return loc ? employees.filter((e) => e.locationId === loc) : employees;
    },
    findUnique: async ({ where }: { where: { id: string } }) =>
      employees.find((e) => e.id === where.id) ?? null,
    create: async ({ data }: { data: Record<string, unknown> }) => {
      if (employees.some((e) => e.pinLookup === data.pinLookup)) {
        throw Object.assign(new Error("unique"), { code: "P2002" });
      }
      const created = row({ ...data, createdAt: new Date(), updatedAt: new Date() });
      employees.push(created);
      return created;
    },
    update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      const existing = employees.find((e) => e.id === where.id)!;
      Object.assign(existing, data, { updatedAt: new Date() });
      return existing;
    }
  },
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

beforeEach(() => {
  employees = [
    row(),
    row({ id: "e2", name: "Bob", active: false, pinLookup: DUP_LOOKUP })
  ];
});

describe("admin crew auth guard", () => {
  it("rejects requests with no bearer token", async () => {
    const res = await app.inject({ method: "GET", url: "/api/admin/crew" });
    expect(res.statusCode).toBe(401);
  });

  it("rejects a wrong bearer token", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/admin/crew",
      headers: { authorization: `Bearer wrong-${INTERNAL}` }
    });
    expect(res.statusCode).toBe(401);
  });

  it("rejects a valid crew session cookie (managers only, bearer required)", async () => {
    const token = signCrewSession(
      { employeeId: "e1", name: "Ana", exp: Date.now() + 60_000 },
      SESSION_SECRET
    );
    const res = await app.inject({
      method: "GET",
      url: "/api/admin/crew",
      headers: { cookie: `${CREW_SESSION_COOKIE_NAME}=${token}` }
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("GET /api/admin/crew", () => {
  it("lists employees without exposing PIN material", async () => {
    const res = await app.inject({ method: "GET", url: "/api/admin/crew", headers: bearer });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.employees).toHaveLength(2);
    expect(body.employees[0]).toMatchObject({ id: "e1", name: "Ana", active: true });
    expect(body.employees[0].created_at).toBe("2026-01-01T00:00:00.000Z");
    expect(body.employees[0]).not.toHaveProperty("pinHash");
    expect(body.employees[0]).not.toHaveProperty("pinLookup");
  });
});

describe("POST /api/admin/crew", () => {
  it("creates an employee with a unique PIN", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/admin/crew",
      headers: bearer,
      payload: { name: "Cleo Diaz", role: "Prep", shift: "PM", pin: "135724" }
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.employee.name).toBe("Cleo Diaz");
    expect(body.employee.initials).toBe("CD");
    expect(body.employee).not.toHaveProperty("pinHash");
  });

  it("409s when the PIN is already in use", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/admin/crew",
      headers: bearer,
      payload: { name: "Dup", role: "Prep", shift: "PM", pin: "999999" }
    });
    expect(res.statusCode).toBe(409);
  });

  it("400s on a non-6-digit PIN", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/admin/crew",
      headers: bearer,
      payload: { name: "Eve", role: "Prep", shift: "PM", pin: "12" }
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("PATCH /api/admin/crew/:id", () => {
  it("disables an employee", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/api/admin/crew/e1",
      headers: bearer,
      payload: { active: false }
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().employee.active).toBe(false);
  });

  it("404s for an unknown employee", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/api/admin/crew/nope",
      headers: bearer,
      payload: { name: "X" }
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("POST /api/admin/crew/:id/pin", () => {
  it("resets a PIN", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/admin/crew/e1/pin",
      headers: bearer,
      payload: { pin: "246802" }
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().employee.id).toBe("e1");
  });
});

describe("store scoping (?location=)", () => {
  it("scopes the roster to the active store", async () => {
    // Seed crew are all in default-location; store-2 has none yet.
    const res = await app.inject({
      method: "GET",
      url: "/api/admin/crew?location=store-2",
      headers: bearer
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().employees).toHaveLength(0);
  });

  it("creates a hire in the active store, isolated from other stores", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/admin/crew?location=store-2",
      headers: bearer,
      payload: { name: "Faye Ortiz", role: "Line", shift: "AM", pin: "314159" }
    });
    expect(created.statusCode).toBe(201);

    const inStore2 = await app.inject({
      method: "GET",
      url: "/api/admin/crew?location=store-2",
      headers: bearer
    });
    expect(inStore2.json().employees.map((e: { name: string }) => e.name)).toContain("Faye Ortiz");

    // The isolation that was missing: the hire is NOT in store #1's roster.
    const inDefault = await app.inject({
      method: "GET",
      url: "/api/admin/crew?location=default-location",
      headers: bearer
    });
    expect(
      inDefault.json().employees.map((e: { name: string }) => e.name)
    ).not.toContain("Faye Ortiz");
  });

  it("falls back to the default store when no ?location= is given", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/admin/crew",
      headers: bearer,
      payload: { name: "Gus Park", role: "Prep", shift: "PM", pin: "271828" }
    });
    expect(created.statusCode).toBe(201);
    const inDefault = await app.inject({
      method: "GET",
      url: "/api/admin/crew?location=default-location",
      headers: bearer
    });
    expect(inDefault.json().employees.map((e: { name: string }) => e.name)).toContain("Gus Park");
  });
});
