import { History } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import type { WorkflowRunSummary } from "@/lib/github";
import { RelativeTime } from "@/components/ops/relative-time";
import { toneClass, type Tone } from "./tokens";

const BUILD_WORKFLOW_NAME = "Build and push images (GHCR)";

function result(run: WorkflowRunSummary): { tone: Tone; label: string } {
  if (run.status === "in_progress") return { tone: "blue", label: "running" };
  if (run.status === "queued") return { tone: "muted", label: "queued" };
  if (run.conclusion === "success") return { tone: "accent", label: "success" };
  if (run.conclusion === "failure") return { tone: "danger", label: "failed" };
  return { tone: "muted", label: run.conclusion ?? run.status };
}

// Audit view of who deployed what, when — derived from build-images
// workflow_dispatch runs. (Scope/skip inputs aren't exposed by the runs API; a
// dedicated audit table that captures them is a follow-up.)
export function DeployHistoryCard({
  runs,
  isLoading,
  isError,
}: {
  runs: WorkflowRunSummary[] | undefined;
  isLoading: boolean;
  isError: boolean;
}) {
  const dispatches = (runs ?? [])
    .filter(
      (r) =>
        (r.workflowName === BUILD_WORKFLOW_NAME || r.name === BUILD_WORKFLOW_NAME) &&
        r.event === "workflow_dispatch",
    )
    .slice(0, 8);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base font-medium">
          <History className="text-muted-foreground size-4" />
          Deploy history
        </CardTitle>
        <CardDescription>Who deployed what, when — from GitHub dispatch history.</CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
          </div>
        ) : isError ? (
          <p className="text-muted-foreground text-sm">Could not load deploy history.</p>
        ) : dispatches.length === 0 ? (
          <p className="text-muted-foreground text-sm">No manual deploys yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Result</TableHead>
                  <TableHead>Actor</TableHead>
                  <TableHead>Commit</TableHead>
                  <TableHead>When</TableHead>
                  <TableHead className="text-right">Run</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {dispatches.map((run) => {
                  const r = result(run);
                  return (
                    <TableRow key={run.id}>
                      <TableCell>
                        <Badge
                          variant="outline"
                          className={cn("text-[10px] uppercase", toneClass[r.tone])}
                        >
                          {r.label}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-xs font-medium">
                        {run.actorLogin ?? "—"}
                      </TableCell>
                      <TableCell className="text-muted-foreground font-mono text-[11px]">
                        {run.headSha.slice(0, 7)}
                      </TableCell>
                      <TableCell className="text-muted-foreground text-xs whitespace-nowrap">
                        <RelativeTime iso={run.runStartedAt} />
                      </TableCell>
                      <TableCell className="text-right">
                        <a
                          href={run.htmlUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="text-[color:var(--accent)] font-mono text-[11px] hover:underline"
                        >
                          #{run.runNumber}
                        </a>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
