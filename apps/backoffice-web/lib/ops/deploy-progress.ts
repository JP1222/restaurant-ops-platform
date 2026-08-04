import type { WorkflowJob, WorkflowRunSummary } from "@/lib/github";

// Maps a live build-images.yml run (+ its jobs) onto the design's deploy UI:
// a 5-step pipeline, a per-app build matrix, and a progress %. The matrix is
// exact (one build job per app). The 5 steps are a friendly summary of the
// workflow's job graph (setup → build matrix → push/redeploy steps → tag), so
// the mapping is intentionally coarse and monotonic rather than 1:1.

export type DeployPhase = "dispatching" | "queued" | "running" | "success" | "failure";
export type StepStatus = "todo" | "active" | "done" | "failed" | "skipped";
export type AppBuildStatus = "queued" | "building" | "done" | "failed";

export const DEPLOY_STEPS = [
  { key: "detect", label: "Detect changed apps" },
  { key: "build", label: "Build matrix · native arm64" },
  { key: "push", label: "Push images → GHCR" },
  { key: "deploy", label: "Roll out to host" },
  { key: "tag", label: "Advance last-built tag" },
] as const;
export type DeployStepKey = (typeof DEPLOY_STEPS)[number]["key"];

export interface DeployProgress {
  phase: DeployPhase;
  steps: Record<DeployStepKey, StepStatus>;
  apps: Array<{ app: string; status: AppBuildStatus }>;
  pct: number;
}

// Build jobs are named "Build <app> (arm64)".
function appFromJobName(name: string): string | null {
  const match = name.match(/^Build\s+(.+?)\s*\(arm64\)/i);
  return match?.[1] ?? null;
}

export function phaseFromRun(run: WorkflowRunSummary | null | undefined): DeployPhase {
  if (!run) return "dispatching";
  if (run.status === "queued") return "queued";
  if (run.status === "completed") return run.conclusion === "success" ? "success" : "failure";
  return "running";
}

export function deriveDeployProgress(
  run: WorkflowRunSummary | null | undefined,
  jobs: readonly WorkflowJob[],
  options: { skipDeploy: boolean; expectedApps: readonly string[] },
): DeployProgress {
  const phase = phaseFromRun(run);
  const failed = phase === "failure";
  const succeeded = phase === "success";

  const setupJob = jobs.find((j) => /detect changed apps/i.test(j.name));
  const buildJobs = jobs.filter((j) => appFromJobName(j.name) !== null);
  const tagJob = jobs.find((j) => /last-built|advance/i.test(j.name));

  const isDone = (j?: WorkflowJob) => j?.status === "completed";
  const isOk = (j?: WorkflowJob) => j?.status === "completed" && j.conclusion === "success";
  const isActive = (j?: WorkflowJob) => j?.status === "in_progress";

  // Per-app matrix (exact). Before the build jobs exist, seed from the expected
  // set so the matrix isn't empty during detect/queue.
  const appStatus = (j: WorkflowJob): AppBuildStatus => {
    if (j.status === "completed") return j.conclusion === "success" ? "done" : "failed";
    if (j.status === "in_progress") return "building";
    return "queued";
  };
  const fromJobs = buildJobs.map((j) => ({
    app: appFromJobName(j.name) as string,
    status: appStatus(j),
  }));
  const apps =
    fromJobs.length > 0
      ? fromJobs
      : options.expectedApps.map((app) => ({ app, status: "queued" as AppBuildStatus }));

  const allBuildDone = buildJobs.length > 0 && buildJobs.every(isDone);
  const allBuildOk = buildJobs.length > 0 && buildJobs.every(isOk);
  const anyBuildActive = buildJobs.some(isActive);
  const anyBuildFailed = buildJobs.some((j) => j.status === "completed" && j.conclusion !== "success");

  const steps: Record<DeployStepKey, StepStatus> = {
    detect: "todo",
    build: "todo",
    push: "todo",
    deploy: options.skipDeploy ? "skipped" : "todo",
    tag: "todo",
  };

  if (phase === "running" || succeeded || failed) {
    steps.detect = setupJob
      ? isDone(setupJob)
        ? "done"
        : isActive(setupJob)
          ? "active"
          : "todo"
      : buildJobs.length > 0
        ? "done"
        : "active";

    if (anyBuildFailed) steps.build = "failed";
    else if (allBuildDone) steps.build = "done";
    else if (buildJobs.length > 0 || anyBuildActive) steps.build = "active";

    // Push is the tail of each build job (no separate signal) — couple it to the
    // build matrix completing successfully.
    if (allBuildOk) steps.push = "done";
    else if (allBuildDone) steps.push = "failed";

    if (!options.skipDeploy && allBuildOk) {
      steps.deploy = failed ? "failed" : isOk(tagJob) || succeeded ? "done" : "active";
    }
    if (isOk(tagJob) || succeeded) steps.tag = "done";
  }

  if (succeeded) {
    steps.detect = "done";
    steps.build = "done";
    steps.push = "done";
    steps.deploy = options.skipDeploy ? "skipped" : "done";
    steps.tag = "done";
  }

  const order: DeployStepKey[] = ["detect", "build", "push", "deploy", "tag"];
  const doneCount = order.filter((k) => steps[k] === "done" || steps[k] === "skipped").length;
  let pct: number;
  if (succeeded) pct = 100;
  else if (phase === "dispatching") pct = 6;
  else if (phase === "queued") pct = 14;
  else pct = Math.min(95, 20 + doneCount * 15);

  return { phase, steps, apps, pct };
}
