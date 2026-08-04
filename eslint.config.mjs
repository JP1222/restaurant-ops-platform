import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import {
  restrictedImports,
  restrictedImportsForDbAuthCarveOut,
  restrictedImportsForDbCrmCarveOut,
  restrictedImportsForDbNotificationsCarveOut,
  dbKdsPattern,
  DB_KDS_KDSWEB
} from "./eslint.boundaries.mjs";

// Iron Law boundary enforcement (see docs/decisions/0012). This root config governs
// only the packages WITHOUT their own eslint.config.* — kds-api, kds-web, packages/*,
// and the static sites. analytics-api / backoffice-web / crew-web carry the same rules
// in their own configs (ESLint resolves the nearest config per file). Shared rule
// builders live in ./eslint.boundaries.mjs so the boundaries stay in one place.

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/.next/**",
      "**/coverage/**",
      "**/playwright-report/**",
      "**/test-results/**",
      "node_modules/**"
    ]
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname
      },
      globals: {
        ...globals.node,
        ...globals.browser
      }
    },
    rules: {
      "@typescript-eslint/no-misused-promises": ["error", { "checksVoidReturn": false }],
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-base-to-string": "off",
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unnecessary-type-assertion": "off",
      "@typescript-eslint/require-await": "off",
      // Baseline: argon2 (Law 3) and @rop/db-auth (Law 3 via ADR-0015) are
      // banned everywhere by default. Specific carve-outs unblock them below.
      "no-restricted-imports": restrictedImports()
    }
  },
  // Iron Law #1/#4 — kds-web (Floor) must not import the KDS database client.
  {
    files: ["apps/kds-web/**/*.{ts,tsx}"],
    rules: { "no-restricted-imports": restrictedImports([], [dbKdsPattern(DB_KDS_KDSWEB)]) }
  },
  // db-auth carve-out (ADR-0015): the kds-api auth surface — service factory,
  // user-admin domain service, and the auth route handlers — may import
  // @rop/db-auth directly. Argon2 stays banned (centralized in
  // packages/auth). Anywhere else in kds-api: db-auth is off-limits.
  {
    files: [
      "apps/kds-api/src/lib/services.ts",
      "apps/kds-api/src/lib/admin-user-service.ts",
      "apps/kds-api/src/routes/auth.ts"
    ],
    rules: { "no-restricted-imports": restrictedImportsForDbAuthCarveOut() }
  },
  // crm-api carve-out (ADR-0021): the loyalty/CRM service is the ONLY app that
  // may import @rop/db-crm. argon2 + db-auth stay banned.
  {
    files: ["apps/crm-api/**/*.ts"],
    rules: { "no-restricted-imports": restrictedImportsForDbCrmCarveOut() }
  },
  // notifications-api carve-out (ADR-0801): the ONLY app that may import
  // @rop/db-notifications. argon2 + db-auth + db-crm stay banned.
  {
    files: ["apps/notifications-api/**/*.ts"],
    rules: { "no-restricted-imports": restrictedImportsForDbNotificationsCarveOut() }
  },
  // packages/auth is the ONLY place that may import the password-hashing primitive,
  // and (per ADR-0015) one of the carve-outs that may import @rop/db-auth.
  {
    files: ["packages/auth/**/*.ts"],
    rules: { "no-restricted-imports": "off" }
  }
);
