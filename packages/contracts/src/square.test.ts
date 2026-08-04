import { describe, expect, it } from "vitest";

import {
  CatalogImportResultSchema,
  SquareConnectRequestSchema,
  SquareConnectResponseSchema,
  SquareEnvironmentSchema,
  SquareImportCatalogRequestSchema,
  SquareRecipeImportSchema,
  SquareTestConnectionResponseSchema,
  squareEnvironments
} from "./square.js";

describe("Square onboarding contracts", () => {
  it("accepts the two environments and rejects anything else", () => {
    expect(squareEnvironments).toEqual(["sandbox", "production"]);
    expect(SquareEnvironmentSchema.parse("sandbox")).toBe("sandbox");
    expect(SquareEnvironmentSchema.parse("production")).toBe("production");
    expect(SquareEnvironmentSchema.safeParse("staging").success).toBe(false);
    expect(SquareEnvironmentSchema.safeParse("SANDBOX").success).toBe(false);
  });

  it("requires a non-empty token + a valid environment on the connect request", () => {
    expect(
      SquareConnectRequestSchema.parse({ accessToken: "EAAA-tok", environment: "sandbox" })
    ).toEqual({ accessToken: "EAAA-tok", environment: "sandbox" });
    expect(SquareConnectRequestSchema.safeParse({ accessToken: "", environment: "sandbox" }).success).toBe(false);
    expect(SquareConnectRequestSchema.safeParse({ accessToken: "x", environment: "prod" }).success).toBe(false);
    expect(SquareConnectRequestSchema.safeParse({ environment: "sandbox" }).success).toBe(false);
  });

  it("round-trips a test-connection response", () => {
    const input = {
      merchantId: "MER123",
      merchantName: "Example Kitchen Downtown",
      environment: "sandbox" as const,
      locations: [
        { id: "LOC1", name: "Downtown", timezone: "America/Chicago", currency: "USD" }
      ]
    };
    expect(SquareTestConnectionResponseSchema.parse(input)).toEqual(input);
  });

  it("round-trips a connect response with stores", () => {
    const input = {
      posAccountId: "acct_x",
      merchantId: "MER123",
      merchantName: "Example Kitchen Downtown",
      environment: "production" as const,
      tokenLast4: "9821",
      stores: [
        {
          posStoreId: "square:LOC1",
          providerStoreId: "LOC1",
          name: "Downtown",
          timezone: "America/Chicago",
          currency: "USD",
          locationId: null
        }
      ]
    };
    expect(SquareConnectResponseSchema.parse(input)).toEqual(input);
  });

  // Write-only guard: the token must never survive onto a response shape. zod
  // strips unknown keys, so even if a caller spreads the request token into a
  // response object, parse drops it.
  it("strips any stray token off the response schemas (write-only)", () => {
    const testConn = SquareTestConnectionResponseSchema.parse({
      merchantId: "MER123",
      merchantName: "Store",
      environment: "sandbox",
      locations: [],
      accessToken: "leaked-secret"
    } as Record<string, unknown>);
    expect(testConn).not.toHaveProperty("accessToken");

    const connect = SquareConnectResponseSchema.parse({
      posAccountId: "acct_x",
      merchantId: "MER123",
      merchantName: "Store",
      environment: "sandbox",
      tokenLast4: "9821",
      stores: [],
      accessToken: "leaked-secret"
    } as Record<string, unknown>);
    expect(connect).not.toHaveProperty("accessToken");
  });

  it("requires a non-empty posStoreId on the import-catalog request", () => {
    expect(SquareImportCatalogRequestSchema.parse({ posStoreId: "square:LOC1" })).toEqual({
      posStoreId: "square:LOC1"
    });
    expect(SquareImportCatalogRequestSchema.safeParse({ posStoreId: "" }).success).toBe(false);
    expect(SquareImportCatalogRequestSchema.safeParse({}).success).toBe(false);
  });

  it("round-trips a catalog-import result and rejects negatives / non-integers", () => {
    const result = { itemCount: 42, modifierCount: 9, categoryCount: 5, durationMs: 1234 };
    expect(CatalogImportResultSchema.parse(result)).toEqual(result);
    expect(CatalogImportResultSchema.safeParse({ ...result, itemCount: -1 }).success).toBe(false);
    expect(CatalogImportResultSchema.safeParse({ ...result, durationMs: 1.5 }).success).toBe(false);
  });

  it("validates the recipe-import pipe rows (the inventory-side trust boundary)", () => {
    const rows = [
      { squareCatalogObjectId: "SQ_VANILLA", name: "Vanilla Roll", category: "ROLLED ICE CREAM", priceCents: 699 },
      { squareCatalogObjectId: "SQ_MANGO", name: "Mango Roll", category: "SPECIALS", priceCents: 0 }
    ];
    expect(SquareRecipeImportSchema.parse(rows)).toEqual(rows);
    // A blank category is allowed (the normalizer falls back); id/name must be non-empty.
    expect(SquareRecipeImportSchema.safeParse([{ ...rows[0], squareCatalogObjectId: "" }]).success).toBe(false);
    expect(SquareRecipeImportSchema.safeParse([{ ...rows[0], name: "" }]).success).toBe(false);
    expect(SquareRecipeImportSchema.safeParse([{ ...rows[0], priceCents: -1 }]).success).toBe(false);
    expect(SquareRecipeImportSchema.safeParse([{ ...rows[0], priceCents: 1.5 }]).success).toBe(false);
  });
});
