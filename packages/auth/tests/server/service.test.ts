import { describe, expect, it, vi } from "vitest";
import { hashPassword } from "../../src/server/password.js";
import { createWebAuthService } from "../../src/server/service.js";
import type { AuthRedis } from "../../src/server/redis.js";
import type { AuthServiceConfig } from "../../src/server/config.js";
import type { PrismaClient } from "@rop/db-auth";

class FakeRedis implements AuthRedis {
  readonly values = new Map<string, string>();
  readonly ttls = new Map<string, number>();

  async get(key: string) {
    return this.values.get(key) ?? null;
  }

  async set(key: string, value: string, mode: "EX", seconds: number) {
    expect(mode).toBe("EX");
    this.values.set(key, value);
    this.ttls.set(key, seconds);
    return "OK";
  }

  async del(key: string) {
    const deleted = this.values.delete(key);
    this.ttls.delete(key);
    return deleted ? 1 : 0;
  }

  async ttl(key: string) {
    return this.ttls.get(key) ?? -2;
  }

  async incr(key: string) {
    const next = Number(this.values.get(key) ?? 0) + 1;
    this.values.set(key, String(next));
    return next;
  }

  async expire(key: string, seconds: number) {
    this.ttls.set(key, seconds);
    return 1;
  }
}

const config: AuthServiceConfig = {
  appBaseUrl: "https://kds.example.test",
  webauthnRpName: "Example Kitchen KDS",
  webSessionTtlHours: 12,
  webLoginDisplayName: "Kitchen Admin"
};

function createPrismaStub(accountPasswordHash?: string) {
  const account = accountPasswordHash
    ? {
        id: "acct_1",
        username: "admin",
        displayName: "Kitchen Admin",
        role: "ADMIN",
        passwordHash: accountPasswordHash
      }
    : null;

  return {
    webAdminAccount: {
      findUnique: vi.fn(async () => account),
      upsert: vi.fn()
    },
    webAuthnCredential: {
      count: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      deleteMany: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn()
    },
    // Phase 2 (ADR-0818): session mint resolves the account's tenant from here.
    tenantMembership: {
      findFirst: vi.fn(async () => ({
        id: "mem_1",
        accountId: "acct_1",
        tenantId: "tenant-default",
        role: "ADMIN"
      }))
    }
  } as unknown as PrismaClient;
}

describe("createWebAuthService", () => {
  it("creates, refreshes, and destroys sessions with the existing Redis key format", async () => {
    const redis = new FakeRedis();
    const service = createWebAuthService(createPrismaStub(), redis, config);

    const { sessionId, session } = await service.createSession({
      id: "acct_1",
      username: "admin",
      displayName: "Kitchen Admin",
      role: "ADMIN"
    });

    expect(sessionId).toHaveLength(43);
    expect(session).toMatchObject({
      accountId: "acct_1",
      username: "admin",
      displayName: "Kitchen Admin",
      role: "ADMIN",
      // Phase 2: the session now carries the account's resolved tenant.
      tenantId: "tenant-default"
    });
    expect(redis.values.has(`auth:session:${sessionId}`)).toBe(true);
    expect(redis.ttls.get(`auth:session:${sessionId}`)).toBe(12 * 60 * 60);

    await expect(service.readSession(sessionId)).resolves.toMatchObject({
      accountId: "acct_1",
      username: "admin",
      tenantId: "tenant-default"
    });

    await service.destroySession(sessionId);
    await expect(service.readSession(sessionId)).resolves.toBeNull();
  });

  it("dual-reads a pre-Phase-2 session record (no tenantId) by healing it to the default tenant", async () => {
    const redis = new FakeRedis();
    const service = createWebAuthService(createPrismaStub(), redis, config);

    // A session minted before Phase 2 has no `tenantId` field on the record.
    const legacyId = "legacy-session-id";
    const now = new Date().toISOString();
    redis.values.set(
      `auth:session:${legacyId}`,
      JSON.stringify({
        accountId: "acct_1",
        username: "admin",
        displayName: "Kitchen Admin",
        role: "ADMIN",
        issuedAt: now,
        lastSeenAt: now
      })
    );

    const view = await service.readSession(legacyId);
    // Read heals the missing claim to the single implicit tenant (no logout).
    expect(view?.tenantId).toBe("tenant-default");
    // …and persists the healed record back to Redis.
    const healed = JSON.parse(redis.values.get(`auth:session:${legacyId}`) ?? "{}");
    expect(healed.tenantId).toBe("tenant-default");
  });

  it("preserves password rate-limit counters and lockout threshold", async () => {
    const redis = new FakeRedis();
    const service = createWebAuthService(createPrismaStub(), redis, config);

    await expect(service.getPasswordRateLimit("127.0.0.1", "Admin")).resolves.toEqual({
      attempts: 0,
      blocked: false,
      retryAfterSeconds: 0
    });

    for (let attempt = 1; attempt <= 4; attempt += 1) {
      await expect(service.registerFailedPasswordAttempt("127.0.0.1", "Admin")).resolves.toMatchObject({
        attempts: attempt,
        blocked: false
      });
    }

    await expect(service.registerFailedPasswordAttempt("127.0.0.1", "Admin")).resolves.toMatchObject({
      attempts: 5,
      retryAfterSeconds: 15 * 60,
      blocked: true
    });

    await service.clearPasswordAttempts("127.0.0.1", "Admin");
    await expect(service.getPasswordRateLimit("127.0.0.1", "Admin")).resolves.toEqual({
      attempts: 0,
      blocked: false,
      retryAfterSeconds: 0
    });
  });

  it("blocks one IP iterating distinct usernames once the per-IP cap is hit", async () => {
    const redis = new FakeRedis();
    const service = createWebAuthService(createPrismaStub(), redis, config);

    for (let attempt = 1; attempt <= 30; attempt += 1) {
      const failure = await service.registerFailedPasswordAttempt("10.0.0.1", `user-${attempt}`);
      expect(failure.attempts).toBe(1);
      expect(failure.blocked).toBe(attempt >= 30);
    }

    const limit = await service.getPasswordRateLimit("10.0.0.1", "user-31");
    expect(limit.blocked).toBe(true);
    expect(limit.retryAfterSeconds).toBe(60 * 60);
  });

  it("blocks rotating IPs hammering one account once the per-account cap is hit", async () => {
    const redis = new FakeRedis();
    const service = createWebAuthService(createPrismaStub(), redis, config);

    for (let attempt = 1; attempt <= 10; attempt += 1) {
      const failure = await service.registerFailedPasswordAttempt(`10.0.0.${attempt}`, "Admin");
      expect(failure.attempts).toBe(1);
      expect(failure.blocked).toBe(attempt >= 10);
    }

    const limit = await service.getPasswordRateLimit("10.0.0.99", "Admin");
    expect(limit.blocked).toBe(true);
    expect(limit.retryAfterSeconds).toBe(60 * 60);
  });

  it("returns the longest applicable retry when multiple caps are exceeded", async () => {
    const redis = new FakeRedis();
    const service = createWebAuthService(createPrismaStub(), redis, config);

    for (let attempt = 1; attempt <= 10; attempt += 1) {
      await service.registerFailedPasswordAttempt("10.0.0.1", "Admin");
    }

    const limit = await service.getPasswordRateLimit("10.0.0.1", "Admin");
    expect(limit.blocked).toBe(true);
    // ip+username cap (15min) and per-account cap (60min) both tripped; the longer wins.
    expect(limit.retryAfterSeconds).toBe(60 * 60);
  });

  it("increments the per-IP passkey counter, sets its TTL, and blocks at the cap", async () => {
    const redis = new FakeRedis();
    const service = createWebAuthService(createPrismaStub(), redis, config);

    await expect(service.getPasskeyRateLimit("203.0.113.7")).resolves.toEqual({
      attempts: 0,
      blocked: false,
      retryAfterSeconds: 0
    });

    for (let attempt = 1; attempt <= 4; attempt += 1) {
      await expect(service.registerFailedPasskeyAttempt("203.0.113.7")).resolves.toMatchObject({
        attempts: attempt,
        blocked: false
      });
    }

    expect(redis.ttls.get("auth:passkey-rate-ip:203.0.113.7")).toBe(15 * 60);

    await expect(service.registerFailedPasskeyAttempt("203.0.113.7")).resolves.toMatchObject({
      attempts: 5,
      blocked: true,
      retryAfterSeconds: 15 * 60
    });

    await expect(service.getPasskeyRateLimit("203.0.113.7")).resolves.toEqual({
      attempts: 5,
      blocked: true,
      retryAfterSeconds: 15 * 60
    });

    await service.clearPasskeyAttempts("203.0.113.7");
    await expect(service.getPasskeyRateLimit("203.0.113.7")).resolves.toEqual({
      attempts: 0,
      blocked: false,
      retryAfterSeconds: 0
    });
  });

  it(
    "verifies admin passwords through the migrated user lookup flow",
    async () => {
      const passwordHash = await hashPassword("swordfish");
      const service = createWebAuthService(createPrismaStub(passwordHash), new FakeRedis(), config);

      await expect(service.verifyPassword("admin", "swordfish")).resolves.toMatchObject({
        id: "acct_1",
        username: "admin"
      });
      await expect(service.verifyPassword("admin", "wrong")).resolves.toBeNull();
    },
    // Three full argon2id computations (64 MiB × 3 passes each) — can exceed
    // the 5s default on a loaded CI runner, same flake class as password.test.ts.
    20_000
  );

  it("maps stored passkeys into SimpleWebAuthn credential descriptors", () => {
    const service = createWebAuthService(createPrismaStub(), new FakeRedis(), config);
    const credential = service.toWebAuthnCredential({
      id: "row_1",
      accountId: "acct_1",
      credentialId: "cred_1",
      webauthnUserId: "acct_1",
      publicKey: Buffer.from([1, 2, 3]),
      counter: 7,
      deviceType: "singleDevice",
      backedUp: false,
      transports: ["internal"],
      lastUsedAt: null,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z")
    });

    expect(credential).toEqual({
      id: "cred_1",
      publicKey: new Uint8Array([1, 2, 3]),
      counter: 7,
      transports: ["internal"]
    });
  });
});
