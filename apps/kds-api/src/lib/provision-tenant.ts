import { type WebAdminRole } from "@rop/contracts";
import type { AppServices } from "./services.js";

/**
 * Materialize a tenant as a real row (ADR-0818 / #902 Phase 0). The terminal-state
 * architecture (docs/architecture/multi-tenant-greenfield-target.md) wants even the
 * single implicit tenant to be a provisioned row, never an env-default fallback —
 * `provisionTenant` is the saga that guarantees it.
 *
 * Idempotent: safe to run on every boot. The Tenant + Location writes are db-kds
 * (kds-api owns it); the membership write is db-auth but flows through the auth
 * service (`services.auth.ensureTenantMembership`), so this file never imports
 * `@rop/db-auth` — keeping the saga clean against Iron Law 1 (DB ownership)
 * and Iron Law 3 (auth boundary). The db-kds + db-auth Prisma clients share one
 * physical Postgres (ADR-0015) but stay split at the package boundary.
 */
export interface ProvisionTenantInput {
  /** Stable tenant id. The implicit tenant is the literal `tenant-default` (seeded by the db-kds migration). */
  id: string;
  name: string;
  slug: string;
  /** Memberships to ensure (the owner accounts). Role is kept in sync with the account's role. */
  owners?: Array<{ accountId: string; role?: WebAdminRole }>;
  /**
   * A first store, created ONLY if the tenant has zero locations — so a re-run (or
   * the implicit tenant, which already owns its real stores) never spawns a
   * spurious location.
   */
  defaultLocation?: { name: string; slug: string; timezone?: string };
}

export interface ProvisionTenantResult {
  tenantId: string;
  createdTenant: boolean;
  createdLocation: boolean;
  membershipsEnsured: number;
}

export async function provisionTenant(
  services: Pick<AppServices, "prisma" | "auth">,
  input: ProvisionTenantInput
): Promise<ProvisionTenantResult> {
  const { prisma, auth } = services;

  // 1. Tenant row. create() (not upsert) so a re-run never clobbers a renamed
  //    tenant's name/slug. The migration seeds `tenant-default` before first boot,
  //    so this branch only fires when genuinely onboarding a new tenant.
  const existingTenant = await prisma.tenant.findUnique({
    where: { id: input.id },
    select: { id: true }
  });
  if (!existingTenant) {
    await prisma.tenant.create({
      data: { id: input.id, name: input.name, slug: input.slug }
    });
  }

  // 2. Default location — only when the tenant has none yet.
  let createdLocation = false;
  if (input.defaultLocation) {
    const locationCount = await prisma.location.count({ where: { tenantId: input.id } });
    if (locationCount === 0) {
      await prisma.location.create({
        data: {
          name: input.defaultLocation.name,
          slug: input.defaultLocation.slug,
          timezone: input.defaultLocation.timezone ?? "America/Chicago",
          active: true,
          tenantId: input.id
        }
      });
      createdLocation = true;
    }
  }

  // 3. Owner memberships (db-auth, via the auth service — never imported here).
  let membershipsEnsured = 0;
  for (const owner of input.owners ?? []) {
    await auth.ensureTenantMembership({
      accountId: owner.accountId,
      tenantId: input.id,
      // Spread role only when present — `exactOptionalPropertyTypes` forbids an
      // explicit `role: undefined` against the optional `role?` param.
      ...(owner.role ? { role: owner.role } : {})
    });
    membershipsEnsured += 1;
  }

  return {
    tenantId: input.id,
    createdTenant: !existingTenant,
    createdLocation,
    membershipsEnsured
  };
}
