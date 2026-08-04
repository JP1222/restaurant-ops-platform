import { describe, expect, it } from "vitest";
import { appsForChangedFiles } from "@/lib/ops/app-paths";

// Pins the drift map to build-images.yml's dorny/paths-filter rules. If the
// workflow filters change, update lib/ops/app-paths.ts and these expectations
// together.
describe("appsForChangedFiles", () => {
  it("maps an app's own files to just that app", () => {
    expect(appsForChangedFiles(["apps/marketing-site/index.html"])).toEqual(["marketing-site"]);
  });

  it("fans a shared package out to exactly its dependents (canonical order)", () => {
    expect(appsForChangedFiles(["packages/contracts/src/index.ts"])).toEqual([
      "kds-api",
      "kds-web",
      "backoffice-web",
      "inventory-api",
      "crm-api",
    ]);
  });

  it("treats the root lockfile as a rebuild of every workspace-dependent app", () => {
    expect(appsForChangedFiles(["pnpm-lock.yaml"])).toEqual([
      "kds-api",
      "kds-web",
      "analytics-api",
      "backoffice-web",
      "inventory-api",
      "crm-api",
    ]);
  });

  it("maps crm-api's own files and its db package to crm-api", () => {
    expect(appsForChangedFiles(["apps/crm-api/src/server.ts"])).toEqual(["crm-api"]);
    expect(appsForChangedFiles(["packages/db-crm/prisma/schema.prisma"])).toEqual(["crm-api"]);
  });

  it("scopes order-web to its own files only (no shared-package fan-out)", () => {
    expect(appsForChangedFiles(["apps/order-web/app/page.tsx"])).toEqual(["order-web"]);
    // order-web has no packages/contracts/** rule, so a contracts change must not pull it in.
    expect(appsForChangedFiles(["packages/contracts/src/index.ts"])).not.toContain("order-web");
  });

  it("scopes docs/legal to legal-site only", () => {
    expect(appsForChangedFiles(["docs/legal/eula.md"])).toEqual(["legal-site"]);
  });

  it("dedupes and returns canonical build order", () => {
    expect(appsForChangedFiles(["apps/kds-web/page.tsx", "apps/kds-api/server.ts"])).toEqual([
      "kds-api",
      "kds-web",
    ]);
  });

  it("ignores files that match no app", () => {
    expect(appsForChangedFiles(["README.md", "docs/decisions/0001.md"])).toEqual([]);
  });
});
