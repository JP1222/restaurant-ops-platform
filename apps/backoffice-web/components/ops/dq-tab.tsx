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
import type { OpsDataQualityCheck } from "@/lib/analytics-api/types";
import { RelativeTime } from "./relative-time";
import { StatusBadge, type OpsStatus } from "./status-badge";

function statusForCheck(check: OpsDataQualityCheck): OpsStatus {
  if (check.status === "passed" || check.status === "pass") {
    return "healthy";
  }
  if (check.severity === "critical" || check.severity === "error") {
    return "failed";
  }
  if (check.status === "failed" || check.status === "warn" || check.status === "warning") {
    return "warning";
  }
  return "unknown";
}

function detailsText(details: OpsDataQualityCheck["details"]) {
  if (!details || Object.keys(details).length === 0) {
    return null;
  }

  return JSON.stringify(details);
}

export function DataQualityTab() {
  const query = useOpsJobs();

  if (query.isLoading) {
    return <Skeleton className="h-[300px] w-full" />;
  }

  if (query.isError || !query.data) {
    return <p className="text-sm text-muted-foreground">Could not load DQ checks.</p>;
  }

  const checks = query.data.dataQualityChecks;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base font-medium">Data Quality</CardTitle>
        <CardDescription>Latest audit checks recorded by the pipeline.</CardDescription>
      </CardHeader>
      <CardContent className="max-h-[500px] space-y-2 overflow-y-auto pr-1">
        {checks.length === 0 ? (
          <p className="text-sm text-muted-foreground">No data quality checks recorded.</p>
        ) : (
          checks.map((check) => (
            <div
              key={`${check.check_name}-${check.created_at}`}
              className="flex items-center justify-between gap-4 border-b border-card-border pb-2 last:border-0"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium">{check.check_name}</span>
                  <StatusBadge status={statusForCheck(check)} label={check.status} />
                </div>
                {check.severity ? (
                  <p className="text-xs text-muted-foreground">Severity: {check.severity}</p>
                ) : null}
                {detailsText(check.details) ? (
                  <p className="truncate font-mono text-xs text-muted-foreground">
                    {detailsText(check.details)}
                  </p>
                ) : null}
              </div>
              <span className="shrink-0 text-xs text-muted-foreground">
                <RelativeTime iso={check.created_at} />
              </span>
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}
