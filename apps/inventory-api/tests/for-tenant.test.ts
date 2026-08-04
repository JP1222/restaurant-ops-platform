import { describe, expect, it, vi } from "vitest";
import { forTenant } from "../src/lib/for-tenant.js";

function fakePrisma() {
  const executeRaw = vi.fn().mockResolvedValue(1);
  const prisma = {
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn({ $executeRaw: executeRaw }))
  };
  return { prisma: prisma as unknown as Parameters<typeof forTenant>[0], executeRaw };
}

describe("forTenant", () => {
  it("throws (fail-closed) on an empty / blank / missing tenantId", () => {
    const { prisma } = fakePrisma();
    expect(() => forTenant(prisma, "")).toThrow(/non-empty tenantId/);
    expect(() => forTenant(prisma, "   ")).toThrow(/non-empty tenantId/);
    // @ts-expect-error — undefined is rejected at runtime too (defends against a lost claim)
    expect(() => forTenant(prisma, undefined)).toThrow();
  });

  it("opens a transaction, SET LOCALs app.tenant_id as a bound param, runs the callback on the tx", async () => {
    const { prisma, executeRaw } = fakePrisma();

    const result = await forTenant(prisma, "tenant-default").run(async (tx) => {
      expect(tx).toBeDefined();
      return "ok";
    });

    expect(prisma.$transaction).toHaveBeenCalledOnce();
    expect(executeRaw).toHaveBeenCalledOnce();
    // Tagged-template call shape: [stringsArray, ...boundParams]. The tenant id is
    // the single bound parameter — never interpolated into the SQL text.
    const [strings, boundTenantId] = executeRaw.mock.calls[0] as [readonly string[], string];
    expect(strings.join("?")).toContain("set_config('app.tenant_id'");
    expect(boundTenantId).toBe("tenant-default");
    expect(result).toBe("ok");
  });

  it("trims surrounding whitespace before binding", async () => {
    const { prisma, executeRaw } = fakePrisma();
    await forTenant(prisma, "  tenant-default  ").run(async () => undefined);
    const [, boundTenantId] = executeRaw.mock.calls[0] as [readonly string[], string];
    expect(boundTenantId).toBe("tenant-default");
  });
});
