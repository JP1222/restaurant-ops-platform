import { opsBuildApps, type OpsBuildApp } from "@rop/contracts";

// Mirrors the `dorny/paths-filter` `filters:` block in
// .github/workflows/build-images.yml. Given the set of files changed since the
// `last-built` tag, this computes which apps the workflow would rebuild — used
// to drive the status-strip drift count and the Images "stale" badges.
//
// IMPORTANT: keep this in sync with build-images.yml. Drift here = the panel
// shows the wrong apps as needing a redeploy. There is a unit test pinning the
// two together (tests/lib/ops/app-paths.test.ts).

// Root-level files that trigger a rebuild of every workspace-dependent app.
const SHARED_ROOT = [
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "tsconfig.base.json",
  "package.json",
];

const APP_PATH_RULES: Record<OpsBuildApp, readonly string[]> = {
  "kds-api": [
    "apps/kds-api/**",
    "packages/db-kds/**",
    "packages/contracts/**",
    "packages/auth/**",
    "packages/db-auth/**",
    ...SHARED_ROOT,
  ],
  "kds-web": [
    "apps/kds-web/**",
    "packages/contracts/**",
    "packages/auth/**",
    "packages/db-auth/**",
    ...SHARED_ROOT,
  ],
  "analytics-api": ["apps/analytics-api/**", ...SHARED_ROOT],
  "backoffice-web": [
    "apps/backoffice-web/**",
    "packages/auth/**",
    "packages/db-auth/**",
    "packages/db-kds/**",
    "packages/contracts/**",
    ...SHARED_ROOT,
  ],
  "legal-site": ["apps/legal-site/**", "docs/legal/**"],
  "marketing-site": ["apps/marketing-site/**"],
  "crew-web": ["apps/crew-web/**"],
  "inventory-api": [
    "apps/inventory-api/**",
    "packages/db-inventory/**",
    "packages/contracts/**",
    ...SHARED_ROOT,
  ],
  "order-web": ["apps/order-web/**"],
  "crm-api": [
    "apps/crm-api/**",
    "packages/db-crm/**",
    "packages/contracts/**",
    ...SHARED_ROOT,
  ],
};

// The filter rules are either a directory glob (`foo/bar/**`) or an exact
// root-level file (`package.json`). picomatch's `foo/**` matches anything under
// `foo/`; a bare filename matches only that path at the repo root.
function ruleMatches(rule: string, file: string): boolean {
  if (rule.endsWith("/**")) {
    return file.startsWith(rule.slice(0, -2));
  }
  return file === rule;
}

/**
 * Apps that build-images.yml would rebuild for the given changed files,
 * returned in the canonical build order.
 */
export function appsForChangedFiles(files: readonly string[]): OpsBuildApp[] {
  const affected = new Set<OpsBuildApp>();
  for (const app of opsBuildApps) {
    const rules = APP_PATH_RULES[app];
    if (files.some((file) => rules.some((rule) => ruleMatches(rule, file)))) {
      affected.add(app);
    }
  }
  return opsBuildApps.filter((app) => affected.has(app));
}
