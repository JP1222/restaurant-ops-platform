import { describe, expect, it, vi } from "vitest";
import { provisionTenant } from "../src/lib/provision-tenant.js";

function makeServices(opts: { tenantExists?: boolean; locationCount?: number } = {}) {
  const tenantCreate = vi.fn().mockResolvedValue({ id: "t" });
  const locationCreate = vi.fn().mockResolvedValue({ id: "loc" });
  const ensureTenantMembership = vi.fn().mockResolvedValue({ id: "m" });
  const prisma = {
    tenant: {
      findUnique: vi.fn().mockResolvedValue(opts.tenantExists === false ? null : { id: "t" }),
      create: tenantCreate
    },
    location: {
      count: vi.fn().mockResolvedValue(opts.locationCount ?? 0),
      create: locationCreate
    }
  };
  const auth = { ensureTenantMembership };
  // The saga only touches prisma.tenant/location + auth.ensureTenantMembership;
  // a narrow structural stub is enough (cast to satisfy the Pick<AppServices>).
  return {
    services: { prisma, auth } as unknown as Parameters<typeof provisionTenant>[0],
    tenantCreate,
    locationCreate,
    ensureTenantMembership
  };
}

describe("provisionTenant", () => {
  it("skips tenant create when the tenant already exists (idempotent boot)", async () => {
    const { services, tenantCreate } = makeServices({ tenantExists: true });
    const res = await provisionTenant(services, { id: "tenant-default", name: "Example Kitchen", slug: "restaurant-ops-platform" });
    expect(tenantCreate).not.toHaveBeenCalled();
    expect(res.createdTenant).toBe(false);
  });

  it("creates the tenant when it does not exist", async () => {
    const { services, tenantCreate } = makeServices({ tenantExists: false });
    const res = await provisionTenant(services, { id: "t2", name: "Two", slug: "two" });
    expect(tenantCreate).toHaveBeenCalledWith({ data: { id: "t2", name: "Two", slug: "two" } });
    expect(res.createdTenant).toBe(true);
  });

  it("ensures a membership for each owner and never imports db-auth (goes through the auth service)", async () => {
    const { services, ensureTenantMembership } = makeServices({ tenantExists: true });
    const res = await provisionTenant(services, {
      id: "tenant-default",
      name: "Example Kitchen",
      slug: "restaurant-ops-platform",
      owners: [{ accountId: "a1", role: "OWNER" }, { accountId: "a2" }]
    });
    expect(ensureTenantMembership).toHaveBeenCalledTimes(2);
    expect(ensureTenantMembership).toHaveBeenCalledWith({ accountId: "a1", tenantId: "tenant-default", role: "OWNER" });
    expect(ensureTenantMembership).toHaveBeenCalledWith({ accountId: "a2", tenantId: "tenant-default", role: undefined });
    expect(res.membershipsEnsured).toBe(2);
  });

  it("creates a default location only when the tenant has none", async () => {
    const none = makeServices({ tenantExists: true, locationCount: 0 });
    const r1 = await provisionTenant(none.services, {
      id: "t",
      name: "n",
      slug: "s",
      defaultLocation: { name: "Main", slug: "main" }
    });
    expect(none.locationCreate).toHaveBeenCalledOnce();
    expect(r1.createdLocation).toBe(true);

    const some = makeServices({ tenantExists: true, locationCount: 2 });
    const r2 = await provisionTenant(some.services, {
      id: "t",
      name: "n",
      slug: "s",
      defaultLocation: { name: "Main", slug: "main" }
    });
    expect(some.locationCreate).not.toHaveBeenCalled();
    expect(r2.createdLocation).toBe(false);
  });
});
