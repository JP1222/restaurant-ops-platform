import type { PrismaClient } from "@rop/db-kds";
import { beforeAll, describe, expect, it } from "vitest";

import {
  decodeStoredSecret,
  encryptSecretForStorage,
  hasStoredSecret,
  isNonSecretToken,
  resolveCloverMerchantSecrets,
  resolvePosAccessToken,
  resolvePosAccountSecrets
} from "../src/lib/pos-token.js";

// The AES-256-GCM helpers read AI_TOKEN_ENCRYPTION_KEY lazily at call time, so a
// fixed 64-char hex test key set before the encrypting cases run is enough.
beforeAll(() => {
  process.env.AI_TOKEN_ENCRYPTION_KEY = "a".repeat(64);
});

describe("isNonSecretToken", () => {
  it("treats empty / null / undefined and `:webhook` sentinels as non-secrets", () => {
    expect(isNonSecretToken("")).toBe(true);
    expect(isNonSecretToken(null)).toBe(true);
    expect(isNonSecretToken(undefined)).toBe(true);
    expect(isNonSecretToken("deliverect:webhook")).toBe(true);
    expect(isNonSecretToken("clv-real-token")).toBe(false);
  });
});

describe("encryptSecretForStorage", () => {
  it("encrypts a real secret into cipher bytes that decode back", () => {
    const cipher = encryptSecretForStorage("clv-real-token");
    expect(cipher).not.toBeNull();
    expect(decodeStoredSecret(cipher)).toBe("clv-real-token");
  });

  it("returns a null cipher for a `:webhook` sentinel (never encrypted, ADR-0019)", () => {
    expect(encryptSecretForStorage("deliverect:webhook")).toBeNull();
  });

  it("returns a null cipher for empty / null / undefined", () => {
    expect(encryptSecretForStorage("")).toBeNull();
    expect(encryptSecretForStorage(null)).toBeNull();
    expect(encryptSecretForStorage(undefined)).toBeNull();
  });

  it("randomizes the nonce so the same plaintext yields different ciphertext", () => {
    const a = encryptSecretForStorage("clv-real-token");
    const b = encryptSecretForStorage("clv-real-token");
    expect(Buffer.from(a!).equals(Buffer.from(b!))).toBe(false);
  });
});

describe("decodeStoredSecret (cipher-only)", () => {
  it("decrypts a populated cipher column", () => {
    expect(decodeStoredSecret(encryptSecretForStorage("from-cipher"))).toBe("from-cipher");
  });

  it("returns null for an empty / null / undefined cipher", () => {
    expect(decodeStoredSecret(null)).toBeNull();
    expect(decodeStoredSecret(undefined)).toBeNull();
    expect(decodeStoredSecret(new Uint8Array(0))).toBeNull();
  });
});

describe("hasStoredSecret (cipher-aware truthiness)", () => {
  it("is true when the cipher is set", () => {
    expect(hasStoredSecret(encryptSecretForStorage("x"))).toBe(true);
  });

  it("is false when the cipher is empty / null", () => {
    expect(hasStoredSecret(null)).toBe(false);
    expect(hasStoredSecret(new Uint8Array(0))).toBe(false);
  });
});

describe("resolveCloverMerchantSecrets / resolvePosAccountSecrets", () => {
  it("decodes a fully-encrypted clover_merchants row", () => {
    expect(
      resolveCloverMerchantSecrets({
        accessTokenCipher: encryptSecretForStorage("clv-access"),
        refreshTokenCipher: encryptSecretForStorage("clv-refresh"),
        recoveryTokenCipher: encryptSecretForStorage("clv-recovery")
      })
    ).toEqual({ accessToken: "clv-access", refreshToken: "clv-refresh", recoveryToken: "clv-recovery" });
  });

  it("reports absent secrets as empty/null when no cipher is set", () => {
    expect(
      resolveCloverMerchantSecrets({ accessTokenCipher: null, refreshTokenCipher: null, recoveryTokenCipher: null })
    ).toEqual({ accessToken: "", refreshToken: null, recoveryToken: null });
  });

  it("decodes a pos_accounts credential row", () => {
    expect(
      resolvePosAccountSecrets({ accessTokenCipher: encryptSecretForStorage("sq-access") })
    ).toEqual({ accessToken: "sq-access", refreshToken: null });
  });
});

// Minimal fake: only cloverMerchant.findUnique is exercised. `rows` is keyed by
// the PosStore id; each value is the row (with an optional included posAccount).
function fakePrisma(rows: Record<string, unknown>): PrismaClient {
  return {
    cloverMerchant: {
      findUnique: async ({ where }: { where: { id: string } }) => rows[where.id] ?? null
    }
  } as unknown as PrismaClient;
}

describe("resolvePosAccessToken", () => {
  it("returns the PosAccount token + provider + environment when linked (canonical path)", async () => {
    const prisma = fakePrisma({
      "square:LOC1": {
        id: "square:LOC1",
        // A Square PosStore row holds no token of its own — the credential is on
        // its linked PosAccount, encrypted in the cipher column.
        accessTokenCipher: null,
        posAccount: {
          accessTokenCipher: encryptSecretForStorage("sq-real-token"),
          provider: "SQUARE",
          environment: "STAGING"
        }
      }
    });
    const resolved = await resolvePosAccessToken(prisma, "square:LOC1");
    expect(resolved).toEqual({ token: "sq-real-token", provider: "SQUARE", environment: "STAGING" });
  });

  it("reads a Clover token cipher-only from the row's own column (no PosAccount)", async () => {
    const prisma = fakePrisma({
      MER999: {
        id: "MER999",
        accessTokenCipher: encryptSecretForStorage("clv-encrypted-token"),
        posAccount: null
      }
    });
    const resolved = await resolvePosAccessToken(prisma, "MER999");
    expect(resolved).toEqual({ token: "clv-encrypted-token", provider: "CLOVER", environment: null });
  });

  it("REFUSES a non-Clover row whose cipher is empty and has no PosAccount", async () => {
    const prisma = fakePrisma({
      "square:ORPHAN": { id: "square:ORPHAN", accessTokenCipher: null, posAccount: null }
    });
    await expect(resolvePosAccessToken(prisma, "square:ORPHAN")).rejects.toThrow(/no usable access token/);
  });

  it("REFUSES a PosAccount-linked row whose account credential is missing", async () => {
    const prisma = fakePrisma({
      "square:EMPTY": {
        id: "square:EMPTY",
        accessTokenCipher: null,
        posAccount: { accessTokenCipher: null, provider: "SQUARE", environment: "PRODUCTION" }
      }
    });
    await expect(resolvePosAccessToken(prisma, "square:EMPTY")).rejects.toThrow(/no usable access token/);
  });

  it("throws when the store does not exist", async () => {
    const prisma = fakePrisma({});
    await expect(resolvePosAccessToken(prisma, "nope")).rejects.toThrow(/not found/);
  });
});
