import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// GH #476: the backoffice login routes must destroy any pre-existing (possibly
// fixated) session before minting a new one. We mock the auth service so we can
// assert destroySession is invoked with the stale cookie value on success and is
// a no-op when no session cookie is present.

const destroySessionMock = vi.fn(async (_sessionId: string | undefined) => undefined);
const createSessionMock = vi.fn(async () => ({
  sessionId: "fresh-session",
  session: {
    accountId: "acct_1",
    username: "admin",
    displayName: "Backoffice Admin",
    role: "ADMIN",
    issuedAt: "2026-06-03T00:00:00.000Z",
    lastSeenAt: "2026-06-03T00:00:00.000Z"
  }
}));

const account = {
  id: "acct_1",
  username: "admin",
  displayName: "Backoffice Admin",
  role: "ADMIN"
};

function buildAuthMock() {
  return {
    getPasswordRateLimit: vi.fn(async () => ({ attempts: 0, blocked: false, retryAfterSeconds: 0 })),
    registerFailedPasswordAttempt: vi.fn(async () => ({ attempts: 1, blocked: false, retryAfterSeconds: 900 })),
    clearPasswordAttempts: vi.fn(async () => undefined),
    verifyPassword: vi.fn(async (username: string, password: string) =>
      username === "admin" && password === "secret" ? account : null
    ),
    getPasskeyCount: vi.fn(async () => 0),
    destroySession: destroySessionMock,
    createSession: createSessionMock,
    getSessionCookieOptions: vi.fn(() => ({
      httpOnly: true,
      maxAge: 43_200,
      path: "/",
      sameSite: "lax" as const,
      secure: false
    })),
    getFlowCookieOptions: vi.fn(() => ({
      httpOnly: true,
      maxAge: 300,
      path: "/",
      sameSite: "lax" as const,
      secure: false
    }))
  };
}

let authMock = buildAuthMock();

vi.mock("@/lib/auth/service", () => ({
  getBackofficeAuthService: () => authMock
}));

const COOKIE_NAME = "rop_backoffice_session";

beforeEach(() => {
  vi.resetModules();
  destroySessionMock.mockClear();
  createSessionMock.mockClear();
  authMock = buildAuthMock();
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function callPasswordLogin(priorSessionId?: string) {
  const { POST } = await import("@/app/api/auth/login/password/route");
  const { NextRequest } = await import("next/server");
  const request = new NextRequest("http://localhost:3001/api/auth/login/password", {
    method: "POST",
    body: JSON.stringify({ username: "admin", password: "secret" }),
    headers: { "content-type": "application/json" }
  });
  // happy-dom forbids setting Origin/Cookie via the Headers *constructor*, but
  // both stick when set on the live request post-construction (mirrors the real
  // browser/server flow that validateRequestOrigin + request.cookies expect).
  request.headers.set("origin", "http://localhost:3001");
  if (priorSessionId) {
    request.cookies.set(COOKIE_NAME, priorSessionId);
  }
  return POST(request);
}

describe("backoffice password login session fixation (GH #476)", () => {
  test("destroys the pre-existing session before creating a new one", async () => {
    const response = await callPasswordLogin("stale-session");

    expect(response.status).toBe(200);
    expect(destroySessionMock).toHaveBeenCalledWith("stale-session");
    expect(createSessionMock).toHaveBeenCalledTimes(1);

    // Confirm ordering: destroy must run before create.
    const destroyOrder = destroySessionMock.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY;
    const createOrder = createSessionMock.mock.invocationCallOrder[0] ?? Number.NEGATIVE_INFINITY;
    expect(destroyOrder).toBeLessThan(createOrder);

    // A fresh session cookie is issued.
    const setCookie = response.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain(`${COOKIE_NAME}=fresh-session`);
  });

  test("is a no-op for destroySession when there is no prior cookie", async () => {
    const response = await callPasswordLogin();

    expect(response.status).toBe(200);
    const destroyCalls = destroySessionMock.mock.calls;
    // Called with undefined (or not at all) — never with a real session id.
    expect(destroyCalls.every(([id]) => id === undefined)).toBe(true);
    expect(createSessionMock).toHaveBeenCalledTimes(1);
  });
});
