import { describe, expect, it, vi } from "vitest";
import { Prisma, type PrismaClient } from "@rop/db-auth";
import {
  countUsableLoginMethods,
  deletePasskeyGuarded,
  withSerializationRetry,
  wouldLeaveNoLoginMethod,
} from "../../src/server/lockout.js";

function createPrismaStub(opts: { passwordSetAt: Date | null; passkeyCount: number } | null) {
  const account =
    opts === null
      ? null
      : {
          id: "acct_1",
          username: "admin",
          displayName: "Admin",
          role: "OWNER",
          passwordHash: "hash",
          passwordSetAt: opts.passwordSetAt,
        };

  return {
    webAdminAccount: {
      findUnique: vi.fn(async () => account),
    },
    webAuthnCredential: {
      count: vi.fn(async () => (opts === null ? 0 : opts.passkeyCount)),
    },
  } as unknown as PrismaClient;
}

describe("wouldLeaveNoLoginMethod", () => {
  it("blocks deleting the last passkey when there is no usable password", () => {
    expect(wouldLeaveNoLoginMethod({ passwordSet: false, passkeyCount: 1 }, "passkey")).toBe(true);
  });

  it("allows deleting a passkey when a usable password exists", () => {
    expect(wouldLeaveNoLoginMethod({ passwordSet: true, passkeyCount: 1 }, "passkey")).toBe(false);
  });

  it("allows deleting a passkey when more than one passkey remains", () => {
    expect(wouldLeaveNoLoginMethod({ passwordSet: false, passkeyCount: 2 }, "passkey")).toBe(false);
  });

  it("treats zero passkeys as already unsafe to remove from", () => {
    expect(wouldLeaveNoLoginMethod({ passwordSet: false, passkeyCount: 0 }, "passkey")).toBe(true);
  });
});

describe("countUsableLoginMethods", () => {
  it("counts a real password (passwordSetAt set) plus passkeys", async () => {
    const prisma = createPrismaStub({ passwordSetAt: new Date("2026-01-01T00:00:00.000Z"), passkeyCount: 2 });
    await expect(countUsableLoginMethods(prisma, "acct_1")).resolves.toEqual({
      passwordSet: true,
      passkeyCount: 2,
      total: 3,
    });
  });

  it("does NOT count a placeholder password (passwordSetAt null)", async () => {
    const prisma = createPrismaStub({ passwordSetAt: null, passkeyCount: 1 });
    await expect(countUsableLoginMethods(prisma, "acct_1")).resolves.toEqual({
      passwordSet: false,
      passkeyCount: 1,
      total: 1,
    });
  });

  it("reports zero usable methods for a placeholder account with no passkeys", async () => {
    const prisma = createPrismaStub({ passwordSetAt: null, passkeyCount: 0 });
    await expect(countUsableLoginMethods(prisma, "acct_1")).resolves.toEqual({
      passwordSet: false,
      passkeyCount: 0,
      total: 0,
    });
  });

  it("treats an unknown account as having no usable password", async () => {
    const prisma = createPrismaStub(null);
    await expect(countUsableLoginMethods(prisma, "missing")).resolves.toEqual({
      passwordSet: false,
      passkeyCount: 0,
      total: 0,
    });
  });
});

// Stub whose callback-form $transaction reuses the same model mocks as the tx
// client, so the guard's reads/writes inside the transaction hit these mocks.
function createGuardPrismaStub(opts: {
  credentialExists: boolean;
  passwordSetAt: Date | null;
  passkeyCount: number;
}) {
  const webAuthnCredential = {
    findFirst: vi.fn(async () => (opts.credentialExists ? { id: "row-1" } : null)),
    count: vi.fn(async () => opts.passkeyCount),
    deleteMany: vi.fn(async () => ({ count: 1 })),
  };
  const webAdminAccount = {
    findUnique: vi.fn(async () => ({ passwordSetAt: opts.passwordSetAt })),
  };
  const transaction = vi.fn(async (input: unknown) => {
    if (typeof input === "function") {
      return (input as (tx: unknown) => Promise<unknown>)({ webAuthnCredential, webAdminAccount });
    }
    return undefined;
  });
  const prisma = {
    webAuthnCredential,
    webAdminAccount,
    $transaction: transaction,
  } as unknown as PrismaClient;
  return { prisma, webAuthnCredential, webAdminAccount, transaction };
}

describe("deletePasskeyGuarded", () => {
  it("returns not_found (and never deletes) when the credential is not the account's", async () => {
    const { prisma, webAuthnCredential } = createGuardPrismaStub({
      credentialExists: false,
      passwordSetAt: null,
      passkeyCount: 0,
    });
    await expect(deletePasskeyGuarded(prisma, "acct_1", "missing")).resolves.toEqual({
      ok: false,
      reason: "not_found",
    });
    expect(webAuthnCredential.deleteMany).not.toHaveBeenCalled();
  });

  it("returns last_login_method (and never deletes) when removal would brick a password-less single-passkey account", async () => {
    const { prisma, webAuthnCredential } = createGuardPrismaStub({
      credentialExists: true,
      passwordSetAt: null,
      passkeyCount: 1,
    });
    await expect(deletePasskeyGuarded(prisma, "acct_1", "cred_1")).resolves.toEqual({
      ok: false,
      reason: "last_login_method",
    });
    expect(webAuthnCredential.deleteMany).not.toHaveBeenCalled();
  });

  it("deletes when a usable password remains", async () => {
    const { prisma, webAuthnCredential } = createGuardPrismaStub({
      credentialExists: true,
      passwordSetAt: new Date("2026-01-01T00:00:00.000Z"),
      passkeyCount: 1,
    });
    await expect(deletePasskeyGuarded(prisma, "acct_1", "cred_1")).resolves.toEqual({ ok: true });
    expect(webAuthnCredential.deleteMany).toHaveBeenCalledWith({
      where: { accountId: "acct_1", credentialId: "cred_1" },
    });
  });

  it("deletes a passkey for a password-less account that keeps another passkey", async () => {
    const { prisma, webAuthnCredential } = createGuardPrismaStub({
      credentialExists: true,
      passwordSetAt: null,
      passkeyCount: 2,
    });
    await expect(deletePasskeyGuarded(prisma, "acct_1", "cred_1")).resolves.toEqual({ ok: true });
    expect(webAuthnCredential.deleteMany).toHaveBeenCalled();
  });

  it("runs inside a Serializable transaction (a silent downgrade reds this test)", async () => {
    const { prisma, transaction } = createGuardPrismaStub({
      credentialExists: true,
      passwordSetAt: new Date("2026-01-01T00:00:00.000Z"),
      passkeyCount: 2,
    });
    await deletePasskeyGuarded(prisma, "acct_1", "cred_1");
    expect(transaction).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({ isolationLevel: "Serializable" }),
    );
  });
});

describe("withSerializationRetry", () => {
  function serializationFailure() {
    return new Prisma.PrismaClientKnownRequestError("write conflict", {
      code: "P2034",
      clientVersion: "test",
    });
  }

  it("retries a P2034 serialization failure and returns the eventual success", async () => {
    const run = vi.fn().mockRejectedValueOnce(serializationFailure()).mockResolvedValueOnce("ok");
    await expect(withSerializationRetry(run)).resolves.toBe("ok");
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("rethrows a non-serialization error immediately without retrying", async () => {
    const run = vi.fn().mockRejectedValue(new Error("boom"));
    await expect(withSerializationRetry(run)).rejects.toThrow("boom");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("gives up after the bounded attempts and rethrows the last serialization failure", async () => {
    const run = vi.fn().mockRejectedValue(serializationFailure());
    await expect(withSerializationRetry(run, 3)).rejects.toBeInstanceOf(
      Prisma.PrismaClientKnownRequestError,
    );
    expect(run).toHaveBeenCalledTimes(3);
  });
});
