import cookie from "@fastify/cookie";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { wouldLeaveNoLoginMethod } from "@rop/auth/server";
import type { AppConfig } from "../src/config.js";
import { registerAuthRoutes } from "../src/routes/auth.js";
import { WEBAUTHN_FLOW_COOKIE_NAME, WEBAUTHN_TIMEOUT_MS, WEB_SESSION_COOKIE_NAME } from "../src/lib/web-auth.js";

const {
  generateRegistrationOptionsMock,
  verifyRegistrationResponseMock,
  generateAuthenticationOptionsMock,
  verifyAuthenticationResponseMock
} = vi.hoisted(() => ({
  generateRegistrationOptionsMock: vi.fn(async () => ({
    challenge: "registration-challenge"
  })),
  verifyRegistrationResponseMock: vi.fn(async () => ({
    verified: true,
    registrationInfo: {
      credential: {
        id: "cred-1",
        publicKey: new Uint8Array([1, 2, 3]),
        counter: 0
      },
      credentialDeviceType: "multiDevice",
      credentialBackedUp: true
    }
  })),
  generateAuthenticationOptionsMock: vi.fn(async () => ({
    challenge: "authentication-challenge"
  })),
  verifyAuthenticationResponseMock: vi.fn(async () => ({
    verified: true,
    authenticationInfo: {
      credentialID: "cred-1",
      newCounter: 4,
      userVerified: true,
      credentialDeviceType: "multiDevice",
      credentialBackedUp: true,
      origin: "https://kds.example.com",
      rpID: "kds.example.com"
    }
  }))
}));

vi.mock("@simplewebauthn/server", () => ({
  generateRegistrationOptions: generateRegistrationOptionsMock,
  verifyRegistrationResponse: verifyRegistrationResponseMock,
  generateAuthenticationOptions: generateAuthenticationOptionsMock,
  verifyAuthenticationResponse: verifyAuthenticationResponseMock
}));

function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    nodeEnv: "test",
    apiPort: 4000,
    appBaseUrl: "https://kds.example.com",
    sessionSecret: "test-secret",
    databaseUrl: "postgres://example",
    redisUrl: "redis://example",
    webLoginUsername: "admin",
    webLoginPasswordHash: "hash",
    webLoginDisplayName: "Kitchen Admin",
    webauthnRpId: "kds.example.com",
    webauthnRpName: "Example Kitchen KDS",
    webSessionTtlHours: 12,
    cloverBaseUrl: "https://api.clover.com",
    cloverRegion: "US",
    cloverMerchantId: undefined,
    cloverToken: undefined,
    cloverAppId: undefined,
    cloverAppSecret: undefined,
    cloverWebhookAuthCode: "webhook-secret",
    deliverectWebhookSecret: undefined,
    deliverectWebhookSignatureHeader: "x-server-authorization-hmac-sha256",
    deliverectApiUrl: "https://api.deliverect.com",
    deliverectStagingApiUrl: "https://staging.deliverect.com",
    reconcileIntervalMs: 45_000,
    workerIntervalMs: 1_000,
    dailyResetEnabled: false,
    dailyResetHour: 21,
    dailyResetMinute: 0,
    dailyResetTimezone: "UTC",
    dailyResetCheckIntervalMs: 30_000,
    ...overrides
  };
}

function createServices(configOverrides: Partial<AppConfig> = {}) {
  const account = {
    id: "account-1",
    username: "admin",
    displayName: "Kitchen Admin",
    role: "ADMIN",
    passwordHash: "hash",
    // Non-null by default: the standard fixture has a usable (real) password,
    // so deleting its single passkey leaves a login method and is allowed.
    // Self-service tests that exercise the lockout guard clear this to null.
    passwordSetAt: new Date("2026-04-01T00:00:00.000Z") as Date | null
  };
  const session = {
    accountId: account.id,
    username: account.username,
    displayName: account.displayName,
    role: account.role,
    issuedAt: "2026-04-22T06:00:00.000Z",
    lastSeenAt: "2026-04-22T06:00:00.000Z"
  };
  let flowState:
    | {
        challenge: string;
        flowType: "registration" | "authentication";
        accountId: string | null;
        expectedOrigin: string;
        expectedRPID: string;
        issuedAt: string;
      }
    | null = null;
  let passkeyRecord:
    | {
        credentialId: string;
        createdAt: Date;
        lastUsedAt: Date | null;
        deviceType: string;
        backedUp: boolean;
        transports: string[];
        account: typeof account;
        publicKey: Uint8Array;
        counter: number;
      }
    | null = null;

  const auth = {
    getAccountById: vi.fn(async (accountId: string) => (accountId === account.id ? account : null)),
    readSession: vi.fn(async (sessionId: string | undefined) => (sessionId === "session-1" ? session : null)),
    destroySession: vi.fn(async () => undefined),
    getSessionCookieOptions: vi.fn(() => ({
      path: "/",
      httpOnly: true,
      sameSite: "lax" as const
    })),
    getFlowCookieOptions: vi.fn(() => ({
      path: "/",
      httpOnly: true,
      sameSite: "lax" as const
    })),
    getPasskeyCount: vi.fn(async () => (passkeyRecord ? 1 : 0)),
    verifyPassword: vi.fn(async (username: string, password: string) =>
      username === "admin" && password === "secret" ? account : null
    ),
    getPasswordRateLimit: vi.fn(async () => ({
      attempts: 0,
      retryAfterSeconds: 0
    })),
    registerFailedPasswordAttempt: vi.fn(async () => ({
      attempts: 1,
      retryAfterSeconds: 900,
      blocked: false
    })),
    clearPasswordAttempts: vi.fn(async () => undefined),
    getPasskeyRateLimit: vi.fn(async () => ({
      attempts: 0,
      blocked: false,
      retryAfterSeconds: 0
    })),
    registerFailedPasskeyAttempt: vi.fn(async () => ({
      attempts: 1,
      blocked: false,
      retryAfterSeconds: 900
    })),
    clearPasskeyAttempts: vi.fn(async () => undefined),
    createSession: vi.fn(async () => ({
      sessionId: "session-1",
      session
    })),
    createWebAuthnFlow: vi.fn(async (input: { challenge: string; flowType: "registration" | "authentication"; accountId?: string }) => {
      flowState = {
        challenge: input.challenge,
        flowType: input.flowType,
        accountId: input.accountId ?? null,
        expectedOrigin: "https://kds.example.com",
        expectedRPID: "kds.example.com",
        issuedAt: "2026-04-22T06:10:00.000Z"
      };
      return "flow-1";
    }),
    consumeWebAuthnFlow: vi.fn(async (flowId: string | undefined) => {
      if (flowId !== "flow-1") {
        return null;
      }

      const current = flowState;
      flowState = null;
      return current;
    }),
    listPasskeys: vi.fn(async () =>
      passkeyRecord
        ? [
            {
              credentialId: passkeyRecord.credentialId,
              createdAt: passkeyRecord.createdAt.toISOString(),
              lastUsedAt: passkeyRecord.lastUsedAt ? passkeyRecord.lastUsedAt.toISOString() : null,
              deviceType: passkeyRecord.deviceType,
              backedUp: passkeyRecord.backedUp,
              transports: passkeyRecord.transports
            }
          ]
        : []
    ),
    savePasskeyCredential: vi.fn(async (input: {
      credentialId: string;
      publicKey: Uint8Array;
      counter: number;
      deviceType: string;
      backedUp: boolean;
      transports: string[];
    }) => {
      passkeyRecord = {
        credentialId: input.credentialId,
        createdAt: new Date("2026-04-22T06:11:00.000Z"),
        lastUsedAt: null,
        deviceType: input.deviceType,
        backedUp: input.backedUp,
        transports: input.transports,
        account,
        publicKey: input.publicKey,
        counter: input.counter
      };

      return {
        credentialId: passkeyRecord.credentialId,
        createdAt: passkeyRecord.createdAt,
        lastUsedAt: passkeyRecord.lastUsedAt,
        deviceType: passkeyRecord.deviceType,
        backedUp: passkeyRecord.backedUp,
        transports: passkeyRecord.transports
      };
    }),
    findCredentialByCredentialId: vi.fn(async (credentialId: string) =>
      passkeyRecord?.credentialId === credentialId ? passkeyRecord : null
    ),
    toWebAuthnCredential: vi.fn((record: typeof passkeyRecord) =>
      record
        ? {
            id: record.credentialId,
            publicKey: record.publicKey,
            counter: record.counter,
            transports: record.transports
          }
        : null
    ),
    updateCredentialUsage: vi.fn(async (credentialId: string, update: { counter: number; deviceType: string; backedUp: boolean; lastUsedAt: Date }) => {
      if (passkeyRecord?.credentialId === credentialId) {
        passkeyRecord = {
          ...passkeyRecord,
          counter: update.counter,
          deviceType: update.deviceType,
          backedUp: update.backedUp,
          lastUsedAt: update.lastUsedAt
        };
      }
    }),
    deletePasskey: vi.fn(async (_accountId: string, credentialId: string) => {
      if (passkeyRecord?.credentialId !== credentialId) {
        return false;
      }

      passkeyRecord = null;
      return true;
    }),
    // Lockout-invariant surface consumed by the self-service DELETE route.
    // Mirrors the real service shape: `passwordSet` follows `passwordSetAt`
    // (a real/usable password), `passkeyCount` follows the live passkey record.
    countUsableLoginMethods: vi.fn(async () => {
      const passwordSet = account.passwordSetAt != null;
      const passkeyCount = passkeyRecord ? 1 : 0;
      return { passwordSet, passkeyCount, total: (passwordSet ? 1 : 0) + passkeyCount };
    }),
    // Reuse the real pure predicate so the guard logic under test is the
    // production one, not a re-statement that could drift from it.
    wouldLeaveNoLoginMethod: vi.fn(wouldLeaveNoLoginMethod),
    // Shared transactional guard the self-service DELETE route now calls. Stateful
    // mock mirroring the real helper: existence-first against the live passkey
    // record, then the lockout re-read, then delete. Branch-specific tests override
    // it with mockResolvedValueOnce.
    deletePasskeyGuarded: vi.fn(async (_accountId: string, credentialId: string) => {
      if (passkeyRecord?.credentialId !== credentialId) {
        return { ok: false, reason: "not_found" as const };
      }
      const passwordSet = account.passwordSetAt != null;
      const passkeyCount = passkeyRecord ? 1 : 0;
      if (wouldLeaveNoLoginMethod({ passwordSet, passkeyCount }, "passkey")) {
        return { ok: false, reason: "last_login_method" as const };
      }
      passkeyRecord = null;
      return { ok: true as const };
    })
  };

  return {
    config: makeConfig(configOverrides),
    auth
  } as never;
}

async function buildRouteApp(configOverrides: Partial<AppConfig> = {}) {
  const services = createServices(configOverrides);
  const app = Fastify();
  await app.register(cookie);
  await registerAuthRoutes(app as never, services);
  return { app, services };
}

afterEach(() => {
  vi.restoreAllMocks();
  generateRegistrationOptionsMock.mockClear();
  verifyRegistrationResponseMock.mockClear();
  generateAuthenticationOptionsMock.mockClear();
  verifyAuthenticationResponseMock.mockClear();
});

describe("auth routes", () => {
  it("returns unauthenticated when there is no session cookie", async () => {
    const { app } = await buildRouteApp();

    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/auth/session"
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ authenticated: false });
    } finally {
      await app.close();
    }
  });

  it("creates a session cookie for successful password login", async () => {
    const { app } = await buildRouteApp();

    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/auth/login/password",
        headers: {
          origin: "https://kds.example.com"
        },
        payload: {
          username: "admin",
          password: "secret"
        }
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        ok: true,
        session: {
          authenticated: true,
          username: "admin",
          displayName: "Kitchen Admin",
          hasPasskeys: false
        }
      });
      expect(response.headers["set-cookie"]).toEqual(
        expect.arrayContaining([expect.stringContaining(`${WEB_SESSION_COOKIE_NAME}=session-1`)])
      );
    } finally {
      await app.close();
    }
  });

  it("clears the session and redirects browser logout requests to login", async () => {
    const { app, services } = await buildRouteApp();

    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/auth/logout/browser?returnTo=%2Flogin%3FloggedOut%3D1",
        headers: {
          cookie: `${WEB_SESSION_COOKIE_NAME}=session-1`
        }
      });

      expect(response.statusCode).toBe(302);
      expect(response.headers.location).toBe("/login?loggedOut=1");
      expect(services.auth.destroySession).toHaveBeenCalledWith("session-1");
      expect(response.headers["set-cookie"]).toEqual(
        expect.arrayContaining([
          expect.stringContaining(`${WEB_SESSION_COOKIE_NAME}=;`),
          expect.stringContaining(`${WEBAUTHN_FLOW_COOKIE_NAME}=;`)
        ])
      );
    } finally {
      await app.close();
    }
  });

  it("rejects browser logout requests carrying a foreign Referer (GH #127)", async () => {
    const { app, services } = await buildRouteApp();

    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/auth/logout/browser?returnTo=%2Flogin",
        headers: {
          cookie: `${WEB_SESSION_COOKIE_NAME}=session-1`,
          referer: "https://evil.example.com/phishing"
        }
      });

      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({
        error: "Untrusted origin.",
        expectedOrigin: "https://kds.example.com"
      });
      // The CSRF attempt must NOT have destroyed the session.
      expect(services.auth.destroySession).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("rejects browser logout requests carrying a foreign Origin (GH #127)", async () => {
    const { app, services } = await buildRouteApp();

    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/auth/logout/browser?returnTo=%2Flogin",
        headers: {
          cookie: `${WEB_SESSION_COOKIE_NAME}=session-1`,
          origin: "https://evil.example.com"
        }
      });

      expect(response.statusCode).toBe(403);
      expect(services.auth.destroySession).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("allows browser logout requests with a same-site Referer (GH #127)", async () => {
    const { app, services } = await buildRouteApp();

    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/auth/logout/browser?returnTo=%2Flogin%3FloggedOut%3D1",
        headers: {
          cookie: `${WEB_SESSION_COOKIE_NAME}=session-1`,
          referer: "https://kds.example.com/board"
        }
      });

      expect(response.statusCode).toBe(302);
      expect(response.headers.location).toBe("/login?loggedOut=1");
      expect(services.auth.destroySession).toHaveBeenCalledWith("session-1");
    } finally {
      await app.close();
    }
  });

  it("invalidates a pre-existing session id on password login (GH #476)", async () => {
    const { app, services } = await buildRouteApp();

    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/auth/login/password",
        headers: {
          origin: "https://kds.example.com",
          // A fixated/stale session cookie the attacker may have planted.
          cookie: `${WEB_SESSION_COOKIE_NAME}=stale-session`
        },
        payload: {
          username: "admin",
          password: "secret"
        }
      });

      expect(response.statusCode).toBe(200);
      // The old session must be destroyed before the new one is minted.
      expect(services.auth.destroySession).toHaveBeenCalledWith("stale-session");
      expect(services.auth.createSession).toHaveBeenCalledTimes(1);
      // And the fresh session cookie is issued.
      expect(response.headers["set-cookie"]).toEqual(
        expect.arrayContaining([expect.stringContaining(`${WEB_SESSION_COOKIE_NAME}=session-1`)])
      );
    } finally {
      await app.close();
    }
  });

  it("does not call destroySession on password login without a prior cookie (GH #476)", async () => {
    const { app, services } = await buildRouteApp();

    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/auth/login/password",
        headers: {
          origin: "https://kds.example.com"
        },
        payload: {
          username: "admin",
          password: "secret"
        }
      });

      expect(response.statusCode).toBe(200);
      // No prior cookie => destroySession(undefined). Assert it was never asked
      // to destroy a real id (the no-op call with undefined is harmless either way).
      const destroyCalls = services.auth.destroySession.mock.calls as Array<[string | undefined]>;
      expect(destroyCalls.every(([id]) => id === undefined)).toBe(true);
    } finally {
      await app.close();
    }
  });

  it("invalidates a pre-existing session id on passkey login (GH #476)", async () => {
    const { app, services } = await buildRouteApp();

    try {
      // Register a passkey first so the authentication verify can succeed.
      await app.inject({
        method: "POST",
        url: "/api/auth/passkeys/registration/options",
        headers: {
          origin: "https://kds.example.com",
          cookie: `${WEB_SESSION_COOKIE_NAME}=session-1`
        },
        payload: {}
      });
      await app.inject({
        method: "POST",
        url: "/api/auth/passkeys/registration/verify",
        headers: {
          origin: "https://kds.example.com",
          cookie: `${WEB_SESSION_COOKIE_NAME}=session-1; ${WEBAUTHN_FLOW_COOKIE_NAME}=flow-1`
        },
        payload: {
          response: {
            id: "cred-1",
            rawId: "cred-1",
            response: {
              clientDataJSON: "a",
              attestationObject: "b",
              transports: ["internal"]
            },
            clientExtensionResults: {},
            type: "public-key"
          }
        }
      });
      await app.inject({
        method: "POST",
        url: "/api/auth/passkeys/authentication/options",
        headers: {
          origin: "https://kds.example.com"
        },
        payload: {}
      });

      services.auth.destroySession.mockClear();

      const response = await app.inject({
        method: "POST",
        url: "/api/auth/passkeys/authentication/verify",
        headers: {
          origin: "https://kds.example.com",
          // A fixated/stale session cookie alongside the in-flight flow cookie.
          cookie: `${WEB_SESSION_COOKIE_NAME}=stale-session; ${WEBAUTHN_FLOW_COOKIE_NAME}=flow-1`
        },
        payload: {
          response: {
            id: "cred-1",
            rawId: "cred-1",
            response: {
              clientDataJSON: "a",
              authenticatorData: "b",
              signature: "c"
            },
            clientExtensionResults: {},
            type: "public-key"
          }
        }
      });

      expect(response.statusCode).toBe(200);
      expect(services.auth.destroySession).toHaveBeenCalledWith("stale-session");
      expect(response.headers["set-cookie"]).toEqual(
        expect.arrayContaining([expect.stringContaining(`${WEB_SESSION_COOKIE_NAME}=session-1`)])
      );
    } finally {
      await app.close();
    }
  });

  it("rejects invalid password login attempts", async () => {
    const { app, services } = await buildRouteApp();

    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/auth/login/password",
        headers: {
          origin: "https://kds.example.com"
        },
        payload: {
          username: "admin",
          password: "wrong"
        }
      });

      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({
        error: "Invalid username or password."
      });
      expect(services.auth.registerFailedPasswordAttempt).toHaveBeenCalledWith(expect.any(String), "admin");
    } finally {
      await app.close();
    }
  });

  it("creates WebAuthn registration options and persists the flow cookie", async () => {
    const { app } = await buildRouteApp();

    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/auth/passkeys/registration/options",
        headers: {
          origin: "https://kds.example.com",
          cookie: `${WEB_SESSION_COOKIE_NAME}=session-1`
        },
        payload: {}
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        challenge: "registration-challenge"
      });
      expect(generateRegistrationOptionsMock).toHaveBeenCalledTimes(1);
      expect(generateRegistrationOptionsMock).toHaveBeenCalledWith(
        expect.objectContaining({ timeout: WEBAUTHN_TIMEOUT_MS })
      );
      expect(response.headers["set-cookie"]).toEqual(
        expect.arrayContaining([expect.stringContaining(`${WEBAUTHN_FLOW_COOKIE_NAME}=flow-1`)])
      );
    } finally {
      await app.close();
    }
  });

  it("pins the WebAuthn timeout on authentication options (GH #148)", async () => {
    const { app } = await buildRouteApp();

    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/auth/passkeys/authentication/options",
        headers: {
          origin: "https://kds.example.com"
        },
        payload: {}
      });

      expect(response.statusCode).toBe(200);
      expect(generateAuthenticationOptionsMock).toHaveBeenCalledTimes(1);
      expect(generateAuthenticationOptionsMock).toHaveBeenCalledWith(
        expect.objectContaining({ timeout: WEBAUTHN_TIMEOUT_MS })
      );
    } finally {
      await app.close();
    }
  });

  it("verifies passkey registration and saves the credential", async () => {
    const { app, services } = await buildRouteApp();

    try {
      await app.inject({
        method: "POST",
        url: "/api/auth/passkeys/registration/options",
        headers: {
          origin: "https://kds.example.com",
          cookie: `${WEB_SESSION_COOKIE_NAME}=session-1`
        },
        payload: {}
      });

      const response = await app.inject({
        method: "POST",
        url: "/api/auth/passkeys/registration/verify",
        headers: {
          origin: "https://kds.example.com",
          cookie: `${WEB_SESSION_COOKIE_NAME}=session-1; ${WEBAUTHN_FLOW_COOKIE_NAME}=flow-1`
        },
        payload: {
          response: {
            id: "cred-1",
            rawId: "cred-1",
            response: {
              clientDataJSON: "a",
              attestationObject: "b",
              transports: ["internal"]
            },
            clientExtensionResults: {},
            type: "public-key"
          }
        }
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        ok: true,
        passkey: {
          credentialId: "cred-1",
          createdAt: "2026-04-22T06:11:00.000Z",
          lastUsedAt: null,
          deviceType: "multiDevice",
          backedUp: true,
          transports: ["internal"]
        }
      });
      expect(services.auth.savePasskeyCredential).toHaveBeenCalledTimes(1);
      expect(verifyRegistrationResponseMock).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });

  it("verifies passkey authentication and refreshes the session cookie", async () => {
    const { app, services } = await buildRouteApp();

    try {
      await app.inject({
        method: "POST",
        url: "/api/auth/passkeys/registration/options",
        headers: {
          origin: "https://kds.example.com",
          cookie: `${WEB_SESSION_COOKIE_NAME}=session-1`
        },
        payload: {}
      });
      await app.inject({
        method: "POST",
        url: "/api/auth/passkeys/registration/verify",
        headers: {
          origin: "https://kds.example.com",
          cookie: `${WEB_SESSION_COOKIE_NAME}=session-1; ${WEBAUTHN_FLOW_COOKIE_NAME}=flow-1`
        },
        payload: {
          response: {
            id: "cred-1",
            rawId: "cred-1",
            response: {
              clientDataJSON: "a",
              attestationObject: "b",
              transports: ["internal"]
            },
            clientExtensionResults: {},
            type: "public-key"
          }
        }
      });

      await app.inject({
        method: "POST",
        url: "/api/auth/passkeys/authentication/options",
        headers: {
          origin: "https://kds.example.com"
        },
        payload: {}
      });

      const response = await app.inject({
        method: "POST",
        url: "/api/auth/passkeys/authentication/verify",
        headers: {
          origin: "https://kds.example.com",
          cookie: `${WEBAUTHN_FLOW_COOKIE_NAME}=flow-1`
        },
        payload: {
          response: {
            id: "cred-1",
            rawId: "cred-1",
            response: {
              clientDataJSON: "a",
              authenticatorData: "b",
              signature: "c"
            },
            clientExtensionResults: {},
            type: "public-key"
          }
        }
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        ok: true,
        session: {
          authenticated: true,
          username: "admin",
          displayName: "Kitchen Admin",
          hasPasskeys: true
        }
      });
      expect(services.auth.updateCredentialUsage).toHaveBeenCalledTimes(1);
      expect(verifyAuthenticationResponseMock).toHaveBeenCalledTimes(1);
      expect(response.headers["set-cookie"]).toEqual(
        expect.arrayContaining([expect.stringContaining(`${WEB_SESSION_COOKIE_NAME}=session-1`)])
      );
    } finally {
      await app.close();
    }
  });

  it("deletes passkeys and blocks future use of the removed credential", async () => {
    // The standard fixture account has a usable password (passwordSetAt set), so
    // removing its single passkey still leaves a login method — the lockout guard
    // does not fire and the delete is allowed.
    const { app } = await buildRouteApp();

    try {
      await app.inject({
        method: "POST",
        url: "/api/auth/passkeys/registration/options",
        headers: {
          origin: "https://kds.example.com",
          cookie: `${WEB_SESSION_COOKIE_NAME}=session-1`
        },
        payload: {}
      });
      await app.inject({
        method: "POST",
        url: "/api/auth/passkeys/registration/verify",
        headers: {
          origin: "https://kds.example.com",
          cookie: `${WEB_SESSION_COOKIE_NAME}=session-1; ${WEBAUTHN_FLOW_COOKIE_NAME}=flow-1`
        },
        payload: {
          response: {
            id: "cred-1",
            rawId: "cred-1",
            response: {
              clientDataJSON: "a",
              attestationObject: "b",
              transports: ["internal"]
            },
            clientExtensionResults: {},
            type: "public-key"
          }
        }
      });

      const deleteResponse = await app.inject({
        method: "DELETE",
        url: "/api/auth/passkeys/cred-1",
        headers: {
          origin: "https://kds.example.com",
          cookie: `${WEB_SESSION_COOKIE_NAME}=session-1`
        }
      });

      expect(deleteResponse.statusCode).toBe(200);
      expect(deleteResponse.json()).toEqual({ ok: true });

      await app.inject({
        method: "POST",
        url: "/api/auth/passkeys/authentication/options",
        headers: {
          origin: "https://kds.example.com"
        },
        payload: {}
      });

      const verifyResponse = await app.inject({
        method: "POST",
        url: "/api/auth/passkeys/authentication/verify",
        headers: {
          origin: "https://kds.example.com",
          cookie: `${WEBAUTHN_FLOW_COOKIE_NAME}=flow-1`
        },
        payload: {
          response: {
            id: "cred-1",
            rawId: "cred-1",
            response: {
              clientDataJSON: "a",
              authenticatorData: "b",
              signature: "c"
            },
            clientExtensionResults: {},
            type: "public-key"
          }
        }
      });

      expect(verifyResponse.statusCode).toBe(401);
      expect(verifyResponse.json()).toEqual({
        error: "Unknown passkey."
      });
    } finally {
      await app.close();
    }
  });

  it("refuses self-service deletion of the only sign-in method (409 last_login_method)", async () => {
    const { app, services } = await buildRouteApp();

    try {
      // The shared guard reports the account would be bricked (placeholder-only,
      // single passkey). The route must surface that as 409 and confirm nothing.
      services.auth.deletePasskeyGuarded.mockResolvedValueOnce({
        ok: false,
        reason: "last_login_method"
      });

      const response = await app.inject({
        method: "DELETE",
        url: "/api/auth/passkeys/cred-1",
        headers: {
          origin: "https://kds.example.com",
          cookie: `${WEB_SESSION_COOKIE_NAME}=session-1`
        }
      });

      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ error: "last_login_method" });
    } finally {
      await app.close();
    }
  });

  it("returns 404 (not 409) for a stale credential id on self-service deletion (LOCKOUT-03)", async () => {
    // Existence is checked first inside the guard, so an unknown credential is a
    // 404 — never a 409 last_login_method masking it.
    const { app, services } = await buildRouteApp();

    try {
      services.auth.deletePasskeyGuarded.mockResolvedValueOnce({ ok: false, reason: "not_found" });

      const response = await app.inject({
        method: "DELETE",
        url: "/api/auth/passkeys/missing-cred",
        headers: {
          origin: "https://kds.example.com",
          cookie: `${WEB_SESSION_COOKIE_NAME}=session-1`
        }
      });

      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({ error: "Passkey not found." });
    } finally {
      await app.close();
    }
  });

  it("requires a resident key on registration options (discoverable credential)", async () => {
    const { app } = await buildRouteApp();

    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/auth/passkeys/registration/options",
        headers: {
          origin: "https://kds.example.com",
          cookie: `${WEB_SESSION_COOKIE_NAME}=session-1`
        },
        payload: {}
      });

      expect(response.statusCode).toBe(200);
      expect(generateRegistrationOptionsMock).toHaveBeenCalledWith(
        expect.objectContaining({
          authenticatorSelection: expect.objectContaining({
            residentKey: "required",
            userVerification: "required"
          })
        })
      );
    } finally {
      await app.close();
    }
  });

  it("rejects passkey authentication options with 429 when the per-IP cap is hit", async () => {
    const { app, services } = await buildRouteApp();
    services.auth.getPasskeyRateLimit.mockResolvedValue({
      attempts: 5,
      blocked: true,
      retryAfterSeconds: 900
    });

    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/auth/passkeys/authentication/options",
        headers: {
          origin: "https://kds.example.com"
        },
        payload: {}
      });

      expect(response.statusCode).toBe(429);
      expect(response.json()).toEqual({
        error: "Too many passkey attempts.",
        retryAfterSeconds: 900
      });
      expect(response.headers["retry-after"]).toBe("900");
      expect(generateAuthenticationOptionsMock).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("rejects passkey authentication verify with 429 when the per-IP cap is hit", async () => {
    const { app, services } = await buildRouteApp();
    services.auth.getPasskeyRateLimit.mockResolvedValue({
      attempts: 5,
      blocked: true,
      retryAfterSeconds: 900
    });

    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/auth/passkeys/authentication/verify",
        headers: {
          origin: "https://kds.example.com",
          cookie: `${WEBAUTHN_FLOW_COOKIE_NAME}=flow-1`
        },
        payload: {
          response: {
            id: "cred-1",
            rawId: "cred-1",
            response: {
              clientDataJSON: "a",
              authenticatorData: "b",
              signature: "c"
            },
            clientExtensionResults: {},
            type: "public-key"
          }
        }
      });

      expect(response.statusCode).toBe(429);
      expect(response.json()).toEqual({
        error: "Too many passkey attempts.",
        retryAfterSeconds: 900
      });
      expect(response.headers["retry-after"]).toBe("900");
      expect(verifyAuthenticationResponseMock).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
