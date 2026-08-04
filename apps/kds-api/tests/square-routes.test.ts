import type { PrismaClient } from "@rop/db-kds";
import { IntegrationEnvironment, OrderProvider } from "@rop/db-kds";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AppConfig } from "../src/config.js";
import { registerSquareRoutes } from "../src/routes/square.js";
import { SquareConnectError, type SquareClient, type SquareConnectionInfo } from "../src/lib/square-client.js";
import type { SquareCatalogObject } from "../src/domain/normalize-square-catalog.js";
import { encryptSecretForStorage } from "../src/lib/pos-token.js";

const BEARER = "square-routes-internal-bearer-1234567890";

const CONNECTION: SquareConnectionInfo = {
  merchantId: "MER1",
  merchantName: "Example Kitchen Downtown",
  locations: [{ id: "LOC1", name: "Downtown", timezone: "America/Chicago", currency: "USD" }]
};

function fakePrisma() {
  const posAccountUpsert = vi.fn(async () => ({ id: "acct_1" }));
  const cloverMerchantUpsert = vi.fn(async ({ where }: { where: { id: string } }) => ({ id: where.id, locationId: null }));
  const $transaction = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
    fn({ posAccount: { upsert: posAccountUpsert }, cloverMerchant: { upsert: cloverMerchantUpsert } })
  );
  return { prisma: { $transaction } as unknown as PrismaClient, $transaction };
}

// A PosStore row for the import path: covers both our {id, providerStoreId}
// select and resolvePosAccessToken's include:{posAccount} (findUnique ignores the
// select/include and returns the whole row).
function squareStorePrisma(): PrismaClient {
  return {
    cloverMerchant: {
      findUnique: vi.fn(async () => ({
        id: "square:LOC1",
        providerStoreId: "LOC1",
        accessTokenCipher: null,
        posAccount: {
          provider: OrderProvider.SQUARE,
          environment: IntegrationEnvironment.PRODUCTION,
          accessTokenCipher: encryptSecretForStorage("sq-token")
        }
      }))
    }
  } as unknown as PrismaClient;
}

function makeServices(opts: {
  square: Partial<Pick<SquareClient, "validateAndListLocations" | "fetchCatalog">>;
  prisma?: PrismaClient;
  kdsInternalAdminToken?: string | undefined;
  hasToken?: boolean;
}) {
  return {
    config: {
      kdsInternalAdminToken: "kdsInternalAdminToken" in opts ? opts.kdsInternalAdminToken : BEARER
    } as unknown as AppConfig,
    prisma: opts.prisma ?? fakePrisma().prisma,
    square: opts.square as SquareClient
  };
}

async function withApp(
  services: ReturnType<typeof makeServices>,
  fn: (app: FastifyInstance) => Promise<void>
) {
  const app = Fastify();
  await registerSquareRoutes(app, services as never);
  try {
    await fn(app);
  } finally {
    await app.close();
  }
}

const bearer = { authorization: `Bearer ${BEARER}` };
const json = { ...bearer, "content-type": "application/json" };

afterEach(() => vi.restoreAllMocks());

describe("POST /api/square/test-connection", () => {
  it("401s without a bearer", async () => {
    await withApp(makeServices({ square: { validateAndListLocations: vi.fn() } }), async (app) => {
      const res = await app.inject({ method: "POST", url: "/api/square/test-connection" });
      expect(res.statusCode).toBe(401);
    });
  });

  it("503s when the internal admin token is not configured", async () => {
    await withApp(
      makeServices({ square: { validateAndListLocations: vi.fn() }, kdsInternalAdminToken: undefined }),
      async (app) => {
        const res = await app.inject({
          method: "POST",
          url: "/api/square/test-connection",
          headers: json,
          payload: { accessToken: "tok", environment: "sandbox" }
        });
        expect(res.statusCode).toBe(503);
      }
    );
  });

  it("returns merchant + locations on a valid probe (persists nothing)", async () => {
    const square = { validateAndListLocations: vi.fn(async () => CONNECTION) };
    const { prisma, $transaction } = fakePrisma();
    await withApp(makeServices({ square, prisma }), async (app) => {
      const res = await app.inject({
        method: "POST",
        url: "/api/square/test-connection",
        headers: json,
        payload: { accessToken: "sq-tok", environment: "sandbox" }
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        merchantId: "MER1",
        merchantName: "Example Kitchen Downtown",
        environment: "sandbox",
        locations: [{ id: "LOC1", name: "Downtown", timezone: "America/Chicago", currency: "USD" }]
      });
      expect($transaction).not.toHaveBeenCalled();
    });
  });

  it("400s invalid_body on a malformed payload", async () => {
    await withApp(makeServices({ square: { validateAndListLocations: vi.fn() } }), async (app) => {
      const res = await app.inject({
        method: "POST",
        url: "/api/square/test-connection",
        headers: json,
        payload: { accessToken: "", environment: "sandbox" }
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("invalid_body");
    });
  });

  it("maps an invalid token to 400 invalid_token", async () => {
    const square = {
      validateAndListLocations: vi.fn(async () => {
        throw new SquareConnectError("invalid_token", 401);
      })
    };
    await withApp(makeServices({ square }), async (app) => {
      const res = await app.inject({
        method: "POST",
        url: "/api/square/test-connection",
        headers: json,
        payload: { accessToken: "bad", environment: "sandbox" }
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("invalid_token");
    });
  });
});

describe("POST /api/square/connect", () => {
  it("persists one PosAccount + PosStore and returns tokenLast4 (never the token)", async () => {
    const square = { validateAndListLocations: vi.fn(async () => CONNECTION) };
    const { prisma, $transaction } = fakePrisma();
    await withApp(makeServices({ square, prisma }), async (app) => {
      const res = await app.inject({
        method: "POST",
        url: "/api/square/connect",
        headers: json,
        payload: { accessToken: "sq-secret-9821", environment: "sandbox" }
      });
      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.posAccountId).toBe("acct_1");
      expect(body.merchantName).toBe("Example Kitchen Downtown");
      expect(body.tokenLast4).toBe("9821");
      expect(body.stores[0].posStoreId).toBe("square:LOC1");
      expect(body).not.toHaveProperty("accessToken");
      expect($transaction).toHaveBeenCalledTimes(1);
    });
  });

  it("fails closed: an invalid token writes nothing", async () => {
    const square = {
      validateAndListLocations: vi.fn(async () => {
        throw new SquareConnectError("invalid_token", 401);
      })
    };
    const { prisma, $transaction } = fakePrisma();
    await withApp(makeServices({ square, prisma }), async (app) => {
      const res = await app.inject({
        method: "POST",
        url: "/api/square/connect",
        headers: json,
        payload: { accessToken: "bad", environment: "sandbox" }
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("invalid_token");
      expect($transaction).not.toHaveBeenCalled();
    });
  });
});

describe("POST /api/square/import-catalog", () => {
  const CATALOG: SquareCatalogObject[] = [
    { type: "CATEGORY", id: "CAT1", categoryData: { name: "Scoops" } },
    {
      type: "ITEM",
      id: "ITEM1",
      itemData: {
        name: "Vanilla",
        reportingCategory: { id: "CAT1" },
        variations: [
          { type: "ITEM_VARIATION", id: "V1", itemVariationData: { pricingType: "FIXED_PRICING", priceMoney: { amount: 450n } } }
        ]
      }
    }
  ];

  it("401s without a bearer", async () => {
    await withApp(makeServices({ square: {} }), async (app) => {
      const res = await app.inject({ method: "POST", url: "/api/square/import-catalog" });
      expect(res.statusCode).toBe(401);
    });
  });

  it("400s invalid_body when posStoreId is missing", async () => {
    await withApp(makeServices({ square: {} }), async (app) => {
      const res = await app.inject({
        method: "POST",
        url: "/api/square/import-catalog",
        headers: json,
        payload: {}
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("invalid_body");
    });
  });

  it("returns counts + a non-negative durationMs for a connected Square store", async () => {
    const fetchCatalog = vi.fn(async () => CATALOG);
    await withApp(makeServices({ square: { fetchCatalog }, prisma: squareStorePrisma() }), async (app) => {
      const res = await app.inject({
        method: "POST",
        url: "/api/square/import-catalog",
        headers: json,
        payload: { posStoreId: "square:LOC1" }
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.itemCount).toBe(1);
      expect(body.categoryCount).toBe(1);
      expect(body.modifierCount).toBe(0);
      expect(body.durationMs).toBeGreaterThanOrEqual(0);
      expect(fetchCatalog).toHaveBeenCalledWith("sq-token", "production");
    });
  });

  it("404s not_found for an unknown PosStore", async () => {
    const prisma = { cloverMerchant: { findUnique: vi.fn(async () => null) } } as unknown as PrismaClient;
    await withApp(makeServices({ square: { fetchCatalog: vi.fn() }, prisma }), async (app) => {
      const res = await app.inject({
        method: "POST",
        url: "/api/square/import-catalog",
        headers: json,
        payload: { posStoreId: "square:GONE" }
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().error).toBe("not_found");
    });
  });

  it("409s not_square when the store is not a Square store", async () => {
    const prisma = {
      cloverMerchant: {
        findUnique: vi.fn(async () => ({
          id: "M2",
          providerStoreId: "M2",
          accessTokenCipher: null,
          posAccount: {
            provider: OrderProvider.CLOVER,
            environment: IntegrationEnvironment.PRODUCTION,
            accessTokenCipher: encryptSecretForStorage("clover-tok")
          }
        }))
      }
    } as unknown as PrismaClient;
    const fetchCatalog = vi.fn();
    await withApp(makeServices({ square: { fetchCatalog }, prisma }), async (app) => {
      const res = await app.inject({
        method: "POST",
        url: "/api/square/import-catalog",
        headers: json,
        payload: { posStoreId: "M2" }
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe("not_square");
      expect(fetchCatalog).not.toHaveBeenCalled();
    });
  });

  it("maps an upstream Square failure during paging (invalid_token -> 400)", async () => {
    const fetchCatalog = vi.fn(async () => {
      throw new SquareConnectError("invalid_token", 401);
    });
    await withApp(makeServices({ square: { fetchCatalog }, prisma: squareStorePrisma() }), async (app) => {
      const res = await app.inject({
        method: "POST",
        url: "/api/square/import-catalog",
        headers: json,
        payload: { posStoreId: "square:LOC1" }
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("invalid_token");
    });
  });
});
