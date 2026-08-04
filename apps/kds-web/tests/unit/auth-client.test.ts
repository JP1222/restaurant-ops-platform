import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@simplewebauthn/browser", () => ({
  browserSupportsWebAuthn: vi.fn(() => true),
  startAuthentication: vi.fn(),
  startRegistration: vi.fn()
}));

import { deletePasskeyCredential } from "@/lib/auth-client";

function jsonResponse(payload: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: {
      "content-type": "application/json"
    },
    ...init
  });
}

describe("auth request helpers", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("deletes passkeys without forcing an empty JSON body header", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    await deletePasskeyCredential("credential-1");

    const [, requestInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(new Headers(requestInit.headers).get("content-type")).toBeNull();
  });
});
