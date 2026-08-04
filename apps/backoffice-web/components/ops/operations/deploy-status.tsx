import {
  Check,
  CircleCheck,
  CircleX,
  ExternalLink,
  GitBranch,
  Loader2,
  RefreshCw,
  TriangleAlert,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";
import type { WorkflowRunSummary } from "@/lib/github";
import {
  DEPLOY_STEPS,
  type AppBuildStatus,
  type DeployProgress,
  type StepStatus,
} from "@/lib/ops/deploy-progress";

function StepIcon({ status }: { status: StepStatus }) {
  if (status === "active") return <Loader2 className="size-3.5 animate-spin text-muted-foreground" />;
  if (status === "done") return <Check className="size-3.5 text-[color:var(--accent)]" />;
  if (status === "failed") return <X className="size-3.5 text-[color:var(--destructive)]" />;
  return <span className="bg-muted-foreground/40 size-1.5 rounded-full" />;
}

function AppStatusIcon({ status }: { status: AppBuildStatus }) {
  if (status === "building") return <Loader2 className="size-3 animate-spin text-[color:var(--chart-3)]" />;
  if (status === "done") return <CircleCheck className="size-3 text-[color:var(--accent)]" />;
  if (status === "failed") return <CircleX className="size-3 text-[color:var(--destructive)]" />;
  return <span className="bg-muted-foreground/40 size-1.5 rounded-full" />;
}

const PHASE_LABEL = (progress: DeployProgress, skipDeploy: boolean): string => {
  switch (progress.phase) {
    case "dispatching":
      return "Dispatching workflow…";
    case "queued":
      return "Queued — waiting for a Mac runner";
    case "running":
      return skipDeploy ? "Building…" : "Building & deploying…";
    case "success":
      return skipDeploy ? "Build complete — deploy skipped" : "Deployed successfully";
    case "failure":
      return "Deploy failed";
  }
};

export function DeployStatus({
  progress,
  activeRun,
  skipDeploy,
  onReset,
  onRetry,
}: {
  progress: DeployProgress;
  activeRun: WorkflowRunSummary | null;
  skipDeploy: boolean;
  onReset: () => void;
  onRetry: () => void;
}) {
  const { phase } = progress;

  return (
    <div className="grid gap-3.5">
      <div className="flex items-center gap-2">
        {phase === "success" ? (
          <CircleCheck className="size-[18px] text-[color:var(--accent)]" />
        ) : phase === "failure" ? (
          <CircleX className="size-[18px] text-[color:var(--destructive)]" />
        ) : (
          <Loader2 className="text-muted-foreground size-[18px] animate-spin" />
        )}
        <span className="font-medium">{PHASE_LABEL(progress, skipDeploy)}</span>
        {activeRun ? (
          <span className="text-muted-foreground ml-auto font-mono text-[11px]">
            run #{activeRun.runNumber}
          </span>
        ) : null}
      </div>

      <Progress value={progress.pct} />

      <div className="grid gap-1.5">
        {DEPLOY_STEPS.map((step) => {
          const status = progress.steps[step.key];
          return (
            <div
              key={step.key}
              className={cn(
                "flex items-center gap-2.5 text-[0.8rem]",
                status === "todo" && "opacity-45",
              )}
            >
              <span className="flex size-3.5 items-center justify-center">
                <StepIcon status={status} />
              </span>
              <span className={cn(status === "active" && "font-medium")}>{step.label}</span>
              {status === "skipped" ? (
                <span className="text-muted-foreground bg-muted rounded-full px-1.5 py-0 text-[10px]">
                  skipped
                </span>
              ) : null}
            </div>
          );
        })}
      </div>

      {progress.apps.length > 0 ? (
        <div>
          <div className="text-muted-foreground mb-1.5 text-[0.7rem] tracking-wider uppercase">
            Matrix · {progress.apps.length} {progress.apps.length === 1 ? "app" : "apps"}
          </div>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-1.5">
            {progress.apps.map((app) => (
              <div
                key={app.app}
                className="bg-muted/45 flex items-center gap-1.5 rounded-md px-2 py-1 text-xs"
              >
                <AppStatusIcon status={app.status} />
                <span className="truncate font-mono">{app.app}</span>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {phase === "failure" ? (
        <div className="border-[color:var(--destructive)]/25 bg-[color:var(--destructive)]/[0.08] flex items-start gap-2 rounded-md border p-2.5">
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-[color:var(--destructive)]" />
          <div className="grid gap-0.5 text-[0.78rem]">
            <span className="font-medium text-[color:var(--destructive)]">
              One or more steps failed
            </span>
            <span className="text-muted-foreground">
              Images may have pushed to GHCR without a redeploy, and the last-built marker was not
              advanced. Open the run for the full log.
            </span>
          </div>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2 pt-0.5">
        {phase === "failure" ? (
          <>
            <Button size="sm" onClick={onRetry} className="bg-[color:var(--accent)] text-[color:var(--accent-foreground)] hover:bg-[color:var(--accent)]/90">
              <RefreshCw className="size-3.5" />
              Retry deploy
            </Button>
            {activeRun ? (
              <a
                href={activeRun.htmlUrl}
                target="_blank"
                rel="noreferrer"
                className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1.5 text-sm"
              >
                <ExternalLink className="size-3.5" />
                View run
              </a>
            ) : null}
            <Button size="sm" variant="ghost" className="ml-auto" onClick={onReset}>
              Dismiss
            </Button>
          </>
        ) : phase === "success" ? (
          <>
            <Button size="sm" variant="outline" onClick={onReset}>
              Done
            </Button>
            {activeRun ? (
              <a
                href={activeRun.htmlUrl}
                target="_blank"
                rel="noreferrer"
                className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1.5 text-sm"
              >
                <ExternalLink className="size-3.5" />
                View run on GitHub
              </a>
            ) : null}
          </>
        ) : (
          <span className="text-muted-foreground inline-flex items-center gap-1.5 text-xs">
            <GitBranch className="size-3" />
            main
            {activeRun ? (
              <>
                {" · "}
                <a
                  href={activeRun.htmlUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="hover:text-foreground inline-flex items-center gap-1"
                >
                  <ExternalLink className="size-3" />
                  View run
                </a>
              </>
            ) : null}
          </span>
        )}
      </div>
    </div>
  );
}
