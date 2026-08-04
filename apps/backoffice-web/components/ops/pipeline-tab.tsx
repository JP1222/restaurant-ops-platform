"use client";

import { useMemo, useState } from "react";
import {
  PipelineApiError,
  usePipelineImages,
  usePipelineRunDetail,
  usePipelineRuns,
  usePipelineServices,
} from "@/hooks/use-pipeline";
import { Card, CardContent } from "@/components/ui/card";
import { PipelineFlow } from "./pipeline-flow";
import { PipelineImagesCard } from "./pipeline-images-card";
import { PipelineRunList } from "./pipeline-run-list";
import { PipelineServicesStrip } from "./pipeline-services-strip";

const BUILD_WORKFLOW_NAMES = new Set(["Build and push images (GHCR)"]);
const CI_WORKFLOW_NAMES = new Set(["CI"]);

export function PipelineTab() {
  const runs = usePipelineRuns();
  const images = usePipelineImages();
  const services = usePipelineServices();

  // Default selection: latest build run (or first run overall if no build run).
  const defaultRunId = useMemo(() => {
    const all = runs.data?.runs ?? [];
    const latestBuild = all.find((r) => BUILD_WORKFLOW_NAMES.has(r.workflowName) || BUILD_WORKFLOW_NAMES.has(r.name));
    return latestBuild?.id ?? all[0]?.id ?? null;
  }, [runs.data]);

  // Explicit selection overrides the auto-default. Avoids a setState-in-effect
  // (React Compiler flags that pattern) and gives the user a "stick to a
  // specific run" experience while letting auto-selection follow the latest
  // build by default.
  const [explicitRunId, setExplicitRunId] = useState<number | null>(null);
  const selectedRunId = explicitRunId ?? defaultRunId;

  const runDetail = usePipelineRunDetail(selectedRunId);

  // The CI run paired with the selected build run: same headSha, workflow "CI".
  const ciCounterpart = useMemo(() => {
    const all = runs.data?.runs ?? [];
    const buildRun = runDetail.data?.run;
    if (!buildRun) return null;
    return (
      all.find(
        (r) =>
          (CI_WORKFLOW_NAMES.has(r.workflowName) || CI_WORKFLOW_NAMES.has(r.name)) &&
          r.headSha === buildRun.headSha,
      ) ?? null
    );
  }, [runs.data, runDetail.data]);

  const latestBuildRun =
    runDetail.data?.run &&
    (BUILD_WORKFLOW_NAMES.has(runDetail.data.run.workflowName) ||
      BUILD_WORKFLOW_NAMES.has(runDetail.data.run.name))
      ? runDetail.data.run
      : null;

  // Token-missing banner: show a single guiding message instead of three
  // "could not load" cards when the operator hasn't wired the GH PAT yet.
  const tokenMissing =
    runs.error instanceof PipelineApiError && runs.error.errorCode === "missing_github_token";

  return (
    <div className="space-y-4">
      {tokenMissing ? (
        <Card className="border-[color:var(--chart-4)]/40 bg-[color:var(--chart-4)]/5">
          <CardContent className="space-y-1 py-3 text-sm">
            <p className="font-medium">GitHub Actions data unavailable</p>
            <p className="text-muted-foreground">
              Set <span className="font-mono">GITHUB_PIPELINE_TOKEN</span> in the backoffice env to populate the
              build / GHCR / run-history surfaces. PAT needs{" "}
              <span className="font-mono">actions:read</span> and{" "}
              <span className="font-mono">read:packages</span>. Service health below still updates live.
            </p>
          </CardContent>
        </Card>
      ) : null}
      <PipelineServicesStrip
        data={services.data}
        isLoading={services.isLoading}
        isError={services.isError}
      />

      <PipelineFlow
        buildRun={latestBuildRun}
        buildJobs={
          latestBuildRun ? (runDetail.data?.jobs ?? []) : []
        }
        ciRun={ciCounterpart}
        images={images.data ?? null}
        services={services.data ?? null}
      />

      <div className="grid gap-4 lg:grid-cols-[2fr_1fr]">
        <PipelineRunList
          runs={runs.data?.runs}
          selectedRunId={selectedRunId}
          onSelectRun={setExplicitRunId}
          isLoading={runs.isLoading}
          isError={runs.isError}
        />
        <PipelineImagesCard
          data={images.data}
          isLoading={images.isLoading}
          isError={images.isError}
        />
      </div>
    </div>
  );
}
