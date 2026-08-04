import { beforeEach, describe, expect, test, vi } from "vitest";

// Hoisted state the mocks read at call time (mirrors location-scope.test.ts).
const cookieHolder = vi.hoisted(() => ({ value: null as string | null }));
const envHolder = vi.hoisted(() => ({ key: undefined as string | undefined }));
const sessionHolder = vi.hoisted(() => ({ tenantId: null as string | null }));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: () => (cookieHolder.value === null ? undefined : { value: cookieHolder.value }),
  }),
}));

vi.mock("@/lib/auth/config", () => ({
  getBackofficeSessionCookieName: () => "rop_backoffice_session",
}));

vi.mock("@/lib/auth/service", () => ({
  getBackofficeAuthService: () => ({
    readSession: async () =>
      sessionHolder.tenantId === null ? null : { tenantId: sessionHolder.tenantId },
  }),
}));

vi.mock("@/lib/env", () => ({
  getServerEnv: () => ({ ANALYTICS_TENANT_SIGNING_KEY: envHolder.key }),
}));

import { verifyAnalyticsTenantClaim } from "@rop/contracts/tenant-claim";

import { mintAnalyticsTenantClaim } from "@/lib/analytics-api/tenant-claim";

const KEY = "shared-analytics-tenant-key";

beforeEach(() => {
  cookieHolder.value = null;
  envHolder.key = undefined;
  sessionHolder.tenantId = null;
});

describe("mintAnalyticsTenantClaim", () => {
  test("returns null when the signing key is unset (dormant default — no session read)", async () => {
    cookieHolder.value = "sid";
    sessionHolder.tenantId = "tenant-A";
    expect(await mintAnalyticsTenantClaim("M1")).toBeNull();
  });

  test("returns null when there is no session cookie", async () => {
    envHolder.key = KEY;
    cookieHolder.value = null;
    expect(await mintAnalyticsTenantClaim("M1")).toBeNull();
  });

  test("returns null when the session carries no tenant", async () => {
    envHolder.key = KEY;
    cookieHolder.value = "sid";
    sessionHolder.tenantId = null;
    expect(await mintAnalyticsTenantClaim("M1")).toBeNull();
  });

  test("signs a verifiable claim carrying the session's tenant + the requested merchant", async () => {
    envHolder.key = KEY;
    cookieHolder.value = "sid";
    sessionHolder.tenantId = "tenant-A";

    const token = await mintAnalyticsTenantClaim("M1");
    expect(token).not.toBeNull();

    const claim = verifyAnalyticsTenantClaim(token as string, KEY, Math.floor(Date.now() / 1000));
    expect(claim?.tenantId).toBe("tenant-A");
    expect(claim?.merchantIds).toEqual(["M1"]);
    // A claim signed with this key must NOT verify under a different key.
    expect(verifyAnalyticsTenantClaim(token as string, "other-key", Math.floor(Date.now() / 1000))).toBeNull();
  });

  test("default-store path (no merchantId) signs an empty merchantIds list", async () => {
    envHolder.key = KEY;
    cookieHolder.value = "sid";
    sessionHolder.tenantId = "tenant-default";

    const token = await mintAnalyticsTenantClaim(undefined);
    const claim = verifyAnalyticsTenantClaim(token as string, KEY, Math.floor(Date.now() / 1000));
    expect(claim?.merchantIds).toEqual([]);
  });
});
