import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import {
  restrictedImports,
  restrictedImportsForDbAuthCarveOut,
  dbKdsPattern,
  DB_KDS_BACKOFFICE
} from "../../eslint.boundaries.mjs";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
  // Iron Law #1/#5 (see docs/decisions/0012): backoffice must not import the KDS DB client...
  {
    rules: { "no-restricted-imports": restrictedImports([], [dbKdsPattern(DB_KDS_BACKOFFICE)]) },
  },
  // ...except the documented carve-outs. db-kds is allowed for the AI assistant
  // (ADR-0011 bounded exception), the runtime config store (ADR-0016 extends
  // the same exception to AppSetting), the Location registry (ADR-0018
  // multi-location), and next.config bundler hints.
  {
    files: [
      "lib/ai/**/*.{ts,tsx}",
      "lib/settings/**/*.{ts,tsx}",
      "lib/location/**/*.{ts,tsx}",
      "next.config.ts"
    ],
    rules: { "no-restricted-imports": restrictedImports() },
  },
  // db-auth carve-out (ADR-0015): the backoffice auth service factory is the
  // BFF wiring point. db-kds stays banned here; db-auth is allowed.
  {
    files: ["lib/auth/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": restrictedImportsForDbAuthCarveOut(
        [],
        [dbKdsPattern(DB_KDS_BACKOFFICE)]
      ),
    },
  },
]);

export default eslintConfig;
