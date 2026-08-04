import type { PrismaClient } from "@rop/db-kds";
import { IntegrationEnvironment, OrderProvider } from "@rop/db-kds";
import { describe, expect, it, vi } from "vitest";

import type { SquareCatalogObject } from "../src/domain/normalize-square-catalog.js";
import type { SquareClient } from "../src/lib/square-client.js";
import { encryptSecretForStorage } from "../src/lib/pos-token.js";
import {
  fetchSquareStoreCatalog,
  importSquareCatalog,
  loadSquareMenu,
  squareLocationIdFromPosStoreId,
  SquareStoreError,
} from "../src/lib/square-menu.js";

const CATALOG: SquareCatalogObject[] = [
  { type: "CATEGORY", id: "CAT1", categoryData: { name: "Scoops" } },
  {
    type: "ITEM",
    id: "ITEM1",
    itemData: {
      name: "Vanilla",
      reportingCategory: { id: "CAT1" },
      variations: [
        {
          type: "ITEM_VARIATION",
          id: "V1",
          itemVariationData: {
            pricingType: "FIXED_PRICING",
            priceMoney: { amount: 450n },
            locationOverrides: [{ locationId: "LOC1", priceMoney: { amount: 500n } }],
          },
        },
      ],
    },
  },
];

// A row shape covering both reads: our {id, providerStoreId} select AND
// resolvePosAccessToken's include:{posAccount}. The findUnique mock ignores the
// select/include and returns the whole row.
function fakePrisma(row: Record<string, unknown> | null): PrismaClient {
  return {
    cloverMerchant: { findUnique: vi.fn(async () => row) },
  } as unknown as PrismaClient;
}

function squareRow(opts: {
  provider?: OrderProvider;
  environment?: IntegrationEnvironment;
  providerStoreId?: string | null;
  accessToken?: string;
}) {
  return {
    id: "square:LOC1",
    providerStoreId: opts.providerStoreId === undefined ? "LOC1" : opts.providerStoreId,
    accessTokenCipher: null,
    posAccount: {
      provider: opts.provider ?? OrderProvider.SQUARE,
      environment: opts.environment ?? IntegrationEnvironment.PRODUCTION,
      accessTokenCipher: encryptSecretForStorage(opts.accessToken ?? "sq-token"),
    },
  };
}

function fakeSquare(objects: SquareCatalogObject[]): {
  square: SquareClient;
  fetchCatalog: ReturnType<typeof vi.fn>;
} {
  const fetchCatalog = vi.fn(async () => objects);
  return { square: { fetchCatalog } as unknown as SquareClient, fetchCatalog };
}

describe("squareLocationIdFromPosStoreId", () => {
  it("strips the square: prefix", () => {
    expect(squareLocationIdFromPosStoreId("square:LOC1")).toBe("LOC1");
    expect(squareLocationIdFromPosStoreId("LOC1")).toBe("LOC1");
  });
});

describe("fetchSquareStoreCatalog", () => {
  it("resolves the token + bound location and pages the catalog (production env)", async () => {
    const prisma = fakePrisma(squareRow({ environment: IntegrationEnvironment.PRODUCTION }));
    const { square, fetchCatalog } = fakeSquare(CATALOG);
    const result = await fetchSquareStoreCatalog(prisma, square, "square:LOC1");
    expect(result.locationId).toBe("LOC1");
    expect(result.objects).toEqual(CATALOG);
    expect(fetchCatalog).toHaveBeenCalledWith("sq-token", "production");
  });

  it("maps a STAGING PosAccount environment to the sandbox host", async () => {
    const prisma = fakePrisma(squareRow({ environment: IntegrationEnvironment.STAGING }));
    const { square, fetchCatalog } = fakeSquare(CATALOG);
    await fetchSquareStoreCatalog(prisma, square, "square:LOC1");
    expect(fetchCatalog).toHaveBeenCalledWith("sq-token", "sandbox");
  });

  it("falls back to the prefix-stripped location id when providerStoreId is null", async () => {
    const prisma = fakePrisma(squareRow({ providerStoreId: null }));
    const { square } = fakeSquare(CATALOG);
    const result = await fetchSquareStoreCatalog(prisma, square, "square:LOC1");
    expect(result.locationId).toBe("LOC1");
  });

  it("throws not_found for a missing PosStore", async () => {
    const prisma = fakePrisma(null);
    const { square } = fakeSquare(CATALOG);
    await expect(fetchSquareStoreCatalog(prisma, square, "square:GONE")).rejects.toMatchObject({
      name: "SquareStoreError",
      kind: "not_found",
    });
  });

  it("throws not_square when the bound account is not Square", async () => {
    const prisma = fakePrisma(squareRow({ provider: OrderProvider.CLOVER }));
    const { square, fetchCatalog } = fakeSquare(CATALOG);
    await expect(fetchSquareStoreCatalog(prisma, square, "square:LOC1")).rejects.toBeInstanceOf(
      SquareStoreError,
    );
    expect(fetchCatalog).not.toHaveBeenCalled();
  });
});

describe("loadSquareMenu", () => {
  it("normalizes the fetched catalog into an OrderMenuResponse", async () => {
    const prisma = fakePrisma(squareRow({}));
    const { square } = fakeSquare(CATALOG);
    const menu = await loadSquareMenu(prisma, square, "square:LOC1");
    expect(menu.categories).toEqual(["Scoops"]);
    expect(menu.items).toHaveLength(1);
    expect(menu.items[0]?.priceCents).toBe(500); // location override applied
  });
});

describe("importSquareCatalog", () => {
  it("returns item/modifier/category counts", async () => {
    const prisma = fakePrisma(squareRow({}));
    const { square } = fakeSquare(CATALOG);
    const counts = await importSquareCatalog(prisma, square, "square:LOC1");
    expect(counts).toEqual({ itemCount: 1, modifierCount: 0, categoryCount: 1 });
  });
});
