import { NextResponse, type NextRequest } from "next/server";
import { requireSession } from "@/lib/auth/require-session";
import { getServerEnv } from "@/lib/env";
import { githubApi, GithubApiError } from "@/lib/github";
import { redactSecrets } from "@/lib/redact";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const unauth = await requireSession(request);
  if (unauth) return unauth;
  const env = getServerEnv();
  if (!env.GITHUB_PIPELINE_TOKEN) {
    return NextResponse.json(
      { error: "missing_github_token" },
      { status: 503 },
    );
  }
  const { id } = await ctx.params;
  const runId = Number(id);
  if (!Number.isInteger(runId) || runId <= 0) {
    return NextResponse.json({ error: "invalid_run_id" }, { status: 400 });
  }

  try {
    const [run, jobs] = await Promise.all([
      githubApi.getRun(runId),
      githubApi.listJobs(runId),
    ]);
    return NextResponse.json({ run, jobs });
  } catch (error) {
    if (error instanceof GithubApiError) {
      console.error(
        JSON.stringify({
          level: "error",
          scope: "backoffice.api.ops.pipeline.run",
          runId,
          upstreamStatus: error.status,
          message: redactSecrets(error.bodyText.slice(0, 500)),
        }),
      );
      return NextResponse.json(
        { error: "github_upstream_error", upstream_status: error.status },
        { status: error.status === 404 ? 404 : 502 },
      );
    }
    console.error(
      JSON.stringify({
        level: "error",
        scope: "backoffice.api.ops.pipeline.run",
        runId,
        message: redactSecrets(error instanceof Error ? error.message : "unknown"),
      }),
    );
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
