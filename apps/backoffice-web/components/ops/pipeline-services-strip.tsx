"use client";

import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { PipelineServicesResponse } from "@/hooks/use-pipeline";
import { Skeleton } from "@/components/ui/skeleton";

interface Props {
  data: PipelineServicesResponse | undefined;
  isLoading: boolean;
  isError: boolean;
}

const STATUS_STYLES: Record<string, string> = {
  healthy: "bg-[color:var(--accent)]/10 text-[color:var(--accent)]",
  unhealthy: "bg-[color:var(--destructive)]/10 text-[color:var(--destructive)]",
  unknown: "bg-muted text-muted-foreground",
};

export function PipelineServicesStrip({ data, isLoading, isError }: Props) {
  if (isLoading) {
    return (
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <Skeleton className="h-[88px] w-full" />
        <Skeleton className="h-[88px] w-full" />
        <Skeleton className="h-[88px] w-full" />
      </div>
    );
  }
  if (isError || !data) {
    return (
      <Card>
        <CardContent className="py-4 text-sm text-muted-foreground">
          Could not probe services.
        </CardContent>
      </Card>
    );
  }
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {data.services.map((svc) => (
        <Card key={svc.app}>
          <CardContent className="space-y-2 py-4">
            <div className="flex items-center justify-between gap-2">
              <p className="truncate text-sm font-medium">{svc.label}</p>
              <span
                className={cn(
                  "rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider",
                  STATUS_STYLES[svc.status],
                )}
              >
                {svc.status}
              </span>
            </div>
            <div className="flex items-baseline gap-4">
              <span className="text-2xl font-medium tabular-nums">
                {svc.latencyMs != null ? `${svc.latencyMs}ms` : "—"}
              </span>
              <span className="text-xs font-mono text-muted-foreground">
                {svc.httpStatus != null ? `HTTP ${svc.httpStatus}` : svc.error ?? ""}
              </span>
            </div>
            <p className="truncate font-mono text-[10px] text-muted-foreground/70">{svc.url}</p>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
