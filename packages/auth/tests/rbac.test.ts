import { describe, expect, it } from "vitest";
import { PERMISSION_CATALOG } from "@rop/contracts";
import { ROLE_PERMISSIONS, can, webAdminRoleToRole } from "../src/rbac.js";

describe("rbac can()", () => {
  it("OWNER holds every permission in the catalog", () => {
    for (const permission of PERMISSION_CATALOG) {
      expect(can("OWNER", permission)).toBe(true);
    }
  });

  it("STAFF is operational-only — no analytics/settings/secrets/users", () => {
    expect(can("STAFF", "inventory.waste.record")).toBe(true);
    expect(can("STAFF", "inventory.count.record")).toBe(true);
    expect(can("STAFF", "inventory.item.toggle86")).toBe(true);
    expect(can("STAFF", "inventory.po.receive")).toBe(true);
    expect(can("STAFF", "kds.ticket.act")).toBe(true);

    for (const denied of [
      "analytics.read",
      "settings.read",
      "settings.write",
      "secrets.read",
      "secrets.write",
      "users.manage",
      "integrations.manage",
      "kds.board.configure",
      "devices.manage"
    ] as const) {
      expect(can("STAFF", denied)).toBe(false);
    }
  });

  it("maps WebAdminRole (incl. legacy ADMIN) onto the suite Role", () => {
    expect(webAdminRoleToRole("ADMIN")).toBe("OWNER");
    expect(webAdminRoleToRole("OWNER")).toBe("OWNER");
    expect(webAdminRoleToRole("MANAGER")).toBe("MANAGER");
    expect(webAdminRoleToRole("nonsense")).toBe("STAFF");
  });

  it("every role's grants are valid catalog permissions", () => {
    for (const grants of Object.values(ROLE_PERMISSIONS)) {
      for (const permission of grants) {
        expect(PERMISSION_CATALOG).toContain(permission);
      }
    }
  });
});
