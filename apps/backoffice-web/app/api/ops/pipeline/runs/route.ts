import { NextResponse, type NextRequest } from "next/server";
import { requireSession } from "@/lib/auth/require-session";
import { getServerEnv } from "@/lib/env";
import { githubApi } from "@/lib/github";
import { githubErrorResponse } from "@/lib/ops/route-helpers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// We surface only the workflows that participate in the production deploy
// flow. Other workflows (e.g. issue triage cron) are not interesting on this
// dashboard and would crowd the timeline.
const VISIBLE_WORKFLOWS = new Set(["CI", "Build and push images (GHCR)"]);

export async function GET(request: NextRequest) {
  const unauth = await requireSession(request);
  if (unauth) return unauth;
  // Private repos require auth on the GH API. Distinguish "operator hasn't
  // wired the token yet" from generic upstream failures so the UI can guide
  // the operator to .env setup instead of showing a scary error.
  const env = getServerEnv();
  if (!env.GITHUB_PIPELINE_TOKEN) {
    return NextResponse.json(
      {
        error: "missing_github_token",
        message:
          "Set GITHUB_PIPELINE_TOKEN in the backoffice env to enable workflow run history (PAT scopes: actions:read, read:packages).",
      },
      { status: 503 },
    );
  }
  try {
    const runs = await githubApi.listRecentRuns({ perPage: 30 });
    const filtered = runs.filter((r) => VISIBLE_WORKFLOWS.has(r.workflowName) || VISIBLE_WORKFLOWS.has(r.name));
    return NextResponse.json({ runs: filtered });
  } catch (error) {
    return githubErrorResponse(error, "backoffice.api.ops.pipeline.runs");
  }
}
