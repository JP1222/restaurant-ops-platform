"use client";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { WorkflowRunSummary } from "@/lib/github";
import { RelativeTime } from "./relative-time";

interface Props {
  runs: WorkflowRunSummary[] | undefined;
  selectedRunId: number | null;
  onSelectRun: (runId: number) => void;
  isLoading: boolean;
  isError: boolean;
}

const CONCLUSION_STYLES: Record<string, string> = {
  success: "bg-[color:var(--accent)]/15 text-[color:var(--accent)]",
  failure: "bg-[color:var(--destructive)]/15 text-[color:var(--destructive)]",
  cancelled: "bg-muted text-muted-foreground",
  skipped: "bg-muted text-muted-foreground",
  in_progress: "bg-[color:var(--chart-3)]/15 text-[color:var(--chart-3)]",
  queued: "bg-muted text-muted-foreground",
};

function conclusionLabel(run: WorkflowRunSummary) {
  if (run.status === "in_progress") return "running";
  if (run.status === "queued") return "queued";
  return run.conclusion ?? run.status;
}

export function PipelineRunList({ runs, selectedRunId, onSelectRun, isLoading, isError }: Props) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base font-medium">Recent runs</CardTitle>
        <CardDescription>Last 20 CI + build runs (newest first)</CardDescription>
      </CardHeader>
      <CardContent className="space-y-1">
        {isLoading ? (
          <>
            <Skeleton className="h-[44px] w-full" />
            <Skeleton className="h-[44px] w-full" />
            <Skeleton className="h-[44px] w-full" />
          </>
        ) : isError || !runs ? (
          <p className="text-sm text-muted-foreground">Could not load workflow runs.</p>
        ) : runs.length === 0 ? (
          <p className="text-sm text-muted-foreground">No runs in window.</p>
        ) : (
          runs.slice(0, 20).map((run) => {
            const lab = conclusionLabel(run);
            return (
              <button
                key={run.id}
                onClick={() => onSelectRun(run.id)}
                className={cn(
                  "flex w-full items-center justify-between gap-3 rounded-md border border-transparent px-2 py-1.5 text-left transition-colors hover:bg-muted/50",
                  selectedRunId === run.id && "border-foreground/20 bg-muted/40",
                )}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <Badge
                      variant="outline"
                      className={cn(
                        "rounded-full border-transparent px-1.5 py-0 text-[10px] font-medium uppercase tracking-wider",
                        CONCLUSION_STYLES[lab] ?? "bg-muted text-muted-foreground",
                      )}
                    >
                      {lab}
                    </Badge>
                    <p className="truncate text-xs font-medium">{run.workflowName || run.name}</p>
                    <span className="font-mono text-[10px] text-muted-foreground">
                      #{run.runNumber}
                    </span>
                  </div>
                  <p className="truncate font-mono text-[10px] text-muted-foreground">
                    {run.headSha.slice(0, 8)} · {run.event} · {run.headBranch ?? ""}
                    {run.displayTitle ? ` · ${run.displayTitle}` : ""}
                  </p>
                </div>
                <p className="shrink-0 text-[10px] text-muted-foreground">
                  <RelativeTime iso={run.runStartedAt} />
                </p>
              </button>
            );
          })
        )}
      </CardContent>
    </Card>
  );
}
