"use client";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useOpsCompleteness } from "@/hooks/use-ops";
import type { CompletenessStatus } from "@/lib/analytics-api/types";
import { CompletenessHeatmap, STATUS_STYLE } from "./completeness-heatmap";

const LEGEND: CompletenessStatus[] = ["present", "missing", "warming_up", "closed"];

export function CompletenessCard() {
  const query = useOpsCompleteness();

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base font-medium">Data Completeness</CardTitle>
        <CardDescription>
          Calendar coverage by business day. A red cell is an open day with no ingested data — a
          lost/missing day, not a closed one.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {query.isLoading ? (
          <Skeleton className="h-[110px] w-full" />
        ) : query.isError || !query.data ? (
          <p className="text-sm text-muted-foreground">Could not load completeness.</p>
        ) : (
          <>
            <CompletenessHeatmap days={query.data.days} />

            <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-muted-foreground">
              {LEGEND.map((status) => (
                <span key={status} className="flex items-center gap-1.5">
                  <span
                    className="size-3 rounded-[2px]"
                    style={{ backgroundColor: STATUS_STYLE[status].bg }}
                  />
                  {STATUS_STYLE[status].label}
                </span>
              ))}
            </div>

            <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
              <span className="tabular-nums">
                {query.data.summary.missing ?? 0} missing in window
              </span>
              {query.data.olderMissing > 0 ? (
                <span className="tabular-nums text-muted-foreground">
                  +{query.data.olderMissing} older hole{query.data.olderMissing === 1 ? "" : "s"}{" "}
                  before this window
                </span>
              ) : null}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
