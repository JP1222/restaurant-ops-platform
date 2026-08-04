import { NextResponse, type NextRequest } from "next/server";
import type { OpsFreshnessResponse } from "@rop/contracts";
import { requireSession } from "@/lib/auth/require-session";
import { DEFAULT_DEPLOY_REF, GithubApiError, githubApi } from "@/lib/github";
import { appsForChangedFiles } from "@/lib/ops/app-paths";
import { githubErrorResponse, requireGithubToken } from "@/lib/ops/route-helpers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Drives the status strip + Images drift badges. Resolves the last-built marker
// SHA from the `deploy-state` branch, diffs it against HEAD of main (the same
// base the workflow's paths-filter uses), and maps changed files to apps.
export async function GET(request: NextRequest) {
  const unauth = await requireSession(request);
  if (unauth) return unauth;
  const missing = requireGithubToken();
  if (missing) return missing;

  try {
    const lastBuiltSha = await githubApi.getLastBuiltSha();
    if (!lastBuiltSha) {
      // No deploy-state marker yet (first deploy). Can't compute drift — the
      // workflow falls back to force_all semantics.
      const body: OpsFreshnessResponse = {
        lastSha: null,
        lastBuiltAt: null,
        head: null,
        drift: [],
        comparedAgainst: "none",
      };
      return NextResponse.json(body);
    }
    const cmp = await githubApi.compareCommits(lastBuiltSha, DEFAULT_DEPLOY_REF);
    const body: OpsFreshnessResponse = {
      lastSha: (cmp.baseSha ?? lastBuiltSha).slice(0, 7),
      lastBuiltAt: cmp.baseDate,
      head: null,
      drift: appsForChangedFiles(cmp.files),
      comparedAgainst: "last-built",
    };
    return NextResponse.json(body);
  } catch (error) {
    if (error instanceof GithubApiError && error.status === 404) {
      // Marker SHA isn't reachable from main (history rewritten). Can't compute
      // drift — the workflow would fall back to force_all semantics.
      const body: OpsFreshnessResponse = {
        lastSha: null,
        lastBuiltAt: null,
        head: null,
        drift: [],
        comparedAgainst: "none",
      };
      return NextResponse.json(body);
    }
    return githubErrorResponse(error, "backoffice.api.ops.freshness");
  }
}
