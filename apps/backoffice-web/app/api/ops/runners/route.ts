import { NextResponse, type NextRequest } from "next/server";
import type { OpsRunner, OpsRunnersResponse } from "@rop/contracts";
import { requireSession } from "@/lib/auth/require-session";
import { BUILD_WORKFLOW_FILE, githubApi } from "@/lib/github";
import { githubErrorResponse, requireGithubToken } from "@/lib/ops/route-helpers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Best-effort "what is this busy runner working on" — the runners API doesn't
// include the current job, so when something is busy we peek at the in-flight
// build runs' jobs and match by runner name. Failures here never break the list.
async function currentJobsByRunner(): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  try {
    const runs = await githubApi.listWorkflowRuns(BUILD_WORKFLOW_FILE, { perPage: 5 });
    const active = runs.filter((r) => r.status === "in_progress" || r.status === "queued");
    for (const run of active) {
      const jobs = await githubApi.listJobs(run.id);
      for (const job of jobs) {
        if (job.runnerName && (job.status === "in_progress" || job.status === "queued")) {
          map.set(job.runnerName, `${job.name} · #${run.runNumber}`);
        }
      }
    }
  } catch {
    // correlation is a nicety; never fail the runners list over it
  }
  return map;
}

export async function GET(request: NextRequest) {
  const unauth = await requireSession(request);
  if (unauth) return unauth;
  const missing = requireGithubToken();
  if (missing) return missing;

  try {
    const runners = await githubApi.listRunners();
    const jobByRunner = runners.some((r) => r.busy)
      ? await currentJobsByRunner()
      : new Map<string, string>();

    const mapped: OpsRunner[] = runners.map((r) => ({
      id: r.id,
      name: r.name,
      status: r.status,
      busy: r.busy,
      os: r.os,
      labels: r.labels,
      currentJob: r.busy ? (jobByRunner.get(r.name) ?? null) : null,
    }));

    const body: OpsRunnersResponse = {
      runners: mapped,
      online: mapped.filter((r) => r.status === "online").length,
      total: mapped.length,
      busy: mapped.filter((r) => r.busy).length,
    };
    return NextResponse.json(body);
  } catch (error) {
    return githubErrorResponse(error, "backoffice.api.ops.runners");
  }
}
