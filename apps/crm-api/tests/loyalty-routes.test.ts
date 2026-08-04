import type { PrismaClient } from "@rop/db-crm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/app.js";
import type { AppConfig } from "../src/config.js";

const INTERNAL = "test-internal-token-000000000000";

const config: AppConfig = {
  nodeEnv: "test",
  apiPort: 4200,
  crmDatabaseUrl: "postgresql://test",
  internalToken: INTERNAL,
  allowedOrigins: undefined
};

const KNOWN_PHONE = "+19015550100";

const knownCustomer = {
  id: "cust-1",
  phoneE164: KNOWN_PHONE,
  displayName: "Jane",
  email: null,
  birthMonth: 6,
  marketingSmsConsent: true,
  createdAt: new Date("2026-05-01T00:00:00.000Z"),
  account: {
    id: "acct-1",
    balancePoints: 320,
    pendingPoints: 50,
    lifetimeEarned: 370,
    lifetimeRedeemed: 0,
    lifetimeEligibleSpendCents: 3700,
    lastActivityAt: new Date("2026-05-29T00:00:00.000Z")
  }
};

const rewards = [
  { slug: "free-topping", label: "Free topping", costPoints: 100, kind: "FREE_ITEM", valueCents: 100 },
  { slug: "free-regular", label: "Free regular", costPoints: 850, kind: "FREE_ITEM", valueCents: 650 }
];

const ledger = [
  {
    type: "EARN",
    points: 64,
    status: "AVAILABLE",
    source: "clover_order",
    occurredAt: new Date("2026-05-29T00:00:00.000Z")
  }
];

const createMock = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
  id: "cust-new",
  phoneE164: data.phoneE164 as string,
  displayName: (data.displayName as string | null) ?? null,
  email: (data.email as string | null) ?? null,
  birthMonth: (data.birthMonth as number | null) ?? null,
  marketingSmsConsent: (data.marketingSmsConsent as boolean) ?? false,
  createdAt: new Date("2026-05-30T00:00:00.000Z")
}));

const fakePrisma = {
  crmReward: { findMany: async () => rewards },
  crmCustomer: {
    findUnique: async ({ where }: { where: { phoneE164: string } }) =>
      where.phoneE164 === KNOWN_PHONE ? knownCustomer : null,
    create: createMock
  },
  crmPointsLedger: { findMany: async () => ledger },
  $queryRaw: async () => [{ ok: 1 }],
  $disconnect: async () => {}
} as unknown as PrismaClient;

const bearer = { authorization: `Bearer ${INTERNAL}` };

let app: Awaited<ReturnType<typeof buildApp>>;

beforeAll(async () => {
  app = await buildApp({ config, prisma: fakePrisma });
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe("GET /api/loyalty/rewards (public)", () => {
  it("returns active rungs without a bearer token", async () => {
    const res = await app.inject({ method: "GET", url: "/api/loyalty/rewards" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.rewards).toHaveLength(2);
    expect(body.rewards[0]).toMatchObject({ slug: "free-topping", cost_points: 100, kind: "FREE_ITEM" });
  });
});

describe("bearer guard", () => {
  it("401s on a PII read without the token", async () => {
    const res = await app.inject({ method: "GET", url: `/api/loyalty/balance?phone=${encodeURIComponent(KNOWN_PHONE)}` });
    expect(res.statusCode).toBe(401);
  });

  it("401s on enroll without the token", async () => {
    const res = await app.inject({ method: "POST", url: "/api/loyalty/enroll", payload: { phone: "9015550200" } });
    expect(res.statusCode).toBe(401);
  });
});

describe("POST /api/loyalty/enroll", () => {
  it("normalizes a bare US number and creates a new member (201)", async () => {
    createMock.mockClear();
    const res = await app.inject({
      method: "POST",
      url: "/api/loyalty/enroll",
      headers: bearer,
      payload: { phone: "(901) 555-0200", displayName: "New Cust" }
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().phone_e164).toBe("+19015550200");
    expect(createMock).toHaveBeenCalledTimes(1);
  });

  it("is idempotent — an existing number returns 200, no create", async () => {
    createMock.mockClear();
    const res = await app.inject({
      method: "POST",
      url: "/api/loyalty/enroll",
      headers: bearer,
      payload: { phone: KNOWN_PHONE }
    });
    expect(res.statusCode).toBe(200);
    expect(createMock).not.toHaveBeenCalled();
  });

  it("400s on an unrecognizable phone", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/loyalty/enroll",
      headers: bearer,
      payload: { phone: "12" }
    });
    expect(res.statusCode).toBe(400);
  });

  it("returns 200 (not 500) when a concurrent enroll wins the insert race (GH #465)", async () => {
    const racePhone = "+19015550300";
    const raced = {
      id: "cust-raced",
      phoneE164: racePhone,
      displayName: null,
      email: null,
      birthMonth: null,
      marketingSmsConsent: false,
      createdAt: new Date("2026-05-31T00:00:00.000Z")
    };
    // Initial check misses; the create loses the race and throws P2002; the
    // re-read then finds the row the concurrent request inserted.
    const findUnique = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(raced);
    const create = vi.fn().mockRejectedValueOnce({ code: "P2002" });
    const original = (fakePrisma as { crmCustomer: unknown }).crmCustomer;
    (fakePrisma as { crmCustomer: unknown }).crmCustomer = { findUnique, create };

    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/loyalty/enroll",
        headers: bearer,
        payload: { phone: "9015550300" }
      });
      expect(res.statusCode).toBe(200); // idempotent — not a 500
      expect(res.json().phone_e164).toBe(racePhone);
      expect(create).toHaveBeenCalledTimes(1);
      expect(findUnique).toHaveBeenCalledTimes(2);
    } finally {
      (fakePrisma as { crmCustomer: unknown }).crmCustomer = original;
    }
  });
});

describe("GET /api/loyalty/balance", () => {
  it("returns the cached projection for an enrolled member", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/loyalty/balance?phone=${encodeURIComponent(KNOWN_PHONE)}`,
      headers: bearer
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      phone_e164: KNOWN_PHONE,
      balance_points: 320,
      pending_points: 50,
      lifetime_earned: 370
    });
  });

  it("404s for a number that isn't enrolled", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/loyalty/balance?phone=9015559999",
      headers: bearer
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("GET /api/loyalty/history", () => {
  it("returns redacted ledger entries newest-first", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/loyalty/history?phone=${encodeURIComponent(KNOWN_PHONE)}`,
      headers: bearer
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0]).toMatchObject({ type: "EARN", points: 64, status: "AVAILABLE", source: "clover_order" });
  });
});
