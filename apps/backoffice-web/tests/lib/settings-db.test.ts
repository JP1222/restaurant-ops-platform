import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// Fake Prisma surface. `$transaction(ops[])` resolves the array of "ops" — in
// the real client each element is a prepared promise; here the upsert/create
// mocks already return resolved promises, so we just await them in order.
const appSetting = {
  findUnique: vi.fn(),
  upsert: vi.fn(),
  update: vi.fn(),
};
const appSettingAudit = {
  create: vi.fn(),
};
const prisma = {
  appSetting,
  appSettingAudit,
  $transaction: vi.fn((ops: Array<Promise<unknown>>) => Promise.all(ops)),
};

vi.mock("@rop/db-kds", () => ({
  createPrismaClient: () => prisma,
}));

// Identity-ish crypto so we can assert encode/no-op behavior deterministically.
// Real `encryptSecret` re-randomizes ciphertext each call; emulate that so the
// no-op detection path (which must decrypt both sides) is exercised honestly.
let encryptCounter = 0;
vi.mock("@/lib/settings/crypto", () => ({
  encryptSecret: (plaintext: string) => {
    encryptCounter += 1;
    return JSON.stringify({ enc: "v1", ct: plaintext, nonce: encryptCounter });
  },
  decryptSecret: (stored: string) => {
    const parsed = JSON.parse(stored) as { ct: string };
    return parsed.ct;
  },
  SettingDecryptError: class SettingDecryptError extends Error {},
}));

const logSettingChangeEventMock = vi.fn();
vi.mock("@/lib/ai/log", () => ({
  logSettingChangeEvent: (...a: unknown[]) => logSettingChangeEventMock(...a),
  logErrorEvent: () => {},
  errorMessage: (cause: unknown, fallback: string) =>
    cause instanceof Error ? cause.message : fallback,
}));

function existingRow(over: Partial<Record<string, unknown>> = {}) {
  return {
    merchantId: "default-merchant",
    key: "ai.rate_limit_per_minute",
    value: JSON.stringify(10),
    category: "ai",
    version: 3,
    updatedAt: new Date(),
    updatedBy: "old-user",
    createdAt: new Date(),
    ...over,
  };
}

beforeEach(() => {
  vi.resetModules();
  encryptCounter = 0;
  appSetting.findUnique.mockReset();
  appSetting.upsert.mockReset();
  appSetting.update.mockReset();
  appSettingAudit.create.mockReset();
  prisma.$transaction.mockClear();
  logSettingChangeEventMock.mockReset();

  // Default: writes succeed and echo back a row with the bumped version.
  appSetting.upsert.mockImplementation(({ create, update }: { create?: { version?: number }; update?: { version?: number } }) =>
    Promise.resolve(existingRow({ version: (update ?? create)?.version ?? 1 })),
  );
  appSetting.update.mockImplementation(() => Promise.resolve(existingRow()));
  appSettingAudit.create.mockResolvedValue({ id: "audit-1" });
});

afterEach(() => {
  vi.restoreAllMocks();
  // Reset the module-level cached Prisma client so each suite re-mocks cleanly.
  delete (globalThis as Record<string, unknown>).__ropBackofficeKds;
});

async function importUpsert() {
  const mod = await import("@/lib/settings/db");
  return mod;
}

describe("findSetting secret read (double-encode regression)", () => {
  test("decodes the envelope once, so reveal/provider JSON.parse to the raw key", async () => {
    // The envelope's ct holds the JSON-encoded value — write stores
    // encrypt(JSON.stringify(key)). On read the value must come back single-encoded
    // (same shape as a non-secret row), NOT double-encoded.
    appSetting.findUnique.mockResolvedValue(
      existingRow({
        key: "ai.deepseek_api_key",
        category: "secret",
        value: JSON.stringify({ enc: "v1", ct: JSON.stringify("sk-test-7f03"), nonce: 0 }),
      }),
    );
    const { findSetting } = await importUpsert();
    const row = await findSetting("ai.deepseek_api_key");

    // Single JSON-encoded form; the reveal endpoint + deepseek-provider each
    // JSON.parse this exactly once and must land on the bare key (no quotes).
    expect(row?.value).toBe(JSON.stringify("sk-test-7f03"));
    expect(JSON.parse(row?.value as string)).toBe("sk-test-7f03");
  });
});

describe("upsertSetting version + audit (issues #177, #159)", () => {
  test("a changed value bumps version by 1 and writes one audit row in a transaction", async () => {
    appSetting.findUnique.mockResolvedValue(existingRow({ version: 3, value: JSON.stringify(10) }));
    const { upsertSetting } = await importUpsert();

    await upsertSetting({
      key: "ai.rate_limit_per_minute",
      value: JSON.stringify(25),
      category: "ai",
      updatedBy: "acct-1",
      updatedByUsername: "owner",
    });

    // Wrapped in a single $transaction with exactly [upsert, audit.create].
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(appSetting.upsert).toHaveBeenCalledTimes(1);
    expect(appSettingAudit.create).toHaveBeenCalledTimes(1);

    const upsertArg = appSetting.upsert.mock.calls[0]?.[0] as {
      update: { version: number; value: string };
    };
    expect(upsertArg.update.version).toBe(4); // 3 -> 4
    expect(upsertArg.update.value).toBe(JSON.stringify(25));

    const auditArg = appSettingAudit.create.mock.calls[0]?.[0] as {
      data: { oldValue: string | null; newValue: string | null; changedByUsername: string | null };
    };
    expect(auditArg.data.oldValue).toBe(JSON.stringify(10));
    expect(auditArg.data.newValue).toBe(JSON.stringify(25));
    expect(auditArg.data.changedByUsername).toBe("owner");

    // Structured log mirrors the change (issue #159).
    expect(logSettingChangeEventMock).toHaveBeenCalledTimes(1);
    const logArg = logSettingChangeEventMock.mock.calls[0]?.[0] as {
      fromVersion: number;
      toVersion: number;
      valueRedacted: boolean;
    };
    expect(logArg.fromVersion).toBe(3);
    expect(logArg.toVersion).toBe(4);
    expect(logArg.valueRedacted).toBe(false);
  });

  test("a no-op write (same value) skips version bump and audit row", async () => {
    appSetting.findUnique.mockResolvedValue(existingRow({ version: 3, value: JSON.stringify(10) }));
    const { upsertSetting } = await importUpsert();

    await upsertSetting({
      key: "ai.rate_limit_per_minute",
      value: JSON.stringify(10), // identical
      category: "ai",
      updatedBy: "acct-1",
    });

    // No transactional change; only the lightweight updatedBy refresh.
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(appSettingAudit.create).not.toHaveBeenCalled();
    expect(logSettingChangeEventMock).not.toHaveBeenCalled();
    expect(appSetting.update).toHaveBeenCalledTimes(1);
    const updateArg = appSetting.update.mock.calls[0]?.[0] as { data: Record<string, unknown> };
    // The lightweight refresh must NOT touch version.
    expect("version" in updateArg.data).toBe(false);
  });

  test("creating a brand-new key starts at version 1 with oldValue null", async () => {
    appSetting.findUnique.mockResolvedValue(null);
    const { upsertSetting } = await importUpsert();

    await upsertSetting({
      key: "ai.rate_limit_per_minute",
      value: JSON.stringify(15),
      category: "ai",
      updatedBy: "acct-1",
    });

    const upsertArg = appSetting.upsert.mock.calls[0]?.[0] as { create: { version: number } };
    expect(upsertArg.create.version).toBe(1); // 0 -> 1
    const auditArg = appSettingAudit.create.mock.calls[0]?.[0] as {
      data: { oldValue: string | null };
    };
    expect(auditArg.data.oldValue).toBeNull();
  });

  test("ifVersion mismatch throws SettingVersionConflictError without writing", async () => {
    appSetting.findUnique.mockResolvedValue(existingRow({ version: 5, value: JSON.stringify(50) }));
    const { upsertSetting, SettingVersionConflictError } = await importUpsert();

    await expect(
      upsertSetting({
        key: "ai.rate_limit_per_minute",
        value: JSON.stringify(25),
        category: "ai",
        updatedBy: "acct-1",
        ifVersion: 4, // stale
      }),
    ).rejects.toBeInstanceOf(SettingVersionConflictError);

    expect(appSetting.upsert).not.toHaveBeenCalled();
    expect(appSettingAudit.create).not.toHaveBeenCalled();
  });

  test("ifVersion match proceeds with the write", async () => {
    appSetting.findUnique.mockResolvedValue(existingRow({ version: 5, value: JSON.stringify(50) }));
    const { upsertSetting } = await importUpsert();

    await upsertSetting({
      key: "ai.rate_limit_per_minute",
      value: JSON.stringify(25),
      category: "ai",
      updatedBy: "acct-1",
      ifVersion: 5, // current
    });

    expect(appSetting.upsert).toHaveBeenCalledTimes(1);
    const upsertArg = appSetting.upsert.mock.calls[0]?.[0] as { update: { version: number } };
    expect(upsertArg.update.version).toBe(6);
  });

  test("conflict carries the decrypted current value for non-secret keys", async () => {
    appSetting.findUnique.mockResolvedValue(existingRow({ version: 7, value: JSON.stringify(99) }));
    const { upsertSetting, SettingVersionConflictError } = await importUpsert();

    try {
      await upsertSetting({
        key: "ai.rate_limit_per_minute",
        value: JSON.stringify(25),
        category: "ai",
        updatedBy: "acct-1",
        ifVersion: 1,
      });
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(SettingVersionConflictError);
      const conflict = error as InstanceType<typeof SettingVersionConflictError>;
      expect(conflict.currentVersion).toBe(7);
      expect(conflict.currentValue).toBe(JSON.stringify(99));
    }
  });
});

describe("upsertSetting secret handling (issues #159, #205)", () => {
  test("a secret change stores ciphertext, redacts the audit + log, and bumps version", async () => {
    // Existing encrypted row holding "old-secret".
    appSetting.findUnique.mockResolvedValue(
      existingRow({
        key: "ai.deepseek_api_key",
        category: "secret",
        version: 2,
        value: JSON.stringify({ enc: "v1", ct: JSON.stringify("old-secret"), nonce: 0 }),
      }),
    );
    const { upsertSetting } = await importUpsert();

    await upsertSetting({
      key: "ai.deepseek_api_key",
      value: JSON.stringify("new-secret"),
      category: "secret",
      updatedBy: "acct-1",
      updatedByUsername: "owner",
    });

    // Stored value is the encrypted envelope, not the plaintext.
    const upsertArg = appSetting.upsert.mock.calls[0]?.[0] as { update: { value: string; version: number } };
    expect(upsertArg.update.value).toContain('"enc":"v1"');
    expect(upsertArg.update.version).toBe(3);

    // Audit row must NOT contain plaintext key material.
    const auditArg = appSettingAudit.create.mock.calls[0]?.[0] as {
      data: { oldValue: string | null; newValue: string | null };
    };
    expect(auditArg.data.oldValue).toBe("[redacted-secret]");
    expect(auditArg.data.newValue).toBe("[redacted-secret]");
    expect(JSON.stringify(auditArg.data)).not.toContain("new-secret");
    expect(JSON.stringify(auditArg.data)).not.toContain("old-secret");

    // Structured log redacts too.
    const logArg = logSettingChangeEventMock.mock.calls[0]?.[0] as {
      valueRedacted: boolean;
      oldValue: string | null;
      newValue: string | null;
    };
    expect(logArg.valueRedacted).toBe(true);
    expect(logArg.oldValue).toBeNull();
    expect(logArg.newValue).toBeNull();
  });

  test("re-saving the SAME secret value is detected as a no-op despite re-randomized ciphertext", async () => {
    appSetting.findUnique.mockResolvedValue(
      existingRow({
        key: "ai.deepseek_api_key",
        category: "secret",
        version: 2,
        value: JSON.stringify({ enc: "v1", ct: JSON.stringify("same-secret"), nonce: 0 }),
      }),
    );
    const { upsertSetting } = await importUpsert();

    await upsertSetting({
      key: "ai.deepseek_api_key",
      value: JSON.stringify("same-secret"),
      category: "secret",
      updatedBy: "acct-1",
    });

    // Decrypt-both-sides comparison catches the no-op; no audit, no version bump.
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(appSettingAudit.create).not.toHaveBeenCalled();
    expect(appSetting.update).toHaveBeenCalledTimes(1);
  });
});
