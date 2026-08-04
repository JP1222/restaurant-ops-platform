import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { CloverClient } from "../../src/lib/clover-client.js";
import { ConfigSchema } from "../../src/config.js";
import { decryptSecret } from "../../src/lib/crypto/encryption.js";
import { persistSquareConnection } from "../../src/lib/square-account.js";
import type { SquareConnectionInfo } from "../../src/lib/square-client.js";
import { startKdsItContext, type KdsItContext } from "./fixture.js";

/**
 * At-rest encryption invariant: a POS access token written through the canonical
 * write seams (Square connect, Clover env bootstrap) must NEVER land in the
 * database as plaintext. The ~unit tests mock Prisma, so they can only prove the
 * shape of the `data` object passed to `upsert` — only a real Postgres can prove
 * what is actually persisted in the column. This suite reads the RAW cipher
 * column and asserts the secret round-trips through it and never appears in the
 * clear. Tokens are cipher-only since 20260618_drop_pos_token_plaintext dropped
 * the legacy plaintext columns; a guard below proves those columns are gone.
 */
describe("POS access token encryption at rest (integration)", () => {
  let ctx: KdsItContext;

  beforeAll(async () => {
    ctx = await startKdsItContext();
  }, 120_000);

  afterAll(async () => {
    await ctx?.stop();
  });

  it("Square connect persists the token encrypted — plaintext absent from pos_accounts", async () => {
    const SECRET = "sq-sandbox-SUPERSECRET-token-9988";
    const info: SquareConnectionInfo = {
      merchantId: "ITSQMERCHANT",
      merchantName: "IT Seller",
      locations: [{ id: "ITLOC1", name: "IT Store", timezone: "America/Chicago", currency: "USD" }]
    };

    const res = await persistSquareConnection(ctx.prismaKds, info, SECRET, "sandbox");

    const accountRows = await ctx.prismaKds.$queryRaw<
      Array<{ accessTokenCipher: Uint8Array | null }>
    >`SELECT "accessTokenCipher" FROM "pos_accounts" WHERE "id" = ${res.posAccountId}`;

    expect(accountRows).toHaveLength(1);
    const account = accountRows[0];
    expect(account.accessTokenCipher).not.toBeNull();
    // The plaintext token appears NOWHERE in the stored cipher bytes.
    const cipher = Buffer.from(account.accessTokenCipher!);
    expect(cipher.toString("utf8")).not.toContain(SECRET);
    expect(cipher.toString("latin1")).not.toContain(SECRET);
    // ...but it round-trips back to the original under the master key.
    expect(decryptSecret(cipher)).toBe(SECRET);

    // The Square PosStore row holds no token of its own (credential on account).
    const storeRows = await ctx.prismaKds.$queryRaw<
      Array<{ accessTokenCipher: Uint8Array | null; posAccountId: string | null }>
    >`SELECT "accessTokenCipher", "posAccountId" FROM "clover_merchants" WHERE "id" = 'square:ITLOC1'`;
    expect(storeRows).toHaveLength(1);
    expect(storeRows[0].accessTokenCipher).toBeNull();
    expect(storeRows[0].posAccountId).toBe(res.posAccountId);
    expect(res.stores.map((s) => s.posStoreId)).toEqual(["square:ITLOC1"]);
  });

  it("Clover env bootstrap persists its token encrypted — plaintext absent from clover_merchants", async () => {
    const SECRET = "clv-SUPERSECRET-bootstrap-token-4242";
    const config = ConfigSchema.parse({
      databaseUrl: "postgres://unused",
      redisUrl: "redis://unused",
      nodeEnv: "development",
      cloverMerchantId: "ITCLOVERMERCHANT",
      cloverToken: SECRET
    });
    const client = new CloverClient(ctx.prismaKds, config);

    await client.bootstrapMerchantFromEnv();

    const rows = await ctx.prismaKds.$queryRaw<
      Array<{ accessTokenCipher: Uint8Array | null }>
    >`SELECT "accessTokenCipher" FROM "clover_merchants" WHERE "id" = 'ITCLOVERMERCHANT'`;

    expect(rows).toHaveLength(1);
    expect(rows[0].accessTokenCipher).not.toBeNull();
    const cipher = Buffer.from(rows[0].accessTokenCipher!);
    expect(cipher.toString("utf8")).not.toContain(SECRET);
    expect(decryptSecret(cipher)).toBe(SECRET);
  });

  it("the legacy plaintext token columns are dropped (cipher-only schema)", async () => {
    // End-to-end proof that 20260618_drop_pos_token_plaintext applied: none of the
    // five plaintext token columns exist on the migrated database.
    const cols = await ctx.prismaKds.$queryRaw<Array<{ table_name: string; column_name: string }>>`
      SELECT table_name, column_name
      FROM information_schema.columns
      WHERE (table_name = 'pos_accounts' AND column_name IN ('accessToken', 'refreshToken'))
         OR (table_name = 'clover_merchants' AND column_name IN ('accessToken', 'refreshToken', 'recoveryToken'))`;
    expect(cols).toEqual([]);
  });
});
