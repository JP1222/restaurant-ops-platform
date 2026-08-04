import path from "node:path";
import { withSentryConfig } from "@sentry/nextjs";
import type { NextConfig } from "next";
import { yrSrcConfig } from "../../config/yr-src-map.mjs";

// Next.js 16 defaults to Turbopack for both `next dev` and `next build`.
// PR #43 dropped --webpack from package.json scripts so Turbopack is the
// default bundler. Turbopack reads serverExternalPackages below and handles
// TypeScript-source resolution natively, so it does NOT use the webpack()
// hook at the bottom of this file.
//
// **However**: playwright.config.ts still invokes `next dev --webpack` for
// E2E (Turbopack + Playwright dev-server integration is rough as of Next 16.2
// — see https://github.com/vercel/next.js/issues for the open issues). The
// E2E job in ci.yml therefore runs webpack mode. Webpack needs the externals
// push for @node-rs/argon2 (native .node binary that webpack cannot parse)
// and the .js→.ts extensionAlias. We keep the hook here so webpack-mode
// (E2E + any future --webpack opt-in) still works. Turbopack ignores it.
//
// outputFileTracingRoot pins the standalone-build file-trace root at the
// monorepo root so workspace deps trace correctly.
// Dev-only (YR_SRC=1): resolve @rop/* to TS source so a shared-package
// edit can't leave us reading stale dist; {} in build/test/prod. See
// config/yr-src-map.mjs.
const yr = yrSrcConfig(__dirname);

const nextConfig: NextConfig = {
  allowedDevOrigins: ["127.0.0.1"],
  output: "standalone",
  // Build speed (#894): skip the in-build TypeScript type-check — `pnpm
  // typecheck` (turbo) is the authoritative PR gate, so re-checking inside
  // `next build` is wasted work on every local build and every deploy image
  // build. (Next 16 dropped build-time ESLint, so there's no eslint flag.)
  typescript: { ignoreBuildErrors: true },
  outputFileTracingRoot: path.join(__dirname, "../.."),
  // Native + serverExternalPackages need explicit inclusion: Next.js' nft
  // (node-file-trace) cannot statically analyze imports through
  // serverExternalPackages, and pnpm's `.pnpm/<pkg>@<ver>/node_modules/<pkg>`
  // structure routinely fools heuristic discovery. Without these globs,
  // server.js at runtime fails with "Cannot find module @node-rs/argon2"
  // (and similar) and the image rolls back as unhealthy. The Dockerfile
  // previously compensated by copying the entire pnpm-deploy node_modules
  // (~1.2GB) on top of standalone — these globs let us delete that copy.
  outputFileTracingIncludes: {
    "/**": [
      "./node_modules/.pnpm/@node-rs+argon2*/node_modules/**/*",
      "./node_modules/.pnpm/@prisma+client*/node_modules/**/*",
      "./node_modules/.pnpm/ioredis*/node_modules/**/*",
      "./node_modules/.pnpm/prisma*/node_modules/**/*",
      // The AI chat route reads its base system prompt from this markdown file
      // at runtime (issue #226). Turbopack does not trace the
      // `readFileSync` asset, so pin it explicitly or the route 500s with
      // ENOENT under the standalone server. `lib/settings`-style runtime read.
      "./lib/ai/prompts/system.md",
    ],
  },
  serverExternalPackages: ["@node-rs/argon2", "@prisma/client", "ioredis"],
  transpilePackages: yr.packages,
  // resolveAlias is {} unless the dev script sets YR_SRC=1 — so build/prod
  // resolve dist, and dev re-points @rop/* to TS source. A non-empty
  // turbopack block also satisfies Next 16's turbopack+webpack-coexist rule
  // (it errors if both are configured without an explicit turbopack key).
  turbopack: { resolveAlias: yr.aliases },
  webpack(config) {
    config.externals.push({
      "@node-rs/argon2": "commonjs @node-rs/argon2",
      "@node-rs/argon2-darwin-arm64": "commonjs @node-rs/argon2-darwin-arm64"
    });
    config.resolve.extensionAlias = {
      ...config.resolve.extensionAlias,
      ".js": [".ts", ".tsx", ".js"],
      ".mjs": [".mts", ".mjs"]
    };
    // E2E runs `next dev --webpack`; if it sets YR_SRC=1, mirror the dev-only
    // src resolution here. Webpack supports custom conditions natively (Turbopack
    // does not — vercel/next.js#78912), and the .js->.ts extensionAlias above
    // lets it load the resolved TS source.
    if (process.env.YR_SRC === "1") {
      config.resolve.conditionNames = [
        "yr-src",
        ...(config.resolve.conditionNames ?? ["import", "node", "default"])
      ];
    }
    return config;
  }
};

export default withSentryConfig(nextConfig, {
  org: process.env.SENTRY_ORG,
  project: "backoffice-web",
  authToken: process.env.SENTRY_AUTH_TOKEN,
  silent: !process.env.CI,
  sourcemaps: { disable: !process.env.SENTRY_AUTH_TOKEN },
  release: { name: process.env.SENTRY_RELEASE },
});
