import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import { restrictedImports, dbKdsPattern, DB_KDS_ORDERWEB } from "../../eslint.boundaries.mjs";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  globalIgnores([".next/**", "out/**", "build/**", "next-env.d.ts"]),
  // Iron Law #1/#4 (see docs/decisions/0012): order-web is a customer ordering
  // frontend — no KDS DB client; it talks to the ordering API over HTTP.
  {
    rules: { "no-restricted-imports": restrictedImports([], [dbKdsPattern(DB_KDS_ORDERWEB)]) },
  },
]);

export default eslintConfig;
