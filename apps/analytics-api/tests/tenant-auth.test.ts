import type { IncomingMessage } from "node:http";

import { signAnalyticsTenantClaim } from "@rop/contracts/tenant-claim";
import { describe, expect, it, vi } from "vitest";

import type { AppConfig } from "../src/config.js";
import type { DbPool } from "../src/db.js";
import { enforceTenantScope } from "../src/lib/tenant-auth.js";

const KEY = "analytics-tenant-signing-key-test";

function reqWithClaim(token?: string): IncomingMessage {
  return { headers: token ? { "x-tenant-claim": token } : {} } as unknown as IncomingMessage;
}

// A pool whose sync_targets lookup returns the given tenant for any merchant, or
// no rows when `tenant` is undefined (merchant not a sync target).
function poolReturning(tenant: string | null | undefined): DbPool {
  return {
    query: vi.fn(async () => ({ rows: tenant === undefined ? [] : [{ tenant_id: tenant }] }))
  } as unknown as DbPool;
}

function config(mode: "off" | "observe" | "enforce"): AppConfig {
  return { multiTenantMode: mode, tenantSigningKey: KEY } as unknown as AppConfig;
}

// Same but with no signing key configured (misconfiguration case).
function configNoKey(mode: "off" | "observe" | "enforce"): AppConfig {
  return { multiTenantMode: mode, tenantSigningKey: undefined } as unknown as AppConfig;
}

function freshClaim(tenantId: string): string {
  const now = Math.floor(Date.now() / 1000);
  return signAnalyticsTenantClaim(
    { tenantId, merchantIds: ["M1"], iat: now, exp: now + 300 },
    KEY
  );
}

describe("enforceTenantScope", () => {
  it("off mode is a no-op — serves even with no claim", async () => {
    const result = await enforceTenantScope(reqWithClaim(), poolReturning("tenant-A"), config("off"), "M1");
    expect(result).toEqual({ ok: true });
  });

  it("enforce: a valid claim for the merchant's tenant passes", async () => {
    const result = await enforceTenantScope(
      reqWithClaim(freshClaim("tenant-A")),
      poolReturning("tenant-A"),
      config("enforce"),
      "M1"
    );
    expect(result).toEqual({ ok: true });
  });

  it("enforce: a cross-tenant merchant is rejected 403", async () => {
    const result = await enforceTenantScope(
      reqWithClaim(freshClaim("tenant-A")),
      poolReturning("tenant-B"),
      config("enforce"),
      "M1"
    );
    expect(result).toEqual({ ok: false, status: 403, error: "merchant_tenant_mismatch" });
  });

  it("enforce: a merchant not in sync_targets is rejected 403", async () => {
    const result = await enforceTenantScope(
      reqWithClaim(freshClaim("tenant-A")),
      poolReturning(undefined),
      config("enforce"),
      "GHOST"
    );
    expect(result).toEqual({ ok: false, status: 403, error: "merchant_tenant_mismatch" });
  });

  it("enforce: a NULL tenant_id row (pre-loader-stamp) counts as the default tenant", async () => {
    const result = await enforceTenantScope(
      reqWithClaim(freshClaim("tenant-default")),
      poolReturning(null),
      config("enforce"),
      "M1"
    );
    expect(result).toEqual({ ok: true });
  });

  it("enforce: a missing claim is rejected 401", async () => {
    const result = await enforceTenantScope(reqWithClaim(), poolReturning("tenant-A"), config("enforce"), "M1");
    expect(result).toEqual({ ok: false, status: 401, error: "tenant_claim_required" });
  });

  it("enforce: an invalid (wrong-key) claim is rejected 401", async () => {
    const forged = signAnalyticsTenantClaim(
      { tenantId: "tenant-A", merchantIds: ["M1"], iat: 1, exp: 9_999_999_999 },
      "wrong-key"
    );
    const result = await enforceTenantScope(reqWithClaim(forged), poolReturning("tenant-A"), config("enforce"), "M1");
    expect(result).toEqual({ ok: false, status: 401, error: "tenant_claim_invalid" });
  });

  it("enforce: an unconfigured signing key fails closed 503", async () => {
    const result = await enforceTenantScope(
      reqWithClaim(freshClaim("tenant-A")),
      poolReturning("tenant-A"),
      configNoKey("enforce"),
      "M1"
    );
    expect(result).toEqual({ ok: false, status: 503, error: "tenant_claim_unconfigured" });
  });

  it("observe: a cross-tenant request is SERVED (logged, not rejected)", async () => {
    const result = await enforceTenantScope(
      reqWithClaim(freshClaim("tenant-A")),
      poolReturning("tenant-B"),
      config("observe"),
      "M1"
    );
    expect(result).toEqual({ ok: true });
  });
});
