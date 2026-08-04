import { beforeEach, describe, expect, it, vi } from "vitest";

// Stub the underlying default resolver so we test ONLY resolveKdsMerchantId's
// precedence/authorization logic, not the DB lookup. The mock mirrors the real
// resolver's contract: a truthy `requested` returns verbatim, otherwise the
// provider default.
const resolveDefaultMock = vi.hoisted(() => vi.fn());

vi.mock("../src/lib/clover-runtime.js", () => ({
  resolveDefaultCloverMerchantId: resolveDefaultMock
}));

import { resolveKdsMerchantId } from "../src/lib/kds-auth.js";

const services = { prisma: {}, config: {} } as never;

beforeEach(() => {
  resolveDefaultMock.mockReset();
  resolveDefaultMock.mockImplementation(
    async (_prisma: unknown, _config: unknown, requested: string | undefined) => requested ?? "DEFAULT-STORE"
  );
});

describe("resolveKdsMerchantId — device store binding (Phase 5)", () => {
  it("a device with no requested store resolves to its bound store", async () => {
    const result = await resolveKdsMerchantId(services, { type: "device", merchantId: "store-2" }, undefined);
    expect(result).toBe("store-2");
    // The device's merchant is fed in as the `requested` fallback.
    expect(resolveDefaultMock).toHaveBeenCalledWith({}, {}, "store-2");
  });

  it("an explicit ?merchantId= passes through for a device (ensureDeviceMerchantAccess then enforces the claim)", async () => {
    const result = await resolveKdsMerchantId(services, { type: "device", merchantId: "store-2" }, "store-3");
    // resolveKdsMerchantId itself does not reject — it forwards the requested
    // store; app.ts then calls ensureDeviceMerchantAccess which 403s store-3
    // because the token is bound to store-2. (Covered in kds-auth-access below.)
    expect(result).toBe("store-3");
  });
});

// SECURITY REGRESSION GUARD (audit-2026-06-03 #470/#471/#472/#473).
//
// A web session is just { accountId } — it carries NO merchant scope. The
// IDOR was that resolveKdsMerchantId echoed the client-supplied ?merchantId=
// for sessions, so the per-request store (the ownership boundary) became
// attacker-chosen. These tests pin the contract: a SESSION must resolve to its
// authorized (default) merchant and the client `requested` value must be
// ignored — i.e. resolveDefaultCloverMerchantId is always called with
// `undefined` for a session, never the requested store.
describe("resolveKdsMerchantId — a session is pinned to its authorized merchant, NOT the query param", () => {
  it("a session with no requested store resolves to the default", async () => {
    const result = await resolveKdsMerchantId(services, { type: "session" }, undefined);
    expect(result).toBe("DEFAULT-STORE");
    expect(resolveDefaultMock).toHaveBeenCalledWith({}, {}, undefined);
  });

  it("a session passing ?merchantId=<victim> still resolves to its OWN authorized merchant (the IDOR fix)", async () => {
    // With the vulnerable code this returned "victim-merchant"; it must now be
    // the account's authorized store regardless of what the client asked for.
    const result = await resolveKdsMerchantId(services, { type: "session" }, "victim-merchant");
    expect(result).toBe("DEFAULT-STORE");
    expect(result).not.toBe("victim-merchant");
    // The client-supplied store must never reach the resolver.
    expect(resolveDefaultMock).toHaveBeenCalledWith({}, {}, undefined);
    expect(resolveDefaultMock).not.toHaveBeenCalledWith({}, {}, "victim-merchant");
  });
});

// Multi-tenant Phase 2c (ADR-0818). When `config.multiTenantMode` != "off", the
// session resolution becomes tenant-validated: a requested store is HONORED but
// must belong to the session's tenant. legacy default = "DEFAULT-STORE".
function tenantServices(
  mode: "off" | "observe" | "enforce",
  merchantTenants: Record<string, string | null>
) {
  return {
    prisma: {
      cloverMerchant: {
        findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
          where.id in merchantTenants ? { tenantId: merchantTenants[where.id] } : null
        )
      }
    },
    config: { multiTenantMode: mode }
  } as never;
}

describe("resolveKdsMerchantId — tenant-scoped (Phase 2c)", () => {
  it("enforce: a session honors a requested store WITHIN its tenant (store switcher)", async () => {
    const services = tenantServices("enforce", { "store-2": "tenant-A" });
    const result = await resolveKdsMerchantId(services, { type: "session", tenantId: "tenant-A" }, "store-2");
    expect(result).toBe("store-2");
  });

  it("enforce: a session requesting a CROSS-TENANT store fails closed (null)", async () => {
    const services = tenantServices("enforce", { "victim-store": "tenant-B" });
    const result = await resolveKdsMerchantId(services, { type: "session", tenantId: "tenant-A" }, "victim-store");
    expect(result).toBeNull();
  });

  it("enforce: a session with no requested store resolves the in-tenant default (parity)", async () => {
    const services = tenantServices("enforce", { "DEFAULT-STORE": "tenant-A" });
    const result = await resolveKdsMerchantId(services, { type: "session", tenantId: "tenant-A" }, undefined);
    expect(result).toBe("DEFAULT-STORE");
  });

  it("enforce: a principal with NO tenant claim fails closed (null)", async () => {
    const services = tenantServices("enforce", { "DEFAULT-STORE": "tenant-A" });
    const result = await resolveKdsMerchantId(services, { type: "session" }, undefined);
    expect(result).toBeNull();
  });

  it("enforce: an unknown merchant fails closed (null)", async () => {
    const services = tenantServices("enforce", {}); // findUnique → null
    const result = await resolveKdsMerchantId(services, { type: "session", tenantId: "tenant-A" }, "ghost");
    expect(result).toBeNull();
  });

  it("enforce: a null merchant.tenantId (pre-backfill row) is treated as the default tenant", async () => {
    const services = tenantServices("enforce", { "store-x": null });
    const result = await resolveKdsMerchantId(
      services,
      { type: "session", tenantId: "tenant-default" },
      "store-x"
    );
    expect(result).toBe("store-x");
  });

  it("observe: returns LEGACY even when the tenant-scoped value diverges, and logs the divergence", async () => {
    const services = tenantServices("observe", { "victim-store": "tenant-B" });
    const log = { warn: vi.fn() };
    const result = await resolveKdsMerchantId(
      services,
      { type: "session", tenantId: "tenant-A" },
      "victim-store",
      log
    );
    // Dual-read: observe never changes behavior — legacy ("DEFAULT-STORE") wins…
    expect(result).toBe("DEFAULT-STORE");
    // …but the divergence (legacy DEFAULT-STORE vs scoped null) is logged.
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ scope: "kds.tenant.parity", legacyMerchantId: "DEFAULT-STORE", scopedMerchantId: null }),
      expect.any(String)
    );
  });

  it("enforce: a device validates its bound store against the token's tenant", async () => {
    const services = tenantServices("enforce", { "store-2": "tenant-A" });
    const result = await resolveKdsMerchantId(
      services,
      { type: "device", merchantId: "store-2", tenantId: "tenant-A" },
      undefined
    );
    expect(result).toBe("store-2");
  });
});
