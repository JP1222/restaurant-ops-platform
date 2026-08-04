import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import { restrictedImports, dbKdsPattern, DB_KDS_ANALYTICS } from "../../eslint.boundaries.mjs";

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: ["dist/**", "coverage/**", "node_modules/**"]
  },
  {
    languageOptions: {
      globals: {
        ...globals.node
      }
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      // Iron Law #1/#5 (see docs/decisions/0012): analytics-api owns its own DB.
      "no-restricted-imports": restrictedImports([], [dbKdsPattern(DB_KDS_ANALYTICS)])
    }
  }
);

