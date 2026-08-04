import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Server-side BFF route handlers — no DOM needed (unlike backoffice-web,
    // which tests components and uses happy-dom). Node 18+ supplies the global
    // Request/Response/fetch the route handlers and these tests rely on.
    environment: "node",
    globals: false,
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
    },
  },
});
