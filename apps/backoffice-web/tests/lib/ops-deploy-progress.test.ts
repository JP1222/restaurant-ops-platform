import { describe, expect, it } from "vitest";
import type { WorkflowJob, WorkflowRunSummary } from "@/lib/github";
import { deriveDeployProgress, phaseFromRun } from "@/lib/ops/deploy-progress";

function makeRun(status: string, conclusion: string | null = null): WorkflowRunSummary {
  return {
    id: 1,
    name: "Build and push images (GHCR)",
    workflowId: 1,
    workflowName: "Build and push images (GHCR)",
    headBranch: "main",
    headSha: "abc1234",
    event: "workflow_dispatch",
    status,
    conclusion,
    runNumber: 1482,
    runAttempt: 1,
    createdAt: "2026-05-28T00:00:00Z",
    updatedAt: "2026-05-28T00:00:00Z",
    runStartedAt: "2026-05-28T00:00:00Z",
    htmlUrl: "#",
    actorLogin: "you",
    displayTitle: null,
  };
}

function makeJob(name: string, status: string, conclusion: string | null = null): WorkflowJob {
  return {
    id: Math.round(name.length),
    runId: 1,
    name,
    status,
    conclusion,
    startedAt: null,
    completedAt: null,
    runnerName: null,
    htmlUrl: "#",
    steps: [],
  };
}

describe("phaseFromRun", () => {
  it("maps run status/conclusion to a deploy phase", () => {
    expect(phaseFromRun(null)).toBe("dispatching");
    expect(phaseFromRun(makeRun("queued"))).toBe("queued");
    expect(phaseFromRun(makeRun("in_progress"))).toBe("running");
    expect(phaseFromRun(makeRun("completed", "success"))).toBe("success");
    expect(phaseFromRun(makeRun("completed", "failure"))).toBe("failure");
  });
});

describe("deriveDeployProgress", () => {
  it("seeds the matrix from the expected apps before build jobs exist", () => {
    const progress = deriveDeployProgress(makeRun("in_progress"), [makeJob("Detect changed apps", "in_progress")], {
      skipDeploy: false,
      expectedApps: ["backoffice-web", "analytics-api"],
    });
    expect(progress.phase).toBe("running");
    expect(progress.steps.detect).toBe("active");
    expect(progress.apps).toEqual([
      { app: "backoffice-web", status: "queued" },
      { app: "analytics-api", status: "queued" },
    ]);
  });

  it("derives a real per-app matrix from build jobs", () => {
    const jobs = [
      makeJob("Detect changed apps", "completed", "success"),
      makeJob("Build backoffice-web (arm64)", "in_progress"),
      makeJob("Build analytics-api (arm64)", "completed", "success"),
    ];
    const progress = deriveDeployProgress(makeRun("in_progress"), jobs, {
      skipDeploy: false,
      expectedApps: ["backoffice-web", "analytics-api"],
    });
    expect(progress.steps.detect).toBe("done");
    expect(progress.steps.build).toBe("active");
    expect(progress.apps).toContainEqual({ app: "backoffice-web", status: "building" });
    expect(progress.apps).toContainEqual({ app: "analytics-api", status: "done" });
  });

  it("marks every step done at 100% on success", () => {
    const progress = deriveDeployProgress(makeRun("completed", "success"), [], {
      skipDeploy: false,
      expectedApps: ["backoffice-web"],
    });
    expect(progress.phase).toBe("success");
    expect(progress.pct).toBe(100);
    expect(Object.values(progress.steps).every((s) => s === "done")).toBe(true);
  });

  it("shows the deploy step skipped when skip_deploy is set", () => {
    const progress = deriveDeployProgress(makeRun("completed", "success"), [], {
      skipDeploy: true,
      expectedApps: ["backoffice-web"],
    });
    expect(progress.steps.deploy).toBe("skipped");
  });

  it("flags a failed build job", () => {
    const jobs = [
      makeJob("Detect changed apps", "completed", "success"),
      makeJob("Build kds-web (arm64)", "completed", "failure"),
    ];
    const progress = deriveDeployProgress(makeRun("completed", "failure"), jobs, {
      skipDeploy: false,
      expectedApps: ["kds-web"],
    });
    expect(progress.phase).toBe("failure");
    expect(progress.steps.build).toBe("failed");
    expect(progress.apps).toContainEqual({ app: "kds-web", status: "failed" });
  });
});
