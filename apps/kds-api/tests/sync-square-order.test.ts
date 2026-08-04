import { describe, expect, it, vi } from "vitest";

import { syncSquareOrderById } from "../src/lib/sync-order.js";
import { encryptSecretForStorage } from "../src/lib/pos-token.js";

// The PosStore row resolveSquareStoreCredentials + resolvePosAccessToken read.
// Tokens are cipher-only; the Square store row holds none of its own (it's on
// the linked PosAccount, encrypted in the cipher column).
const squareRow = {
  id: "square:LOC1",
  providerStoreId: "LOC1",
  accessTokenCipher: null,
  posAccount: {
    provider: "SQUARE",
    environment: "STAGING",
    accessTokenCipher: encryptSecretForStorage("sq-token"),
  },
};

describe("syncSquareOrderById", () => {
  it("resolves the store credential and fetches by id; a vanished order is a no-op", async () => {
    const fetchOrder = vi.fn(async () => null); // Square returned no such order
    const services = {
      prisma: { cloverMerchant: { findUnique: vi.fn(async () => squareRow) } },
      square: { fetchOrder },
    } as never;

    const result = await syncSquareOrderById(services, "square:LOC1", "ORD1", "reconciliation");

    expect(result).toBeNull();
    // STAGING environment maps to the sandbox host; the token comes off the
    // PosAccount, never re-sent by a caller.
    expect(fetchOrder).toHaveBeenCalledWith("sq-token", "sandbox", "ORD1");
  });

  it("refuses a non-Square store (fail closed, never fetches)", async () => {
    const fetchOrder = vi.fn(async () => null);
    const cloverRow = { ...squareRow, posAccount: { ...squareRow.posAccount, provider: "CLOVER" } };
    const services = {
      prisma: { cloverMerchant: { findUnique: vi.fn(async () => cloverRow) } },
      square: { fetchOrder },
    } as never;

    await expect(syncSquareOrderById(services, "M2", "ORD1", "reconciliation")).rejects.toMatchObject({
      name: "SquareStoreError",
      kind: "not_square",
    });
    expect(fetchOrder).not.toHaveBeenCalled();
  });
});
