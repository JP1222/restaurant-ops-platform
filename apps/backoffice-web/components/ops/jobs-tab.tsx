"use client";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useOpsJobs } from "@/hooks/use-ops";
import type { OpsJob } from "@/lib/analytics-api/types";
import { RelativeTime } from "./relative-time";
import { StatusBadge, type OpsStatus } from "./status-badge";

const STATUS_MAP: Record<string, OpsStatus> = {
  completed: "healthy",
  succeeded: "healthy",
  failed: "failed",
  pending: "pending",
  running: "running",
  in_progress: "running",
};

function startedAt(job: OpsJob) {
  return job.started_at ?? job.created_at ?? job.run_after ?? null;
}

export function JobsTab() {
  const query = useOpsJobs();

  if (query.isLoading) {
    return <Skeleton className="h-[360px] w-full" />;
  }

  if (query.isError || !query.data) {
    return <p className="text-sm text-muted-foreground">Could not load jobs.</p>;
  }

  const recent = query.data.recentJobs;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base font-medium">Recent Jobs</CardTitle>
        <CardDescription>Last 100 scheduler jobs, newest first.</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="max-h-[500px] space-y-1 overflow-y-auto pr-1">
          {recent.length === 0 ? (
            <p className="text-sm text-muted-foreground">No recent jobs.</p>
          ) : (
            recent.map((job, index) => (
              <div
                key={`${job.job_type}-${job.created_at ?? job.started_at ?? index}`}
                className="flex items-center justify-between gap-4 border-b border-card-border pb-2 last:border-0"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium">{job.job_type}</span>
                    <StatusBadge status={STATUS_MAP[job.status] ?? "unknown"} label={job.status} />
                  </div>
                  <p className="font-mono text-xs text-muted-foreground tabular-nums">
                    attempt {job.attempt_count}/{job.max_attempts}
                  </p>
                  {job.last_error ? (
                    <p className="truncate text-xs text-[color:var(--destructive)]">
                      {job.last_error}
                    </p>
                  ) : null}
                </div>
                <div className="shrink-0 text-right text-xs text-muted-foreground">
                  <RelativeTime iso={startedAt(job)} />
                </div>
              </div>
            ))
          )}
        </div>
      </CardContent>
    </Card>
  );
}
