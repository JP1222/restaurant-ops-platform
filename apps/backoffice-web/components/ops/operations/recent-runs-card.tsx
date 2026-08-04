import { Clock, ExternalLink } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import type { WorkflowRunSummary } from "@/lib/github";
import { RelativeTime } from "@/components/ops/relative-time";
import { toneClass, type Tone } from "./tokens";

const BUILD_WORKFLOW_NAME = "Build and push images (GHCR)";

function conclusion(run: WorkflowRunSummary): { tone: Tone; label: string } {
  if (run.status === "in_progress") return { tone: "blue", label: "running" };
  if (run.status === "queued") return { tone: "muted", label: "queued" };
  switch (run.conclusion) {
    case "success":
      return { tone: "accent", label: "success" };
    case "failure":
      return { tone: "danger", label: "failed" };
    default:
      return { tone: "muted", label: run.conclusion ?? run.status };
  }
}

export function RecentRunsCard({
  runs,
  isLoading,
  isError,
}: {
  runs: WorkflowRunSummary[] | undefined;
  isLoading: boolean;
  isError: boolean;
}) {
  const buildRuns = (runs ?? [])
    .filter((r) => r.workflowName === BUILD_WORKFLOW_NAME || r.name === BUILD_WORKFLOW_NAME)
    .slice(0, 8);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base font-medium">
          <Clock className="text-muted-foreground size-4" />
          Recent runs
        </CardTitle>
        <CardDescription>Last build dispatches, newest first.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-0.5">
        {isLoading ? (
          <>
            <Skeleton className="h-11 w-full" />
            <Skeleton className="h-11 w-full" />
            <Skeleton className="h-11 w-full" />
          </>
        ) : isError ? (
          <p className="text-muted-foreground text-sm">Could not load workflow runs.</p>
        ) : buildRuns.length === 0 ? (
          <p className="text-muted-foreground text-sm">No build runs yet.</p>
        ) : (
          buildRuns.map((run) => {
            const c = conclusion(run);
            return (
              <a
                key={run.id}
                href={run.htmlUrl}
                target="_blank"
                rel="noreferrer"
                className="hover:bg-muted/50 flex items-center justify-between gap-3 rounded-md px-2 py-1.5 transition-colors"
              >
                <div className="min-w-0 flex-1 space-y-0.5">
                  <div className="flex items-center gap-2">
                    <Badge
                      variant="outline"
                      className={cn(
                        "rounded-full border-transparent px-1.5 py-0 text-[10px] font-medium tracking-wider uppercase",
                        toneClass[c.tone],
                      )}
                    >
                      {c.label}
                    </Badge>
                    <span className="truncate text-xs font-medium">
                      {run.displayTitle || run.workflowName || run.name}
                    </span>
                    <span className="text-muted-foreground font-mono text-[10px]">
                      #{run.runNumber}
                    </span>
                  </div>
                  <p className="text-muted-foreground truncate font-mono text-[10px]">
                    {run.headSha.slice(0, 7)} · {run.headBranch ?? ""} · {run.actorLogin ?? run.event}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <span className="text-muted-foreground text-[10px]">
                    <RelativeTime iso={run.runStartedAt} />
                  </span>
                  <ExternalLink className="text-muted-foreground size-3" />
                </div>
              </a>
            );
          })
        )}
      </CardContent>
    </Card>
  );
}
