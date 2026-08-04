import { describe, expect, it } from "vitest";

import {
  AnalyticsTenantClaimSchema,
  DEFAULT_TENANT_ID,
  TenantMembershipSchema,
  TenantSchema,
  TenantScopeSchema,
  TenantSessionClaimSchema,
  TenantStatusSchema
} from "./tenant.js";

describe("tenant contracts", () => {
  it("parses the Tenant entity (mirrors the seeded default tenant)", () => {
    const t = TenantSchema.parse({
      id: DEFAULT_TENANT_ID,
      name: "Example Kitchen",
      slug: "restaurant-ops-platform",
      status: "ACTIVE"
    });
    expect(t.slug).toBe("restaurant-ops-platform");
    expect(t.status).toBe("ACTIVE");
  });

  it("rejects an unknown status (enum kept in sync with db-kds)", () => {
    expect(() =>
      TenantSchema.parse({ id: "x", name: "x", slug: "x", status: "BOGUS" })
    ).toThrow();
    expect(TenantStatusSchema.options).toEqual(["ACTIVE", "SUSPENDED", "OFFBOARDING", "ARCHIVED"]);
  });

  it("a TenantScope requires a tenantId; empty locationIds = all locations in the tenant", () => {
    const groupLevel = TenantScopeSchema.parse({ tenantId: DEFAULT_TENANT_ID, locationIds: [] });
    expect(groupLevel.locationIds).toEqual([]);

    const scoped = TenantScopeSchema.parse({ tenantId: DEFAULT_TENANT_ID, locationIds: ["loc-1"] });
    expect(scoped.locationIds).toEqual(["loc-1"]);

    // The hard wall must be present — an empty tenantId is not a valid scope.
    expect(() => TenantScopeSchema.parse({ tenantId: "", locationIds: [] })).toThrow();
  });

  it("a TenantMembership mirrors the db-auth model and reuses the WebAdminRole vocabulary", () => {
    const m = TenantMembershipSchema.parse({
      id: "mem-1",
      accountId: "acc-1",
      tenantId: DEFAULT_TENANT_ID,
      role: "OWNER"
    });
    expect(m.role).toBe("OWNER");
    // Role vocabulary is the db-auth account role (OWNER/MANAGER/ADMIN), not STAFF.
    expect(() =>
      TenantMembershipSchema.parse({ id: "m", accountId: "a", tenantId: "t", role: "STAFF" })
    ).toThrow();
  });

  it("a TenantSessionClaim composes TenantScope (one definition of the hard wall)", () => {
    const claim = TenantSessionClaimSchema.parse({
      accountId: "acc-1",
      role: "MANAGER",
      scope: { tenantId: DEFAULT_TENANT_ID, locationIds: [] }
    });
    expect(claim.scope.tenantId).toBe(DEFAULT_TENANT_ID);
    // A malformed scope (empty tenantId) cannot parse into a claim → fails closed.
    expect(() =>
      TenantSessionClaimSchema.parse({
        accountId: "acc-1",
        role: "OWNER",
        scope: { tenantId: "", locationIds: [] }
      })
    ).toThrow();
  });

  it("an AnalyticsTenantClaim carries an explicit merchantIds set to intersect against", () => {
    const claim = AnalyticsTenantClaimSchema.parse({
      tenantId: DEFAULT_TENANT_ID,
      merchantIds: ["MERCH_A", "MERCH_B"],
      iat: 1_700_000_000,
      exp: 1_700_000_900
    });
    expect(claim.merchantIds).toHaveLength(2);
    // merchantIds is required — an absent set would re-open the ?merchant_id= hole.
    expect(() =>
      AnalyticsTenantClaimSchema.parse({ tenantId: "t", iat: 1, exp: 2 })
    ).toThrow();
  });
});
