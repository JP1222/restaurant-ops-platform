import path from "node:path";
import { withSentryConfig } from "@sentry/nextjs";
import type { NextConfig } from "next";
import { yrSrcConfig } from "../../config/yr-src-map.mjs";

function trimTrailingSlash(value: string | undefined) {
  return value?.replace(/\/$/, "") ?? "";
}

const internalApiBaseUrl = trimTrailingSlash(process.env.INTERNAL_API_BASE_URL);

export function buildRewrites(apiBaseUrl: string) {
  if (!apiBaseUrl) {
    return [];
  }

  return [
    {
      source: "/ws",
      destination: `${apiBaseUrl}/ws`
    },
    {
      source: "/ws/:path*",
      destination: `${apiBaseUrl}/ws/:path*`
    },
    {
      source: "/api/:path*",
      destination: `${apiBaseUrl}/api/:path*`
    }
  ];
}

// outputFileTracingRoot pins the standalone-build file-trace root at the
// monorepo root so workspace deps (@rop/contracts, @rop/auth)
// are correctly included in the runtime trace.
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
  // build. kds-web gained a `typecheck` script so turbo's typecheck task now
  // covers it. (Next 16 dropped build-time ESLint, so there's no eslint flag.)
  typescript: { ignoreBuildErrors: true },
  outputFileTracingRoot: path.join(__dirname, "../.."),
  async rewrites() {
    return buildRewrites(internalApiBaseUrl);
  },
  transpilePackages: yr.packages,
  turbopack: { resolveAlias: yr.aliases }
};

export default withSentryConfig(nextConfig, {
  org: process.env.SENTRY_ORG,
  project: "kds-web",
  authToken: process.env.SENTRY_AUTH_TOKEN,
  silent: !process.env.CI,
  sourcemaps: { disable: !process.env.SENTRY_AUTH_TOKEN },
  release: { name: process.env.SENTRY_RELEASE },
});
