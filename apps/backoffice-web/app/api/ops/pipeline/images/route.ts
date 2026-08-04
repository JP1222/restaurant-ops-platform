import { opsBuildApps, type OpsBuildApp } from "@rop/contracts";
import { NextResponse, type NextRequest } from "next/server";
import { requireSession } from "@/lib/auth/require-session";
import { getServerEnv } from "@/lib/env";
import { githubApi, GithubApiError, type PackageVersion } from "@/lib/github";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// All 8 deployable apps (shared with the Operations panel). Broadened from the
// original 4 so both the System Health pipeline tab and the Operations Images
// card cover the full GHCR set.
const APPS = opsBuildApps;

type AppName = OpsBuildApp;

interface ImageInfo {
  app: AppName;
  packageName: string;
  mainTag: PackageVersion | null;
  latestVersions: PackageVersion[];
  error: string | null;
}

export async function GET(request: NextRequest) {
  const unauth = await requireSession(request);
  if (unauth) return unauth;
  const env = getServerEnv();
  if (!env.GITHUB_PIPELINE_TOKEN) {
    return NextResponse.json(
      {
        error: "missing_github_token",
        message:
          "Set GITHUB_PIPELINE_TOKEN in the backoffice env to enable GHCR image freshness (PAT scope: read:packages).",
      },
      { status: 503 },
    );
  }
  const results = await Promise.all(
    APPS.map(async (app): Promise<ImageInfo> => {
      const pkg = `rop-${app}`;
      try {
        const versions = await githubApi.listPackageVersions(pkg, { perPage: 10 });
        const sorted = [...versions].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
        const main = sorted.find((v) => v.tags.includes("main")) ?? null;
        return { app, packageName: pkg, mainTag: main, latestVersions: sorted.slice(0, 5), error: null };
      } catch (error) {
        const msg =
          error instanceof GithubApiError
            ? `github_${error.status}`
            : error instanceof Error
              ? error.message.slice(0, 100)
              : "unknown";
        return { app, packageName: pkg, mainTag: null, latestVersions: [], error: msg };
      }
    }),
  );
  return NextResponse.json({ images: results });
}
