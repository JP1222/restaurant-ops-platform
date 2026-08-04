import type { PrismaClient } from "@rop/db-kds";
import { describe, expect, it, vi } from "vitest";

import type { AppConfig } from "../src/config.js";
import {
  bootstrapSquareAccountFromEnv,
  canBootstrapSquareAccountFromEnv,
  persistSquareConnection,
  SquarePersistError
} from "../src/lib/square-account.js";
import type { SquareClient, SquareConnectionInfo } from "../src/lib/square-client.js";
import { decodeStoredSecret } from "../src/lib/pos-token.js";

function info(over: Partial<SquareConnectionInfo> = {}): SquareConnectionInfo {
  return {
    merchantId: "MER1",
    merchantName: "Example Kitchen",
    locations: [{ id: "LOC1", name: "Downtown", timezone: "America/Chicago", currency: "USD" }],
    ...over
  };
}

function fakePrisma() {
  const posAccountUpsert = vi.fn(async () => ({ id: "acct_generated" }));
  const cloverMerchantUpsert = vi.fn(async ({ where }: { where: { id: string } }) => ({
    id: where.id,
    locationId: null
  }));
  const $transaction = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
    fn({ posAccount: { upsert: posAccountUpsert }, cloverMerchant: { upsert: cloverMerchantUpsert } })
  );
  const prisma = { $transaction } as unknown as PrismaClient;
  return { prisma, posAccountUpsert, cloverMerchantUpsert, $transaction };
}

describe("persistSquareConnection", () => {
  it("creates one PosAccount + one PosStore per location in a single transaction", async () => {
    const { prisma, posAccountUpsert, cloverMerchantUpsert, $transaction } = fakePrisma();
    const result = await persistSquareConnection(
      prisma,
      info({
        locations: [
          { id: "LOC1", name: "Downtown", timezone: "America/Chicago", currency: "USD" },
          { id: "LOC2", name: "Mall", timezone: "America/Chicago", currency: "USD" }
        ]
      }),
      "sq0-secret-token",
      "sandbox"
    );

    expect($transaction).toHaveBeenCalledTimes(1);
    expect(posAccountUpsert).toHaveBeenCalledTimes(1);
    expect(posAccountUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          provider_providerMerchantId_environment: {
            provider: "SQUARE",
            providerMerchantId: "MER1",
            environment: "STAGING"
          }
        },
        // Token is encrypted at rest: real value lives only in the cipher column.
        create: expect.objectContaining({ provider: "SQUARE", environment: "STAGING" })
      })
    );
    const createdAccount = posAccountUpsert.mock.calls[0][0].create as { accessTokenCipher: Uint8Array };
    expect(decodeStoredSecret(createdAccount.accessTokenCipher)).toBe("sq0-secret-token");
    expect(cloverMerchantUpsert).toHaveBeenCalledTimes(2);
    // Square PosStore: synthetic id, no token of its own (token lives on account).
    expect(cloverMerchantUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "square:LOC1" },
        create: expect.objectContaining({ id: "square:LOC1", providerStoreId: "LOC1" })
      })
    );
    expect(result.posAccountId).toBe("acct_generated");
    expect(result.stores.map((s) => s.posStoreId)).toEqual(["square:LOC1", "square:LOC2"]);
  });

  it("maps production -> PRODUCTION on the PosAccount", async () => {
    const { prisma, posAccountUpsert } = fakePrisma();
    await persistSquareConnection(prisma, info(), "tok", "production");
    expect(posAccountUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          provider_providerMerchantId_environment: expect.objectContaining({ environment: "PRODUCTION" })
        })
      })
    );
  });

  it("fails closed (no transaction) when a location id would overflow the VarChar(32) PK", async () => {
    const { prisma, $transaction } = fakePrisma();
    const longId = "L".repeat(30); // `square:` + 30 = 37 > 32
    await expect(
      persistSquareConnection(
        prisma,
        info({ locations: [{ id: longId, name: "X", timezone: "America/Chicago", currency: "USD" }] }),
        "tok",
        "sandbox"
      )
    ).rejects.toBeInstanceOf(SquarePersistError);
    expect($transaction).not.toHaveBeenCalled();
  });
});

describe("bootstrapSquareAccountFromEnv", () => {
  it("is a no-op when SQUARE_ACCESS_TOKEN is unset", async () => {
    const { prisma, $transaction } = fakePrisma();
    const square = { validateAndListLocations: vi.fn() } as unknown as SquareClient;
    const config = { squareEnvironment: "sandbox" } as unknown as AppConfig;
    expect(canBootstrapSquareAccountFromEnv(config)).toBe(false);
    await bootstrapSquareAccountFromEnv(prisma, config, square);
    expect(square.validateAndListLocations).not.toHaveBeenCalled();
    expect($transaction).not.toHaveBeenCalled();
  });

  it("validates the env token and persists when SQUARE_ACCESS_TOKEN is set", async () => {
    const { prisma, posAccountUpsert } = fakePrisma();
    const square = { validateAndListLocations: vi.fn(async () => info()) } as unknown as SquareClient;
    const config = { squareAccessToken: "env-tok", squareEnvironment: "sandbox" } as unknown as AppConfig;
    expect(canBootstrapSquareAccountFromEnv(config)).toBe(true);
    await bootstrapSquareAccountFromEnv(prisma, config, square);
    expect(square.validateAndListLocations).toHaveBeenCalledWith("env-tok", "sandbox");
    expect(posAccountUpsert).toHaveBeenCalledTimes(1);
  });
});
