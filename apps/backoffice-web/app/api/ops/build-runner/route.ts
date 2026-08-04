import { NextResponse, type NextRequest } from "next/server";
import { type BuildRunnerVar, BuildRunnerUpdateRequestSchema } from "@rop/contracts";
import { requireSession } from "@/lib/auth/require-session";
import { githubApi } from "@/lib/github";
import { parseBuildRunner } from "@/lib/ops/build-runner";
import { githubErrorResponse, requireGithubToken } from "@/lib/ops/route-helpers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// The repo variable build-images.yml's `runs-on` is intended to read. Writing it
// here is real, but it only takes effect once the workflow is updated to consume
// it AND each runner carries a per-machine label (mac-mini / macbook). The card
// is "optional / collapsed" until then.
const VAR_NAME = "BUILD_RUNNER";

export async function GET(request: NextRequest) {
  const unauth = await requireSession(request);
  if (unauth) return unauth;
  const missing = requireGithubToken();
  if (missing) return missing;

  try {
    const variable = await githubApi.getRepoVariable(VAR_NAME);
    const value = variable?.value ?? "";
    const { strategy, machines } = parseBuildRunner(value);
    const body: BuildRunnerVar = { exists: variable !== null, value, strategy, machines };
    return NextResponse.json(body);
  } catch (error) {
    return githubErrorResponse(error, "backoffice.api.ops.build-runner");
  }
}

export async function PATCH(request: NextRequest) {
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
  const parsed = BuildRunnerUpdateRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_request", detail: parsed.error.message }, { status: 400 });
  }

  try {
    await githubApi.setRepoVariable(VAR_NAME, parsed.data.value);
    console.info(
      JSON.stringify({
        level: "info",
        scope: "backoffice.api.ops.build-runner",
        event: "set",
        value: parsed.data.value,
      }),
    );
    const { strategy, machines } = parseBuildRunner(parsed.data.value);
    const body: BuildRunnerVar = { exists: true, value: parsed.data.value, strategy, machines };
    return NextResponse.json(body);
  } catch (error) {
    return githubErrorResponse(error, "backoffice.api.ops.build-runner");
  }
}
