"use client";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useOpsOverview } from "@/hooks/use-ops";
import { formatCents } from "@/lib/format";
import type { OpsHeartbeat } from "@/lib/analytics-api/types";
import { CompletenessCard } from "./completeness-card";
import { RelativeTime } from "./relative-time";
import { StatusBadge, type OpsStatus } from "./status-badge";

function toNumber(value: number | string | null | undefined) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function heartbeatStatus(heartbeat: OpsHeartbeat): OpsStatus {
  const age = toNumber(heartbeat.age_seconds);
  if (!heartbeat.last_seen_at || age > 120) {
    return "failed";
  }
  if (age > 30) {
    return "warning";
  }
  return "healthy";
}

function countStatus(count: number | string | null | undefined) {
  return toNumber(count) > 0 ? "warning" : "healthy";
}

export function SyncHealthTab() {
  const query = useOpsOverview();

  if (query.isLoading) {
    return <Skeleton className="h-[320px] w-full" />;
  }

  if (query.isError || !query.data) {
    return <p className="text-sm text-muted-foreground">Could not load sync health.</p>;
  }

  const { health, heartbeats, dataRanges, jobCounts, dirtyWindows } = query.data;
  // Defensive: an older deployed analytics-api (pre-reconBreaks) or a cached
  // payload may omit the field — treat absent as "no breaks" rather than crash.
  const reconBreaks = query.data.reconBreaks ?? [];

  return (
    <div className="space-y-4">
      <div className="grid gap-3 md:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Failed jobs</CardDescription>
            <CardTitle className="text-2xl tabular-nums">
              {toNumber(health?.failed_job_count).toLocaleString()}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <StatusBadge status={countStatus(health?.failed_job_count)} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Dirty windows</CardDescription>
            <CardTitle className="text-2xl tabular-nums">
              {toNumber(health?.dirty_window_backlog).toLocaleString()}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <StatusBadge status={countStatus(health?.dirty_window_backlog)} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Open repairs</CardDescription>
            <CardTitle className="text-2xl tabular-nums">
              {toNumber(health?.open_repair_count).toLocaleString()}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <StatusBadge status={countStatus(health?.open_repair_count)} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Recon breaks</CardDescription>
            <CardTitle className="text-2xl tabular-nums">
              {reconBreaks.length.toLocaleString()}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <StatusBadge status={countStatus(reconBreaks.length)} />
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base font-medium">Worker Heartbeats</CardTitle>
          <CardDescription>Last seen and current health for each pipeline worker.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {heartbeats.length === 0 ? (
            <p className="text-sm text-muted-foreground">No heartbeats reported.</p>
          ) : (
            heartbeats.map((heartbeat) => (
              <div
                key={`${heartbeat.component}-${heartbeat.instance_id ?? "unknown"}`}
                className="flex items-center justify-between gap-4 border-b border-card-border pb-2 last:border-0"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{heartbeat.component}</p>
                  <p className="truncate font-mono text-xs text-muted-foreground">
                    {heartbeat.instance_id ?? "no instance id"}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-3">
                  <span className="text-xs text-muted-foreground">
                    <RelativeTime iso={heartbeat.last_seen_at} />
                  </span>
                  <StatusBadge status={heartbeatStatus(heartbeat)} />
                </div>
              </div>
            ))
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base font-medium">Reconciliation Breaks</CardTitle>
          <CardDescription>
            Business days where mart totals diverged from raw Clover data and have not since
            reconciled clean. Each is queued for an automatic repair.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {reconBreaks.length === 0 ? (
            <p className="text-sm text-muted-foreground">No unresolved reconciliation breaks.</p>
          ) : (
            reconBreaks.map((breakRow) => (
              <div
                key={breakRow.business_date}
                className="flex items-center justify-between gap-4 border-b border-card-border pb-2 last:border-0"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium tabular-nums">
                    {breakRow.business_date}
                  </p>
                  <p className="truncate text-xs text-muted-foreground tabular-nums">
                    net sales Δ {formatCents(toNumber(breakRow.net_sales_delta_cents))} · orders Δ{" "}
                    {toNumber(breakRow.order_count_delta).toLocaleString()}
                  </p>
                </div>
                <StatusBadge status="warning" />
              </div>
            ))
          )}
        </CardContent>
      </Card>

      <CompletenessCard />

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base font-medium">Data Ranges</CardTitle>
            <CardDescription>Raw and mart coverage by timestamp.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {dataRanges.length === 0 ? (
              <p className="text-sm text-muted-foreground">No data ranges reported.</p>
            ) : (
              dataRanges.map((range) => (
                <div key={range.name} className="flex justify-between gap-4 text-sm">
                  <span className="font-mono text-xs text-muted-foreground">{range.name}</span>
                  <span className="text-right tabular-nums">
                    {toNumber(range.row_count).toLocaleString()} rows
                  </span>
                </div>
              ))
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base font-medium">Queues</CardTitle>
            <CardDescription>Job and dirty-window counts by status.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {[...jobCounts, ...dirtyWindows.map((row) => ({ ...row, job_type: "dirty_window" }))].length ===
            0 ? (
              <p className="text-sm text-muted-foreground">No queue counts reported.</p>
            ) : (
              [...jobCounts, ...dirtyWindows.map((row) => ({ ...row, job_type: "dirty_window" }))].map(
                (row) => (
                  <div
                    key={`${row.job_type}-${row.status}`}
                    className="flex items-center justify-between gap-4 text-sm"
                  >
                    <span className="truncate font-mono text-xs text-muted-foreground">
                      {row.job_type}
                    </span>
                    <span className="shrink-0 tabular-nums">
                      {row.status}: {toNumber(row.count).toLocaleString()}
                    </span>
                  </div>
                ),
              )
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
