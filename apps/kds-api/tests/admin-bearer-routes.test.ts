import cookie from "@fastify/cookie";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/config.js";
import { registerAdminRoutes } from "../src/routes/admin.js";

const BEARER_TOKEN = "phase4-internal-bearer-token-1234567890";

function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    nodeEnv: "test",
    apiPort: 4000,
    appBaseUrl: "https://kds.example.com",
    backofficeBaseUrl: "https://backoffice.example.com",
    sessionSecret: "test-secret",
    databaseUrl: "postgres://example",
    redisUrl: "redis://example",
    webLoginUsername: "admin",
    webLoginPasswordHash: "hash",
    webLoginDisplayName: "Kitchen Admin",
    webauthnRpId: "kds.example.com",
    webauthnRpName: "Example Kitchen KDS",
    webSessionTtlHours: 12,
    kdsInternalAdminToken: BEARER_TOKEN,
    cloverBaseUrl: "https://apisandbox.dev.clover.com",
    cloverRegion: "US",
    cloverMerchantId: "merchant-1",
    cloverToken: "static-token",
    cloverAppId: "app-id",
    cloverAppSecret: "app-secret",
    cloverWebhookAuthCode: "webhook-secret",
    deliverectWebhookSecret: undefined,
    deliverectWebhookSignatureHeader: "x-server-authorization-hmac-sha256",
    deliverectApiUrl: "https://api.deliverect.com",
    deliverectStagingApiUrl: "https://staging.deliverect.com",
    reconcileIntervalMs: 45_000,
    workerIntervalMs: 1_000,
    kdsWorkerConcurrency: 8,
    kdsFulfillmentWorkerConcurrency: 4,
    kdsCloverBucketRealtime: "10:10",
    kdsCloverBucketRecon: "6:6",
    kdsCloverBucketGlobal: "12:12",
    kdsRealtimeBackfillLimit: 250,
    dailyResetEnabled: false,
    dailyResetHour: 21,
    dailyResetMinute: 0,
    dailyResetTimezone: "UTC",
    dailyResetCheckIntervalMs: 30_000,
    ...overrides
  };
}

function createServices(configOverrides: Partial<AppConfig> = {}) {
  const kdsDeviceToken = {
    findMany: vi.fn(async () => [
      {
        id: "device-1",
        merchantId: "merchant-1",
        label: "Kitchen Pad 1",
        role: "KDS",
        createdAt: new Date("2026-05-01T12:00:00.000Z"),
        lastUsedAt: new Date("2026-05-15T20:00:00.000Z"),
        revokedAt: null
      }
    ]),
    create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
      id: "device-new",
      merchantId: data.merchantId,
      label: data.label,
      role: data.role ?? "KDS",
      createdAt: new Date("2026-05-16T12:00:00.000Z")
    })),
    update: vi.fn(async () => ({ id: "device-1" }))
  };

  const providerAppState = {
    findUnique: vi.fn(async () => ({
      provider: "CLOVER",
      environment: "STAGING",
      tokenModeMerchantId: "merchant-1"
    })),
    upsert: vi.fn(async () => undefined)
  };

  const cloverMerchant = {
    findUnique: vi.fn(async ({ where }: { where: { id?: string } }) => {
      if (where.id === "merchant-1") {
        return {
          id: "merchant-1",
          authStatus: "ACTIVE",
          refreshTokenExpiresAt: null,
          appInstalledAt: null,
          lastWebhookAt: new Date("2026-05-15T20:00:00.000Z"),
          lastSyncAt: new Date("2026-05-15T20:01:00.000Z"),
          lastReconciledAt: new Date("2026-05-15T20:02:00.000Z"),
          updatedAt: new Date("2026-05-15T20:02:00.000Z"),
          webhookStatus: "healthy",
          region: "US"
        };
      }
      return null;
    }),
    findFirst: vi.fn(async () => ({ id: "merchant-1" })),
    upsert: vi.fn(async () => undefined),
    update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => ({
      id: where.id,
      ...data
    })),
    updateMany: vi.fn(async () => ({ count: 0 }))
  };

  const kdsFilter = {
    findUnique: vi.fn(async () => null),
    upsert: vi.fn(async ({ where, create, update }: { where: Record<string, unknown>; create: Record<string, unknown>; update: Record<string, unknown> }) => ({
      merchantId: where.merchantId,
      ...create,
      ...update
    }))
  };

  const kdsProviderConfig = {
    findUnique: vi.fn(async () => null),
    upsert: vi.fn(async ({ create, update }: { create: Record<string, unknown>; update: Record<string, unknown> }) => ({
      ...create,
      ...update
    }))
  };

  const webAdminAccount = {
    findMany: vi.fn(async () => [
      {
        id: "user-1",
        username: "alice",
        displayName: "Alice",
        role: "ADMIN" as const,
        createdAt: new Date("2026-04-01T08:00:00.000Z"),
        updatedAt: new Date("2026-05-01T08:00:00.000Z"),
        _count: { credentials: 2 }
      },
      {
        id: "user-2",
        username: "bob",
        displayName: "Bob",
        role: "ADMIN" as const,
        createdAt: new Date("2026-04-02T08:00:00.000Z"),
        updatedAt: new Date("2026-05-02T08:00:00.000Z"),
        _count: { credentials: 0 }
      }
    ]),
    findUnique: vi.fn(async ({ where }: { where: { id?: string; username?: string } }) => {
      if (where.id === "user-1" || where.username === "alice") {
        return {
          id: "user-1",
          username: "alice",
          displayName: "Alice",
          role: "ADMIN" as const,
          // Real (usable) password by default; lockout tests override per-case.
          passwordSetAt: new Date("2026-04-05T08:00:00.000Z") as Date | null,
          createdAt: new Date("2026-04-01T08:00:00.000Z"),
          updatedAt: new Date("2026-05-01T08:00:00.000Z")
        };
      }
      return null;
    }),
    create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
      id: "user-new",
      username: data.username,
      displayName: data.displayName,
      role: "ADMIN" as const,
      createdAt: new Date("2026-05-16T12:00:00.000Z"),
      updatedAt: new Date("2026-05-16T12:00:00.000Z"),
      _count: { credentials: 0 }
    })),
    update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => ({
      id: where.id,
      username: "alice",
      displayName: data.displayName ?? "Alice",
      role: "ADMIN" as const,
      createdAt: new Date("2026-04-01T08:00:00.000Z"),
      updatedAt: new Date("2026-05-16T12:00:00.000Z"),
      _count: { credentials: 0 }
    })),
    delete: vi.fn(async () => undefined),
    // `deleteAdminUser` calls count twice: total accounts (no `where`) and, only
    // when the target is an OWNER, the number of OTHER owners. The default
    // fixture has 2 total accounts (alice + bob, both ADMIN). Owner-specific
    // tests override the `where: { role: "OWNER" }` branch per-case.
    count: vi.fn(async (args?: { where?: { role?: string; id?: { not?: string } } }) => {
      if (args?.where?.role === "OWNER") {
        return 0;
      }
      return 2;
    })
  };

  const webAuthnCredential = {
    findMany: vi.fn(async () => [
      {
        credentialId: "cred-1",
        createdAt: new Date("2026-04-10T08:00:00.000Z"),
        lastUsedAt: new Date("2026-05-15T20:00:00.000Z"),
        deviceType: "singleDevice",
        backedUp: false,
        transports: null
      }
    ]),
    // `revokeAdminUserPasskey` confirms existence with findFirst before the
    // lockout guard so a bad credentialId stays a 404 (passkey_not_found).
    findFirst: vi.fn(async ({ where }: { where: { accountId?: string; credentialId?: string } }) =>
      where.credentialId === "cred-1" ? { id: "row-cred-1" } : null
    ),
    // `countUsableLoginMethods` reads this for the account's passkey count.
    // Default: 2 passkeys, so revoking one with a usable password is allowed.
    count: vi.fn(async () => 2),
    deleteMany: vi.fn(async ({ where }: { where: { credentialId?: string } }) => ({
      count: where.credentialId === "cred-1" ? 1 : 0
    }))
  };

  return {
    config: makeConfig(configOverrides),
    auth: {
      readSession: vi.fn(async () => null),
      getAccountById: vi.fn(async () => null),
      destroySession: vi.fn(async () => undefined),
      getSessionCookieOptions: vi.fn(() => ({ path: "/", httpOnly: true, sameSite: "lax" as const })),
      createPasswordSetupToken: vi.fn(async () => "setup-token-abc123def456"),
      setPasswordWithToken: vi.fn(async () => ({ ok: true as const }))
    },
    prisma: {
      kdsDeviceToken,
      providerAppState,
      cloverMerchant,
      kdsFilter,
      kdsProviderConfig,
      deadLetterJob: {
        count: vi.fn(async () => 0),
        groupBy: vi.fn(async () => []),
        findFirst: vi.fn(async () => null)
      },
      kdsRealtimeReceipt: { findMany: vi.fn(async () => []) },
      kdsTicket: { groupBy: vi.fn(async () => []), deleteMany: vi.fn(async () => ({ count: 0 })) },
      cloverOrder: { deleteMany: vi.fn(async () => ({ count: 0 })) },
      cloverWebhookEvent: { deleteMany: vi.fn(async () => ({ count: 0 })) },
      kdsProviderEvent: { deleteMany: vi.fn(async () => ({ count: 0 })) },
      kdsRealtimeEvent: { deleteMany: vi.fn(async () => ({ count: 0 })) },
      $queryRawUnsafe: vi.fn(async () => [{ ok: 1 }]),
      $transaction: vi.fn(async (input: unknown) => {
        if (typeof input === "function") {
          return (input as (tx: unknown) => Promise<unknown>)({
            cloverMerchant,
            providerAppState,
            kdsFilter,
            kdsProviderConfig,
            kdsTicket: { deleteMany: vi.fn(async () => ({ count: 0 })) },
            cloverOrder: { deleteMany: vi.fn(async () => ({ count: 0 })) },
            cloverWebhookEvent: { deleteMany: vi.fn(async () => ({ count: 0 })) },
            kdsProviderEvent: { deleteMany: vi.fn(async () => ({ count: 0 })) },
            kdsRealtimeEvent: { deleteMany: vi.fn(async () => ({ count: 0 })) },
            deadLetterJob: { deleteMany: vi.fn(async () => ({ count: 0 })) }
          });
        }
        // Array-form $transaction (used by deleteAdminUser).
        if (Array.isArray(input)) {
          return Promise.all(input);
        }
        return undefined;
      })
    },
    prismaAuth: {
      webAdminAccount,
      webAuthnCredential,
      // `deleteAdminUser` now runs inside a single serializable callback-form
      // transaction (closes the prior check-then-act TOCTOU). The tx client
      // reuses the same mocks so per-test overrides on `webAdminAccount.count` /
      // `findUnique` still take effect inside the transaction.
      $transaction: vi.fn(async (input: unknown) => {
        if (typeof input === "function") {
          return (input as (tx: unknown) => Promise<unknown>)({
            webAdminAccount,
            webAuthnCredential
          });
        }
        if (Array.isArray(input)) {
          return Promise.all(input);
        }
        return undefined;
      })
    },
    redisPublisher: {
      ping: vi.fn(async () => "PONG"),
      keys: vi.fn(async () => []),
      mget: vi.fn(async () => [])
    },
    queue: {
      depths: vi.fn(async () => ({ syncHi: 0, syncLo: 0, fulfillment: 0, scheduler: 0 })),
      oldestWaitMs: vi.fn(async () => ({ syncHi: null, syncLo: null, fulfillment: null, scheduler: null })),
      clearForMerchant: vi.fn(async () => undefined)
    },
    hub: {
      publishSnapshotRequired: vi.fn(async () => undefined)
    }
  } as never;
}

afterEach(() => {
  vi.restoreAllMocks();
});

async function withApp(services: ReturnType<typeof createServices>, fn: (app: Awaited<ReturnType<typeof Fastify>>) => Promise<void>) {
  const app = Fastify();
  await app.register(cookie);
  await registerAdminRoutes(app as never, services);
  try {
    await fn(app);
  } finally {
    await app.close();
  }
}

describe("admin bearer-gated /api/admin/kds/devices", () => {
  it("returns 401 when no bearer is presented", async () => {
    await withApp(createServices(), async (app) => {
      const response = await app.inject({ method: "GET", url: "/api/admin/kds/devices" });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ error: "missing_bearer" });
    });
  });

  it("returns 401 on wrong bearer token", async () => {
    await withApp(createServices(), async (app) => {
      const response = await app.inject({
        method: "GET",
        url: "/api/admin/kds/devices",
        headers: { authorization: "Bearer wrong-token" }
      });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ error: "invalid_bearer" });
    });
  });

  it("returns 503 when KDS_INTERNAL_ADMIN_TOKEN is not configured", async () => {
    await withApp(createServices({ kdsInternalAdminToken: undefined }), async (app) => {
      const response = await app.inject({
        method: "GET",
        url: "/api/admin/kds/devices",
        headers: { authorization: `Bearer ${BEARER_TOKEN}` }
      });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({ error: "internal_admin_disabled" });
    });
  });

  it("lists devices when bearer is correct, defaulting merchantId from provider state", async () => {
    const services = createServices();
    await withApp(services, async (app) => {
      const response = await app.inject({
        method: "GET",
        url: "/api/admin/kds/devices",
        headers: { authorization: `Bearer ${BEARER_TOKEN}` }
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.merchantId).toBe("merchant-1");
      expect(Array.isArray(body.devices)).toBe(true);
      expect(body.devices).toHaveLength(1);
      expect(body.devices[0].label).toBe("Kitchen Pad 1");
    });
  });

  it("creates a device and returns the one-time token in the response body", async () => {
    const services = createServices();
    await withApp(services, async (app) => {
      const response = await app.inject({
        method: "POST",
        url: "/api/admin/kds/devices",
        headers: {
          authorization: `Bearer ${BEARER_TOKEN}`,
          "content-type": "application/json"
        },
        payload: { merchantId: "merchant-1", label: "Kitchen Pad 2" }
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.id).toBe("device-new");
      expect(body.label).toBe("Kitchen Pad 2");
      expect(typeof body.token).toBe("string");
      expect(body.token.length).toBeGreaterThan(0);
    });
  });

  it("does not require Origin check on bearer-gated POST (replaces CSRF guard)", async () => {
    const services = createServices();
    await withApp(services, async (app) => {
      const response = await app.inject({
        method: "POST",
        url: "/api/admin/kds/devices",
        headers: {
          authorization: `Bearer ${BEARER_TOKEN}`,
          "content-type": "application/json",
          origin: "https://backoffice.example.com"
        },
        payload: { merchantId: "merchant-1", label: "Kitchen Pad 3" }
      });

      expect(response.statusCode).toBe(200);
    });
  });

  it("rejects malformed POST body", async () => {
    await withApp(createServices(), async (app) => {
      const response = await app.inject({
        method: "POST",
        url: "/api/admin/kds/devices",
        headers: {
          authorization: `Bearer ${BEARER_TOKEN}`,
          "content-type": "application/json"
        },
        payload: { merchantId: "" }
      });
      expect(response.statusCode).toBe(400);
    });
  });

  it("revokes a device on DELETE", async () => {
    const services = createServices();
    await withApp(services, async (app) => {
      const response = await app.inject({
        method: "DELETE",
        url: "/api/admin/kds/devices/device-1",
        headers: { authorization: `Bearer ${BEARER_TOKEN}` }
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ ok: true });
      expect(services.prisma.kdsDeviceToken.update).toHaveBeenCalledWith({
        where: { id: "device-1" },
        data: { revokedAt: expect.any(Date) }
      });
    });
  });
});

describe("admin bearer-gated /api/admin/kds/board-settings", () => {
  it("returns 401 without bearer", async () => {
    await withApp(createServices(), async (app) => {
      const response = await app.inject({ method: "GET", url: "/api/admin/kds/board-settings" });
      expect(response.statusCode).toBe(401);
    });
  });

  it("returns default-shaped settings when no filter/provider exists yet", async () => {
    const services = createServices();
    await withApp(services, async (app) => {
      const response = await app.inject({
        method: "GET",
        url: "/api/admin/kds/board-settings",
        headers: { authorization: `Bearer ${BEARER_TOKEN}` }
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.merchantId).toBe("merchant-1");
      expect(body.settings.filter).toBeDefined();
      expect(body.settings.boardTimeZone).toBe("UTC");
      expect(body.settings.urgencyWarningMinutes).toBe(10);
      expect(body.settings.urgencyCriticalMinutes).toBe(20);
      expect(body.settings.providers.deliverect.enabled).toBe(false);
    });
  });

  it("rejects an invalid PUT body", async () => {
    await withApp(createServices(), async (app) => {
      const response = await app.inject({
        method: "PUT",
        url: "/api/admin/kds/board-settings",
        headers: {
          authorization: `Bearer ${BEARER_TOKEN}`,
          "content-type": "application/json"
        },
        payload: { not: "a valid settings object" }
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error).toBe("invalid_board_settings");
    });
  });

  it("persists settings on a valid PUT and returns the saved shape", async () => {
    const services = createServices();
    const validBody = {
      filter: {
        allowedOrderTypes: [],
        blockedSources: [],
        paymentStates: [],
        createdAfterMinutes: null,
        searchText: "",
        includeCompleted: false,
        soundEnabled: true,
        screenPinEnabled: false
      },
      boardTimeZone: "America/Chicago",
      dailyResetEnabled: true,
      dailyResetTime: "23:00",
      urgencyWarningMinutes: 8,
      urgencyCriticalMinutes: 16,
      urgencyBlinkCritical: true,
      modifierDangerKeywords: ["allergy"],
      modifierAccentKeywords: ["extra"],
      display: {
        weather: {
          enabled: false,
          countryCode: "US",
          city: ""
        }
      },
      providers: {
        deliverect: {
          enabled: false,
          environment: "staging",
          externalLocationId: "",
          locationId: "",
          channelLinkId: "",
          apiToken: "",
          hmacSecret: "",
          registerWebhookStatus: null,
          ordersWebhookStatus: null,
          lastRegisterWebhookAt: null,
          lastOrderWebhookAt: null
        }
      }
    };

    await withApp(services, async (app) => {
      const response = await app.inject({
        method: "PUT",
        url: "/api/admin/kds/board-settings",
        headers: {
          authorization: `Bearer ${BEARER_TOKEN}`,
          "content-type": "application/json"
        },
        payload: validBody
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.merchantId).toBe("merchant-1");
      expect(body.settings.urgencyWarningMinutes).toBe(8);
      expect(body.settings.urgencyCriticalMinutes).toBe(16);
      expect(body.settings.boardTimeZone).toBe("America/Chicago");
      expect(body.settings.dailyResetTime).toBe("23:00");
      expect(services.prisma.kdsFilter.upsert).toHaveBeenCalled();
      expect(services.prisma.kdsProviderConfig.upsert).toHaveBeenCalled();
    });
  });
});

describe("admin bearer-gated /api/admin/kds/users", () => {
  it("lists users with passkey counts when bearer is valid", async () => {
    await withApp(createServices(), async (app) => {
      const response = await app.inject({
        method: "GET",
        url: "/api/admin/kds/users",
        headers: { authorization: `Bearer ${BEARER_TOKEN}` }
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.users).toHaveLength(2);
      expect(body.users[0]).toMatchObject({
        username: "alice",
        displayName: "Alice",
        passkeyCount: 2
      });
      expect(body.users[1]).toMatchObject({ username: "bob", passkeyCount: 0 });
    });
  });

  it("creates a user and returns a one-time setup link", async () => {
    const services = createServices();
    // Mock that the username is NOT taken
    services.prismaAuth.webAdminAccount.findUnique.mockResolvedValueOnce(null);

    await withApp(services, async (app) => {
      const response = await app.inject({
        method: "POST",
        url: "/api/admin/kds/users",
        headers: {
          authorization: `Bearer ${BEARER_TOKEN}`,
          "content-type": "application/json"
        },
        payload: { username: "carol", displayName: "Carol Operator" }
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.user.username).toBe("carol");
      expect(body.setupUrl).toContain("/set-password?token=");
      expect(body.expiresInSeconds).toBeGreaterThan(0);
      expect(body.oneTimePassword).toBeUndefined();
      expect(services.prismaAuth.webAdminAccount.create).toHaveBeenCalled();
    });
  });

  it("returns 409 username_taken when username already exists", async () => {
    const services = createServices();
    // Default findUnique returns user-1 / alice. Try creating "alice" again.
    await withApp(services, async (app) => {
      const response = await app.inject({
        method: "POST",
        url: "/api/admin/kds/users",
        headers: {
          authorization: `Bearer ${BEARER_TOKEN}`,
          "content-type": "application/json"
        },
        payload: { username: "alice", displayName: "Alice Duplicate" }
      });

      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({ error: "username_taken" });
    });
  });

  it("renames a user with PATCH", async () => {
    const services = createServices();
    await withApp(services, async (app) => {
      const response = await app.inject({
        method: "PATCH",
        url: "/api/admin/kds/users/user-1",
        headers: {
          authorization: `Bearer ${BEARER_TOKEN}`,
          "content-type": "application/json"
        },
        payload: { displayName: "Alice (renamed)" }
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().user.displayName).toBe("Alice (renamed)");
    });
  });

  it("returns 404 when PATCHing a non-existent user", async () => {
    const services = createServices();
    services.prismaAuth.webAdminAccount.findUnique.mockResolvedValueOnce(null);
    await withApp(services, async (app) => {
      const response = await app.inject({
        method: "PATCH",
        url: "/api/admin/kds/users/missing",
        headers: {
          authorization: `Bearer ${BEARER_TOKEN}`,
          "content-type": "application/json"
        },
        payload: { displayName: "Nobody" }
      });
      expect(response.statusCode).toBe(404);
    });
  });

  it("refuses to delete the last remaining admin", async () => {
    // deleteAdminUser now runs inside a callback-form serializable transaction:
    // findUnique (target role) -> count() (total accounts). The first count()
    // inside the tx is the total — stub it to 1 so the last-admin guard fires.
    const services = createServices();
    services.prismaAuth.webAdminAccount.count.mockResolvedValueOnce(1);
    await withApp(services, async (app) => {
      const response = await app.inject({
        method: "DELETE",
        url: "/api/admin/kds/users/user-1",
        headers: { authorization: `Bearer ${BEARER_TOKEN}` }
      });
      expect(response.statusCode).toBe(422);
      expect(response.json()).toEqual({ error: "last_admin" });
    });
  });

  it("deletes a user when more than one admin exists", async () => {
    const services = createServices();
    await withApp(services, async (app) => {
      const response = await app.inject({
        method: "DELETE",
        url: "/api/admin/kds/users/user-1",
        headers: { authorization: `Bearer ${BEARER_TOKEN}` }
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ ok: true });
      // The delete runs in a single Serializable transaction to close the
      // check-then-act TOCTOU on the last_admin / last_owner invariants. Assert
      // the isolation level so a silent downgrade to the default reds the suite.
      expect(services.prismaAuth.$transaction).toHaveBeenCalledWith(
        expect.any(Function),
        expect.objectContaining({ isolationLevel: "Serializable" })
      );
    });
  });

  it("refuses to delete the last OWNER even when other (non-owner) admins remain", async () => {
    // Target is an OWNER; total accounts > 1 (a MANAGER remains) so last_admin
    // does NOT fire, but no OTHER owner exists, so last_owner must.
    const services = createServices();
    services.prismaAuth.webAdminAccount.findUnique.mockResolvedValueOnce({
      id: "user-1",
      username: "alice",
      displayName: "Alice",
      role: "OWNER" as const,
      passwordSetAt: new Date("2026-04-05T08:00:00.000Z"),
      createdAt: new Date("2026-04-01T08:00:00.000Z"),
      updatedAt: new Date("2026-05-01T08:00:00.000Z")
    });
    // total accounts = 2 (default), other-owner count = 0 (default where-branch).
    await withApp(services, async (app) => {
      const response = await app.inject({
        method: "DELETE",
        url: "/api/admin/kds/users/user-1",
        headers: { authorization: `Bearer ${BEARER_TOKEN}` }
      });
      expect(response.statusCode).toBe(422);
      expect(response.json()).toEqual({ error: "last_owner" });
      // The guard short-circuits before any destructive delete.
      expect(services.prismaAuth.webAdminAccount.delete).not.toHaveBeenCalled();
    });
  });

  it("deletes an OWNER when another OWNER survives", async () => {
    const services = createServices();
    services.prismaAuth.webAdminAccount.findUnique.mockResolvedValueOnce({
      id: "user-1",
      username: "alice",
      displayName: "Alice",
      role: "OWNER" as const,
      passwordSetAt: new Date("2026-04-05T08:00:00.000Z"),
      createdAt: new Date("2026-04-01T08:00:00.000Z"),
      updatedAt: new Date("2026-05-01T08:00:00.000Z")
    });
    // Another OWNER exists: the other-owner count returns 1, not the default 0.
    services.prismaAuth.webAdminAccount.count.mockImplementation(
      async (args?: { where?: { role?: string } }) => (args?.where?.role === "OWNER" ? 1 : 2)
    );
    await withApp(services, async (app) => {
      const response = await app.inject({
        method: "DELETE",
        url: "/api/admin/kds/users/user-1",
        headers: { authorization: `Bearer ${BEARER_TOKEN}` }
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ ok: true });
      expect(services.prismaAuth.webAdminAccount.delete).toHaveBeenCalled();
    });
  });

  it("refuses to delete the only USABLE owner when the surviving owner is a never-redeemed placeholder (lockout)", async () => {
    // Regression for the lockout-via-delete gap (review LOCKOUT-01): a second
    // OWNER ROW exists, but it is an invited account that never redeemed its
    // setup link (placeholder password, no passkey) and so cannot sign in. A
    // role-only count would see 1 surviving owner and wrongly allow the delete,
    // bricking the system. The guard must count only *usable* owners (those with
    // a real password OR a passkey), so the delete must be refused.
    const services = createServices();
    services.prismaAuth.webAdminAccount.findUnique.mockResolvedValueOnce({
      id: "user-1",
      username: "alice",
      displayName: "Alice",
      role: "OWNER" as const,
      passwordSetAt: new Date("2026-04-05T08:00:00.000Z"),
      createdAt: new Date("2026-04-01T08:00:00.000Z"),
      updatedAt: new Date("2026-05-01T08:00:00.000Z")
    });
    // role-only OWNER count would be 1 (the placeholder row exists); the
    // usable-owner count carries an OR filter and resolves to 0. If the guard
    // ever regresses to a plain role count it returns 1 and this test reds.
    services.prismaAuth.webAdminAccount.count.mockImplementation(
      async (args?: { where?: { role?: string; OR?: unknown[] } }) => {
        if (args?.where?.role === "OWNER") {
          return args.where.OR ? 0 : 1;
        }
        return 2; // total accounts
      }
    );
    await withApp(services, async (app) => {
      const response = await app.inject({
        method: "DELETE",
        url: "/api/admin/kds/users/user-1",
        headers: { authorization: `Bearer ${BEARER_TOKEN}` }
      });
      expect(response.statusCode).toBe(422);
      expect(response.json()).toEqual({ error: "last_owner" });
      expect(services.prismaAuth.webAdminAccount.delete).not.toHaveBeenCalled();
    });
  });

  it("issues a one-time setup link for a password reset", async () => {
    const services = createServices();
    await withApp(services, async (app) => {
      const response = await app.inject({
        method: "POST",
        url: "/api/admin/kds/users/user-1/password",
        headers: { authorization: `Bearer ${BEARER_TOKEN}` }
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.ok).toBe(true);
      expect(body.setupUrl).toContain("/set-password?token=");
      expect(body.expiresInSeconds).toBeGreaterThan(0);
      expect(body.oneTimePassword).toBeUndefined();
    });
  });

  it("sets a password from a valid setup token", async () => {
    const services = createServices();
    await withApp(services, async (app) => {
      const response = await app.inject({
        method: "POST",
        url: "/api/admin/kds/password/set",
        headers: {
          authorization: `Bearer ${BEARER_TOKEN}`,
          "content-type": "application/json"
        },
        payload: { token: "setup-token-abc123def456", newPassword: "a-long-enough-passphrase-2026" }
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ ok: true });
      expect(services.auth.setPasswordWithToken).toHaveBeenCalledWith({
        token: "setup-token-abc123def456",
        newPassword: "a-long-enough-passphrase-2026"
      });
    });
  });

  it("lists passkeys for a user", async () => {
    const services = createServices();
    await withApp(services, async (app) => {
      const response = await app.inject({
        method: "GET",
        url: "/api/admin/kds/users/user-1/passkeys",
        headers: { authorization: `Bearer ${BEARER_TOKEN}` }
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(Array.isArray(body.passkeys)).toBe(true);
      expect(body.passkeys[0].credentialId).toBe("cred-1");
    });
  });

  it("returns 404 when listing passkeys for a missing user", async () => {
    const services = createServices();
    services.prismaAuth.webAdminAccount.findUnique.mockResolvedValueOnce(null);
    await withApp(services, async (app) => {
      const response = await app.inject({
        method: "GET",
        url: "/api/admin/kds/users/missing/passkeys",
        headers: { authorization: `Bearer ${BEARER_TOKEN}` }
      });
      expect(response.statusCode).toBe(404);
    });
  });

  it("revokes a specific passkey when a usable password (and 2nd passkey) remains", async () => {
    // Default fixture: user-1 has a usable password (passwordSetAt set) and 2
    // passkeys, so revoking one leaves a login method — the lockout guard passes.
    const services = createServices();
    await withApp(services, async (app) => {
      const response = await app.inject({
        method: "DELETE",
        url: "/api/admin/kds/users/user-1/passkeys/cred-1",
        headers: { authorization: `Bearer ${BEARER_TOKEN}` }
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ ok: true });
    });
  });

  it("revokes a passkey for a placeholder-only account that still has a 2nd passkey", async () => {
    // No usable password (placeholder), but 2 passkeys: removing one leaves one,
    // so the lockout guard must NOT fire.
    const services = createServices();
    services.prismaAuth.webAdminAccount.findUnique.mockResolvedValue({
      id: "user-1",
      username: "alice",
      displayName: "Alice",
      role: "ADMIN" as const,
      passwordSetAt: null,
      createdAt: new Date("2026-04-01T08:00:00.000Z"),
      updatedAt: new Date("2026-05-01T08:00:00.000Z")
    });
    // 2 passkeys present.
    services.prismaAuth.webAuthnCredential.count.mockResolvedValue(2);
    await withApp(services, async (app) => {
      const response = await app.inject({
        method: "DELETE",
        url: "/api/admin/kds/users/user-1/passkeys/cred-1",
        headers: { authorization: `Bearer ${BEARER_TOKEN}` }
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ ok: true });
    });
  });

  it("refuses to revoke the SOLE passkey of a placeholder-only account (422 last_login_method)", async () => {
    // Placeholder-only account (no usable password) whose only login method is a
    // single passkey: revoking it would lock the account out, so the invariant
    // guard must block with last_login_method (422) and never delete.
    const services = createServices();
    services.prismaAuth.webAdminAccount.findUnique.mockResolvedValue({
      id: "user-1",
      username: "alice",
      displayName: "Alice",
      role: "ADMIN" as const,
      passwordSetAt: null,
      createdAt: new Date("2026-04-01T08:00:00.000Z"),
      updatedAt: new Date("2026-05-01T08:00:00.000Z")
    });
    services.prismaAuth.webAuthnCredential.count.mockResolvedValue(1);
    await withApp(services, async (app) => {
      const response = await app.inject({
        method: "DELETE",
        url: "/api/admin/kds/users/user-1/passkeys/cred-1",
        headers: { authorization: `Bearer ${BEARER_TOKEN}` }
      });
      expect(response.statusCode).toBe(422);
      expect(response.json()).toEqual({ error: "last_login_method" });
      // The guard must short-circuit before the destructive delete.
      expect(services.prismaAuth.webAuthnCredential.deleteMany).not.toHaveBeenCalled();
    });
  });

  it("returns 404 when revoking a non-existent passkey", async () => {
    const services = createServices();
    await withApp(services, async (app) => {
      const response = await app.inject({
        method: "DELETE",
        url: "/api/admin/kds/users/user-1/passkeys/missing",
        headers: { authorization: `Bearer ${BEARER_TOKEN}` }
      });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({ error: "passkey_not_found" });
    });
  });

  it("does not revoke another account's passkey (cross-account isolation -> passkey_not_found)", async () => {
    // cred-1 belongs to user-1; user-2 must not be able to revoke it. The
    // existence check is scoped by accountId via findFirst({ where: { accountId,
    // credentialId } }), so a cred owned by a different account looks absent.
    const services = createServices();
    services.prismaAuth.webAuthnCredential.findFirst.mockImplementation(
      async ({ where }: { where: { accountId?: string; credentialId?: string } }) =>
        where.accountId === "user-1" && where.credentialId === "cred-1" ? { id: "row-cred-1" } : null
    );
    await withApp(services, async (app) => {
      const response = await app.inject({
        method: "DELETE",
        url: "/api/admin/kds/users/user-2/passkeys/cred-1",
        headers: { authorization: `Bearer ${BEARER_TOKEN}` }
      });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({ error: "passkey_not_found" });
      // Isolation is enforced at the existence check; no delete is attempted.
      expect(services.prismaAuth.webAuthnCredential.deleteMany).not.toHaveBeenCalled();
    });
  });

  it("revokes a passkey inside a Serializable transaction (TOCTOU guard, review sec-2)", async () => {
    const services = createServices();
    await withApp(services, async (app) => {
      const response = await app.inject({
        method: "DELETE",
        url: "/api/admin/kds/users/user-1/passkeys/cred-1",
        headers: { authorization: `Bearer ${BEARER_TOKEN}` }
      });
      expect(response.statusCode).toBe(200);
      // Revoke now shares the transactional guard: existence + lockout re-read +
      // delete run in ONE Serializable transaction, so a concurrent removal can't
      // race past the last-login-method invariant. Asserting the isolation level
      // reds the suite if the helper silently regresses to a non-tx check-then-act.
      expect(services.prismaAuth.$transaction).toHaveBeenCalledWith(
        expect.any(Function),
        expect.objectContaining({ isolationLevel: "Serializable" })
      );
    });
  });
});

describe("admin bearer-gated /api/admin/kds/integrations/clover", () => {
  it("requires bearer auth on GET", async () => {
    await withApp(createServices(), async (app) => {
      const response = await app.inject({
        method: "GET",
        url: "/api/admin/kds/integrations/clover"
      });
      expect(response.statusCode).toBe(401);
    });
  });

  it("returns merchant + dashboard + readiness when bearer is valid", async () => {
    const services = createServices();
    await withApp(services, async (app) => {
      const response = await app.inject({
        method: "GET",
        url: "/api/admin/kds/integrations/clover",
        headers: { authorization: `Bearer ${BEARER_TOKEN}` }
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.merchant).toBeTruthy();
      expect(body.merchant.id).toBe("merchant-1");
      expect(body.dashboard).toBeTruthy();
      expect(body.dashboard.webhookUrl).toBeTruthy();
      expect(body.readiness.env).toBeInstanceOf(Array);
      expect(body.status).toBeTruthy();
      expect(body.status.merchantId).toBe("merchant-1");
    });
  });
});

describe("admin bearer-gated /api/admin/kds/daily-reset", () => {
  it("requires bearer auth on GET", async () => {
    await withApp(createServices(), async (app) => {
      const response = await app.inject({ method: "GET", url: "/api/admin/kds/daily-reset" });
      expect(response.statusCode).toBe(401);
    });
  });

  it("returns the current schedule + lastResetAt", async () => {
    const services = createServices();
    await withApp(services, async (app) => {
      const response = await app.inject({
        method: "GET",
        url: "/api/admin/kds/daily-reset",
        headers: { authorization: `Bearer ${BEARER_TOKEN}` }
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.merchantId).toBe("merchant-1");
      expect(body.schedule.enabled).toBeDefined();
      expect(body.schedule.timeZone).toBe("UTC");
      expect(typeof body.schedule.hour).toBe("number");
      expect(typeof body.schedule.minute).toBe("number");
      expect(body.lastResetAt === null || typeof body.lastResetAt === "string").toBe(true);
    });
  });

  it("triggers a manual reset and returns resetAt", async () => {
    const services = createServices();
    await withApp(services, async (app) => {
      const response = await app.inject({
        method: "POST",
        url: "/api/admin/kds/daily-reset",
        headers: {
          authorization: `Bearer ${BEARER_TOKEN}`,
          "content-type": "application/json"
        },
        payload: {}
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.ok).toBe(true);
      expect(body.merchantId).toBe("merchant-1");
      expect(typeof body.resetAt).toBe("string");
      expect(services.queue.clearForMerchant).toHaveBeenCalledWith("merchant-1");
      expect(services.hub.publishSnapshotRequired).toHaveBeenCalledWith(
        "merchant-1",
        "nightly-reset"
      );
    });
  });

  it("returns 404 when the merchant does not exist", async () => {
    const services = createServices();
    services.prisma.cloverMerchant.findUnique.mockResolvedValueOnce(null);
    services.prisma.cloverMerchant.findUnique.mockResolvedValueOnce(null);
    await withApp(services, async (app) => {
      const response = await app.inject({
        method: "POST",
        url: "/api/admin/kds/daily-reset",
        headers: {
          authorization: `Bearer ${BEARER_TOKEN}`,
          "content-type": "application/json"
        },
        payload: { merchantId: "ghost" }
      });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({ error: "merchant_not_found" });
    });
  });
});
