"use client";

import { RefreshCw, ShieldCheck } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { buildRunnerSummary } from "@/lib/ops/build-runner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { RelativeTime } from "@/components/ops/relative-time";
import {
  PipelineApiError,
  usePipelineImages,
  usePipelineRuns,
} from "@/hooks/use-pipeline";
import {
  useBuildRunnerVar,
  useDeployController,
  useOpsFreshness,
  useOpsRunners,
} from "@/hooks/use-ops-deploy";
import { toneClass } from "./tokens";
import { BuildRoutingCard } from "./build-routing-card";
import { DeployCard } from "./deploy-card";
import { DeployHistoryCard } from "./deploy-history-card";
import { GithubStatusRow } from "./github-status-row";
import { ImagesCard } from "./images-card";
import { RecentRunsCard } from "./recent-runs-card";
import { RunnersCard } from "./runners-card";
import { StatusStrip } from "./status-strip";

const BUILD_WORKFLOW_NAME = "Build and push images (GHCR)";

function isMissingToken(error: unknown): boolean {
  return error instanceof PipelineApiError && error.errorCode === "missing_github_token";
}

export function OperationsPage() {
  const queryClient = useQueryClient();
  const runners = useOpsRunners();
  const freshness = useOpsFreshness();
  const runsQuery = usePipelineRuns();
  const imagesQuery = usePipelineImages();
  const buildRunner = useBuildRunnerVar();

  const fresh = freshness.data;
  const runs = runsQuery.data?.runs;
  const controller = useDeployController(fresh?.drift ?? []);

  // The newest build that is currently running, if any (drives the lock).
  const anyActiveBuild =
    runs?.find(
      (r) =>
        (r.workflowName === BUILD_WORKFLOW_NAME || r.name === BUILD_WORKFLOW_NAME) &&
        (r.status === "in_progress" || r.status === "queued"),
    ) ?? null;
  // While we're driving our own deploy, the deploy card shows full progress, so
  // the strip falls back to freshness instead of duplicating the lock.
  const activeBuildForStrip = controller.live ? null : anyActiveBuild;
  const locked = !controller.live && anyActiveBuild !== null;

  const connected = !(isMissingToken(runners.error) || isMissingToken(freshness.error));
  const routeSummary = buildRunner.data
    ? buildRunnerSummary(buildRunner.data.strategy, buildRunner.data.machines)
    : "Any free Mac";
  const syncedIso = runners.dataUpdatedAt ? new Date(runners.dataUpdatedAt).toISOString() : null;

  const refreshAll = () => queryClient.invalidateQueries({ queryKey: ["ops"] });

  return (
    <div className="mx-auto grid w-full max-w-[1120px] gap-4">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="grid gap-1">
          <div className="flex items-center gap-2.5">
            <h1 className="text-3xl font-medium tracking-tight">Operations</h1>
            <Badge variant="outline" className={`gap-1 ${toneClass.accent}`}>
              <ShieldCheck className="size-3" />
              admin
            </Badge>
          </div>
          <p className="text-muted-foreground max-w-[60ch] text-sm">
            CI/CD infrastructure &amp; one-click deploys — no terminal, no YAML. Talks only to the
            GitHub API for this repo.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className="text-muted-foreground inline-flex items-center gap-1.5 text-xs">
            <span className="size-2 rounded-full bg-[color:var(--accent)]" />
            synced <RelativeTime iso={syncedIso} />
          </span>
          <Button variant="outline" size="sm" onClick={refreshAll}>
            <RefreshCw className="size-3.5" />
            Refresh
          </Button>
        </div>
      </header>

      <StatusStrip activeBuild={activeBuildForStrip} fresh={fresh} />
      <GithubStatusRow connected={connected} />
      <RunnersCard data={runners.data} isLoading={runners.isLoading} isError={runners.isError} />

      <div className="grid items-start gap-4 md:grid-cols-[minmax(0,1.45fr)_minmax(0,1fr)]">
        <DeployCard
          controller={controller}
          fresh={fresh}
          locked={locked}
          lockRunNumber={anyActiveBuild?.runNumber}
          routeSummary={routeSummary}
        />
        <RecentRunsCard runs={runs} isLoading={runsQuery.isLoading} isError={runsQuery.isError} />
      </div>

      <div className="grid items-start gap-4 md:grid-cols-2">
        <ImagesCard
          data={imagesQuery.data}
          isLoading={imagesQuery.isLoading}
          isError={imagesQuery.isError}
          drift={fresh?.drift ?? []}
        />
        <DeployHistoryCard runs={runs} isLoading={runsQuery.isLoading} isError={runsQuery.isError} />
      </div>

      <BuildRoutingCard />
    </div>
  );
}
