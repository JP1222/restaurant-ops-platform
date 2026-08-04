import { describe, expect, it, vi } from "vitest";
import { ensureTenantMembership } from "../../src/server/user.js";

describe("ensureTenantMembership", () => {
  it("upserts on the (accountId, tenantId) unique key, syncing role when given", async () => {
    const upsert = vi.fn().mockResolvedValue({ id: "m1" });
    const prisma = { tenantMembership: { upsert } } as unknown as Parameters<typeof ensureTenantMembership>[0];

    await ensureTenantMembership(prisma, { accountId: "a1", tenantId: "tenant-default", role: "OWNER" });

    expect(upsert).toHaveBeenCalledWith({
      where: { accountId_tenantId: { accountId: "a1", tenantId: "tenant-default" } },
      create: { accountId: "a1", tenantId: "tenant-default", role: "OWNER" },
      update: { role: "OWNER" }
    });
  });

  it("omits role (schema default on create, no-op update) when not provided — idempotent re-run", async () => {
    const upsert = vi.fn().mockResolvedValue({ id: "m1" });
    const prisma = { tenantMembership: { upsert } } as unknown as Parameters<typeof ensureTenantMembership>[0];

    await ensureTenantMembership(prisma, { accountId: "a1", tenantId: "tenant-default" });

    expect(upsert).toHaveBeenCalledWith({
      where: { accountId_tenantId: { accountId: "a1", tenantId: "tenant-default" } },
      create: { accountId: "a1", tenantId: "tenant-default" },
      update: {}
    });
  });
});
