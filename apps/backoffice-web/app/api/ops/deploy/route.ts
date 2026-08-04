import { NextResponse, type NextRequest } from "next/server";
import { type DeployDispatchResponse, DeployRequestSchema } from "@rop/contracts";
import { requireSession } from "@/lib/auth/require-session";
import { githubApi } from "@/lib/github";
import { githubErrorResponse, requireGithubToken } from "@/lib/ops/route-helpers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Fires the production deploy (workflow_dispatch on build-images.yml). The
// dispatch API returns 204 with no run id, and the freshly-created run is not
// immediately listable, so we don't try to resolve it here — the client polls
// /api/ops/pipeline/runs to discover the new run and then its jobs. Returning a
// possibly-stale run id would risk the UI latching onto a previous run.
export async function POST(request: NextRequest) {
  const unauth = await requireSession(request);
  if (unauth) return unauth;
  const missing = requireGithubToken();
  if (missing) return missing;

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const parsed = DeployRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_request", detail: parsed.error.message }, { status: 400 });
  }

  const { mode, skipDeploy } = parsed.data;
  try {
    await githubApi.dispatchBuildImages({ forceAll: mode === "force_all", skipDeploy });
    // Audit trail of who fired a deploy (no secrets; structured for log search).
    console.info(
      JSON.stringify({
        level: "info",
        scope: "backoffice.api.ops.deploy",
        event: "dispatch",
        mode,
        skipDeploy,
      }),
    );
    const body: DeployDispatchResponse = { ok: true, runId: null, htmlUrl: null };
    return NextResponse.json(body);
  } catch (error) {
    return githubErrorResponse(error, "backoffice.api.ops.deploy");
  }
}
