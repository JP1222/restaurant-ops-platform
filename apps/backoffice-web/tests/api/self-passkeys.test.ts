import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// Self-service passkey BFF (ADR-0029 P2). These routes are SESSION-scoped: the
// account is always derived from the cookie via getSessionUser, never from the
// request body / path. This suite asserts:
//   - GET lists only the SESSION account's passkeys (the id passed to the
//     service is the session user's, never anything attacker-controlled),
//   - DELETE enforces validateRequestOrigin (403 on an untrusted origin),
//   - DELETE delegates to the shared transactional guard (deletePasskeyGuarded):
//     a last_login_method result surfaces as 409 (never bricking the account),
//     a not_found result as 404 (existence is checked first, so a stale id is a
//     404, not a 409 masking it),
//   - both routes 401 without a session.
//
// getSessionUser and the auth service are mocked at the module seam (the same
// pattern as auth-login-session-fixation.test.ts); the routes are exercised with
// a real NextRequest via app.inject-style direct import.

const SESSION_USER = { id: "acct_self", username: "owner", displayName: "Owner" };

const getSessionUserMock = vi.fn(async () => SESSION_USER as typeof SESSION_USER | null);

const listPasskeysMock = vi.fn();
const deletePasskeyGuardedMock = vi.fn();

function buildAuthMock() {
  return {
    listPasskeys: listPasskeysMock,
    deletePasskeyGuarded: deletePasskeyGuardedMock
  };
}

let authMock = buildAuthMock();

vi.mock("@/lib/auth/session-user", () => ({
  getSessionUser: () => getSessionUserMock()
}));

vi.mock("@/lib/auth/service", () => ({
  getBackofficeAuthService: () => authMock
}));

const TRUSTED_ORIGIN = "http://localhost:3001";

beforeEach(() => {
  vi.resetModules();
  getSessionUserMock.mockReset();
  getSessionUserMock.mockResolvedValue(SESSION_USER);
  listPasskeysMock.mockReset();
  deletePasskeyGuardedMock.mockReset();
  authMock = buildAuthMock();
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function callList() {
  const { GET } = await import("@/app/api/auth/passkeys/route");
  const { NextRequest } = await import("next/server");
  return GET(new NextRequest("http://localhost:3001/api/auth/passkeys"));
}

async function callDelete(
  credentialId: string,
  { origin = TRUSTED_ORIGIN }: { origin?: string | null } = {}
) {
  const { DELETE } = await import("@/app/api/auth/passkeys/[credentialId]/route");
  const { NextRequest } = await import("next/server");
  const request = new NextRequest(
    `http://localhost:3001/api/auth/passkeys/${encodeURIComponent(credentialId)}`,
    { method: "DELETE" }
  );
  if (origin) {
    request.headers.set("origin", origin);
  }
  return DELETE(request, { params: Promise.resolve({ credentialId }) });
}

describe("GET /api/auth/passkeys (self list)", () => {
  test("lists ONLY the session account's passkeys", async () => {
    listPasskeysMock.mockResolvedValueOnce([
      { credentialId: "cred_1", createdAt: "2026-01-01T00:00:00.000Z", lastUsedAt: null, deviceType: "platform", backedUp: true, transports: ["internal"] }
    ]);

    const res = await callList();

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      passkeys: [
        { credentialId: "cred_1", createdAt: "2026-01-01T00:00:00.000Z", lastUsedAt: null, deviceType: "platform", backedUp: true, transports: ["internal"] }
      ]
    });
    // Identity is the session user's id — never derived from the request.
    expect(listPasskeysMock).toHaveBeenCalledWith(SESSION_USER.id);
  });

  test("401 with no session", async () => {
    getSessionUserMock.mockResolvedValueOnce(null);
    const res = await callList();
    expect(res.status).toBe(401);
    expect(listPasskeysMock).not.toHaveBeenCalled();
  });

  test("500 (not a leak) when the service throws", async () => {
    listPasskeysMock.mockRejectedValueOnce(new Error("redis down at redis://secret:6379"));
    const res = await callList();
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Could not load passkeys.");
    expect(body.error).not.toContain("redis://");
  });
});

describe("DELETE /api/auth/passkeys/[credentialId] (self remove)", () => {
  test("rejects an untrusted origin with 403 before touching the session", async () => {
    const res = await callDelete("cred_1", { origin: "https://evil.example.com" });
    expect(res.status).toBe(403);
    expect(getSessionUserMock).not.toHaveBeenCalled();
    expect(deletePasskeyGuardedMock).not.toHaveBeenCalled();
  });

  test("rejects a request with no origin/referer with 403", async () => {
    const res = await callDelete("cred_1", { origin: null });
    expect(res.status).toBe(403);
    expect(deletePasskeyGuardedMock).not.toHaveBeenCalled();
  });

  test("401 with no session (origin trusted)", async () => {
    getSessionUserMock.mockResolvedValueOnce(null);
    const res = await callDelete("cred_1");
    expect(res.status).toBe(401);
    expect(deletePasskeyGuardedMock).not.toHaveBeenCalled();
  });

  test("409 last_login_method when the guard refuses to brick the account", async () => {
    deletePasskeyGuardedMock.mockResolvedValueOnce({ ok: false, reason: "last_login_method" });

    const res = await callDelete("cred_only");

    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("last_login_method");
    expect(body.message).toMatch(/only sign-in method/i);
    // Identity is the session user's id — never derived from the request path.
    expect(deletePasskeyGuardedMock).toHaveBeenCalledWith(SESSION_USER.id, "cred_only");
  });

  test("removes a passkey self-scoped when the guard allows it", async () => {
    deletePasskeyGuardedMock.mockResolvedValueOnce({ ok: true });

    const res = await callDelete("cred_2");

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });
    // Self-scoped: the (accountId, credentialId) pair is the session user's id.
    expect(deletePasskeyGuardedMock).toHaveBeenCalledWith(SESSION_USER.id, "cred_2");
  });

  test("404 when the guard reports the credential is not the account's", async () => {
    deletePasskeyGuardedMock.mockResolvedValueOnce({ ok: false, reason: "not_found" });

    const res = await callDelete("cred_someone_else");

    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Passkey not found.");
  });
});
