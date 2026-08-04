import path from "node:path";
import { withSentryConfig } from "@sentry/nextjs";
import type { NextConfig } from "next";
import { yrSrcConfig } from "../../config/yr-src-map.mjs";

// Dev-only (YR_SRC=1): resolve @rop/* to TS source so a shared-package
// edit can't leave us reading stale dist; {} in build/test/prod. See
// config/yr-src-map.mjs.
const yr = yrSrcConfig(__dirname);

const nextConfig: NextConfig = {
  output: "standalone",
  // Build speed (#894): skip the in-build TypeScript type-check — `pnpm
  // typecheck` (turbo) is the authoritative PR gate, so re-checking inside
  // `next build` is wasted work on every local build and every deploy image
  // build. (Next 16 dropped build-time ESLint, so there's no eslint flag.)
  typescript: { ignoreBuildErrors: true },
  outputFileTracingRoot: path.join(__dirname, "../.."),
  transpilePackages: yr.packages,
  turbopack: { resolveAlias: yr.aliases },
};

// Sentry build-time wrapper (mirrors the other Next apps). Inert at runtime
// without NEXT_PUBLIC_SENTRY_DSN / SENTRY_DSN; source-map upload is skipped
// unless SENTRY_AUTH_TOKEN is set, so a normal `next build` needs no secrets.
export default withSentryConfig(nextConfig, {
  org: process.env.SENTRY_ORG,
  project: "order-web",
  authToken: process.env.SENTRY_AUTH_TOKEN,
  silent: !process.env.CI,
  sourcemaps: { disable: !process.env.SENTRY_AUTH_TOKEN },
  release: { name: process.env.SENTRY_RELEASE },
});
