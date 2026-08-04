import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import { restrictedImports, dbKdsPattern, DB_KDS_CREWWEB } from "../../eslint.boundaries.mjs";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  globalIgnores([".next/**", "out/**", "build/**", "next-env.d.ts"]),
  // Iron Law #1/#4 (see docs/decisions/0012): crew-web is a Floor prototype — no KDS DB client.
  {
    rules: { "no-restricted-imports": restrictedImports([], [dbKdsPattern(DB_KDS_CREWWEB)]) },
  },
]);

export default eslintConfig;
