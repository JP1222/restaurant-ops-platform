import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// Self-service profile BFF (ADR-0029 P2). SESSION-scoped: the account is always
// the cookie's, never the body. This suite asserts:
//   - GET returns the REAL logged-in record (the session user's id is what gets
//     resolved; role + passkeyCount come back) and there is NO email field,
//   - GET 404s when the resolved account no longer exists,
//   - PATCH updates ONLY displayName, self-scoped to the session id,
//   - PATCH ignores a `role` change in the body (role is read-only — the new
//     role is never forwarded to the service and the response carries the
//     unchanged role),
//   - PATCH ignores an `email` field entirely (there is no email channel),
//   - PATCH enforces validateRequestOrigin (403) and a session (401),
//   - PATCH 400s a body with no valid displayName.
//
// lib/auth/profile (the db-auth carve-out) and getSessionUser are mocked at the
// module seam, mirroring auth-login-session-fixation.test.ts.

const SESSION_USER = { id: "acct_self", username: "owner", displayName: "Owner" };

const PROFILE = {
  id: "acct_self",
  username: "owner",
  displayName: "Owner",
  role: "OWNER" as const,
  passkeyCount: 2
};

const getSessionUserMock = vi.fn(async () => SESSION_USER as typeof SESSION_USER | null);
const getSelfProfileMock = vi.fn();
const updateSelfProfileMock = vi.fn();

vi.mock("@/lib/auth/session-user", () => ({
  getSessionUser: () => getSessionUserMock()
}));

vi.mock("@/lib/auth/profile", () => ({
  getSelfProfile: (...args: unknown[]) => getSelfProfileMock(...args),
  updateSelfProfile: (...args: unknown[]) => updateSelfProfileMock(...args)
}));

const TRUSTED_ORIGIN = "http://localhost:3001";

beforeEach(() => {
  vi.resetModules();
  getSessionUserMock.mockReset();
  getSessionUserMock.mockResolvedValue(SESSION_USER);
  getSelfProfileMock.mockReset();
  updateSelfProfileMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function callGet() {
  const { GET } = await import("@/app/api/auth/profile/route");
  const { NextRequest } = await import("next/server");
  return GET(new NextRequest("http://localhost:3001/api/auth/profile"));
}

async function callPatch(
  body: unknown,
  { origin = TRUSTED_ORIGIN, raw }: { origin?: string | null; raw?: string } = {}
) {
  const { PATCH } = await import("@/app/api/auth/profile/route");
  const { NextRequest } = await import("next/server");
  const request = new NextRequest("http://localhost:3001/api/auth/profile", {
    method: "PATCH",
    body: raw ?? JSON.stringify(body),
    headers: { "content-type": "application/json" }
  });
  if (origin) {
    request.headers.set("origin", origin);
  }
  return PATCH(request);
}

describe("GET /api/auth/profile (self)", () => {
  test("returns the real logged-in record — resolved by the SESSION id", async () => {
    getSelfProfileMock.mockResolvedValueOnce(PROFILE);

    const res = await callGet();

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual(PROFILE);
    // Identity is the session user's id, never the request.
    expect(getSelfProfileMock).toHaveBeenCalledWith(SESSION_USER.id);
    // Role + passkeyCount are present; there is NO email channel in the suite.
    expect(body).toHaveProperty("role", "OWNER");
    expect(body).toHaveProperty("passkeyCount", 2);
    expect(body).not.toHaveProperty("email");
  });

  test("401 with no session", async () => {
    getSessionUserMock.mockResolvedValueOnce(null);
    const res = await callGet();
    expect(res.status).toBe(401);
    expect(getSelfProfileMock).not.toHaveBeenCalled();
  });

  test("404 when the resolved account no longer exists", async () => {
    getSelfProfileMock.mockResolvedValueOnce(null);
    const res = await callGet();
    expect(res.status).toBe(404);
  });
});

describe("PATCH /api/auth/profile (self-edit displayName only)", () => {
  test("updates ONLY displayName, self-scoped to the session id", async () => {
    updateSelfProfileMock.mockResolvedValueOnce({ ...PROFILE, displayName: "New Name" });

    const res = await callPatch({ displayName: "New Name" });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ...PROFILE, displayName: "New Name" });
    // Self-scoped: (sessionId, displayName) — the route signature only forwards
    // those two, so a body role/email can never reach the service.
    expect(updateSelfProfileMock).toHaveBeenCalledWith(SESSION_USER.id, "New Name");
    expect(updateSelfProfileMock).toHaveBeenCalledTimes(1);
  });

  test("ignores a role change in the body — role is never forwarded", async () => {
    updateSelfProfileMock.mockResolvedValueOnce({ ...PROFILE, displayName: "New Name" });

    const res = await callPatch({ displayName: "New Name", role: "ADMIN" });

    expect(res.status).toBe(200);
    // The service is called with exactly (id, displayName) — no role argument.
    expect(updateSelfProfileMock).toHaveBeenCalledWith(SESSION_USER.id, "New Name");
    const [, ...extraArgs] = updateSelfProfileMock.mock.calls[0]!;
    expect(extraArgs).toEqual(["New Name"]);
    // The returned role is the unchanged session role, not the attempted ADMIN.
    const body = (await res.json()) as { role: string };
    expect(body.role).toBe("OWNER");
  });

  test("ignores an email field entirely — there is no email channel", async () => {
    updateSelfProfileMock.mockResolvedValueOnce({ ...PROFILE, displayName: "Renamed" });

    const res = await callPatch({ displayName: "Renamed", email: "attacker@evil.test" });

    expect(res.status).toBe(200);
    expect(updateSelfProfileMock).toHaveBeenCalledWith(SESSION_USER.id, "Renamed");
    const body = await res.json();
    expect(body).not.toHaveProperty("email");
  });

  test("403 on an untrusted origin before touching the session", async () => {
    const res = await callPatch({ displayName: "Nope" }, { origin: "https://evil.example.com" });
    expect(res.status).toBe(403);
    expect(getSessionUserMock).not.toHaveBeenCalled();
    expect(updateSelfProfileMock).not.toHaveBeenCalled();
  });

  test("401 with no session (origin trusted)", async () => {
    getSessionUserMock.mockResolvedValueOnce(null);
    const res = await callPatch({ displayName: "Nope" });
    expect(res.status).toBe(401);
    expect(updateSelfProfileMock).not.toHaveBeenCalled();
  });

  test("400 on a body with no valid displayName", async () => {
    const res = await callPatch({ role: "ADMIN" });
    expect(res.status).toBe(400);
    expect(updateSelfProfileMock).not.toHaveBeenCalled();
  });

  test("400 on a blank displayName (zod trim().min(1))", async () => {
    const res = await callPatch({ displayName: "   " });
    expect(res.status).toBe(400);
    expect(updateSelfProfileMock).not.toHaveBeenCalled();
  });

  test("400 on invalid JSON", async () => {
    const res = await callPatch(undefined, { raw: "{not json" });
    expect(res.status).toBe(400);
    expect(updateSelfProfileMock).not.toHaveBeenCalled();
  });
});
