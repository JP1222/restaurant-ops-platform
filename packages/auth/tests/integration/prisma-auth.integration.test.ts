import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  findCredentialByCredentialId,
  getAdminAccountByUsername,
  getPasskeyCount,
  hashPassword,
  savePasskeyCredential,
  toWebAuthnCredential,
  updateCredentialUsage,
  verifyAdminPassword,
} from "../../src/server/index.js";
import { startAuthItContext, type AuthItContext } from "./fixture.js";

// Replaces the long-standing `describe.skip` placeholder
// (tests/server/prisma-integration.test.ts): real account + password + passkey
// persistence against the db-auth schema in an ephemeral Postgres. Proves the
// shared-DB Prisma mechanic and the argon2 / Bytes / JSON / FK-cascade columns.
describe("packages/auth integration (real db-auth Postgres)", () => {
  let ctx: AuthItContext;

  beforeAll(async () => {
    ctx = await startAuthItContext();
  });

  afterAll(async () => {
    await ctx?.stop();
  });

  beforeEach(async () => {
    await ctx.truncate();
  });

  async function seedOwner(password = "pw-correct-horse"): Promise<string> {
    const account = await ctx.prisma.webAdminAccount.create({
      data: { username: "owner", displayName: "Owner", passwordHash: await hashPassword(password) },
    });
    return account.id;
  }

  it("persists an admin account and verifies its password with argon2", async () => {
    await seedOwner("correct-horse-battery-staple");

    const found = await getAdminAccountByUsername(ctx.prisma, "owner");
    expect(found?.username).toBe("owner");
    // Default role is OWNER post-ADR-0029 (was ADMIN); account seeded without
    // an explicit role picks up the new column default.
    expect(found?.role).toBe("OWNER");

    // Real argon2 verify against the hash persisted in Postgres.
    expect(
      await verifyAdminPassword(ctx.prisma, "owner", "correct-horse-battery-staple"),
    ).not.toBeNull();
    expect(await verifyAdminPassword(ctx.prisma, "owner", "wrong-password")).toBeNull();
  });

  it("stores and reads a passkey credential (Bytes + JSON transports round-trip)", async () => {
    const accountId = await seedOwner();

    const publicKey = new Uint8Array([4, 8, 15, 16, 23, 42]);
    await savePasskeyCredential(ctx.prisma, {
      accountId,
      credentialId: "cred-abc",
      webauthnUserId: "user-handle-1",
      publicKey,
      counter: 0,
      deviceType: "singleDevice",
      backedUp: false,
      transports: ["internal", "hybrid"],
    });

    expect(await getPasskeyCount(ctx.prisma, accountId)).toBe(1);

    const record = await findCredentialByCredentialId(ctx.prisma, "cred-abc");
    expect(record?.account.username).toBe("owner");

    const decoded = toWebAuthnCredential(record);
    expect(decoded?.publicKey).toEqual(publicKey); // Bytes column round-trips byte-for-byte
    expect(decoded?.transports).toEqual(["internal", "hybrid"]); // JSON column round-trips
  });

  it("bumps the signature counter and stamps last-used on credential usage", async () => {
    const accountId = await seedOwner();
    await savePasskeyCredential(ctx.prisma, {
      accountId,
      credentialId: "cred-1",
      webauthnUserId: "u1",
      publicKey: new Uint8Array([1]),
      counter: 0,
      deviceType: "multiDevice",
      backedUp: true,
      transports: [],
    });

    await updateCredentialUsage(ctx.prisma, "cred-1", {
      counter: 7,
      deviceType: "multiDevice",
      backedUp: true,
      lastUsedAt: new Date(0),
    });

    const record = await findCredentialByCredentialId(ctx.prisma, "cred-1");
    expect(record?.counter).toBe(7);
    expect(record?.lastUsedAt).not.toBeNull();
  });

  it("cascade-deletes credentials when the account is removed (FK ON DELETE CASCADE)", async () => {
    const accountId = await seedOwner();
    await savePasskeyCredential(ctx.prisma, {
      accountId,
      credentialId: "cred-x",
      webauthnUserId: "ux",
      publicKey: new Uint8Array([9]),
      counter: 0,
      deviceType: "singleDevice",
      backedUp: false,
      transports: [],
    });
    expect(await getPasskeyCount(ctx.prisma, accountId)).toBe(1);

    await ctx.prisma.webAdminAccount.delete({ where: { id: accountId } });

    expect(await getPasskeyCount(ctx.prisma, accountId)).toBe(0);
    expect(await findCredentialByCredentialId(ctx.prisma, "cred-x")).toBeNull();
  });
});
