// Central, storage-agnostic authorization (ADR-0029).
//
// Pure + db-free on purpose: this file imports only the permission vocabulary
// from @rop/contracts, so it can be pulled by every surface (kds-api,
// backoffice BFF, inventory-api crew routes, crew-web) via the
// `@rop/auth/rbac` subpath WITHOUT dragging in db-auth / db-kds — the
// same decoupling trick as `@rop/auth/crew`. Do NOT add DB, Redis, or
// argon2 imports here.
import { PERMISSION_CATALOG, type Permission, type Role } from "@rop/contracts";

// Operational floor permissions — the STAFF boundary (KDS shared-board acts +
// crew inventory tasks). Staff must NOT hold analytics / settings / secrets /
// users / integrations / devices.
const OPERATIONAL: readonly Permission[] = [
  "inventory.waste.record",
  "inventory.count.record",
  "inventory.item.toggle86",
  "inventory.po.receive",
  "kds.ticket.act"
];

// Role -> granted permissions. OWNER holds the whole catalog. MANAGER is
// reserved (not issued until a later phase) and currently sits between STAFF
// and OWNER. This map is the single source of authorization truth.
export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  OWNER: PERMISSION_CATALOG,
  STAFF: OPERATIONAL,
  MANAGER: [...OPERATIONAL, "analytics.read", "inventory.manage"]
};

// The one authoritative permission check for the whole suite.
export function can(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

// db-auth accounts carry a WebAdminRole ("OWNER" | "MANAGER" | legacy "ADMIN").
// Map it onto the suite-wide Role for can(). Legacy ADMIN == OWNER until the
// enum-cleanup migration drops it (ADR-0029). Unknown strings fail closed to
// the most-restrictive issued role, STAFF.
export function webAdminRoleToRole(webAdminRole: string): Role {
  switch (webAdminRole) {
    case "OWNER":
    case "ADMIN":
      return "OWNER";
    case "MANAGER":
      return "MANAGER";
    default:
      return "STAFF";
  }
}
