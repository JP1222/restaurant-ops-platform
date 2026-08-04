"use client";

import { useState } from "react";
import { RotateCcw, TriangleAlert, Unlock } from "lucide-react";
import { toast } from "sonner";
import type { BackfillRequeueAction } from "@rop/contracts";
import type { OpsBackfillWindow } from "@/lib/analytics-api/types";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useOpsOverview, useRequeueBackfill } from "@/hooks/use-ops";
import { RelativeTime } from "./relative-time";
import { StatusBadge, type OpsStatus } from "./status-badge";

function backfillStatus(status: string) {
  if (status === "completed") {
    return "healthy";
  }
  if (status === "warning") {
    return "warning";
  }
  if (status === "failed" || status === "blocked") {
    return "failed";
  }
  if (status === "not_started" || status === "idle") {
    return "pending";
  }
  return "running";
}

// Distinct treatment per the verdict (P7): a parked window (auto-recovery
// exhausted) is the only one that truly needs a human, so it gets the red
// "failed" tone; everything else the scheduler still handles on its own.
function attentionBadge(window: OpsBackfillWindow): { tone: OpsStatus; label: string } {
  if (window.parked) {
    return { tone: "failed", label: "Parked" };
  }
  if (window.status === "blocked") {
    return { tone: "warning", label: "Blocked" };
  }
  if (window.status === "failed") {
    return { tone: "warning", label: "Retrying" };
  }
  return { tone: "warning", label: "Warning" };
}

const ATTENTION_VISIBLE = 12;

function isoDay(iso: string) {
  return iso.slice(0, 10);
}

const ACTION_COPY: Record<
  BackfillRequeueAction,
  { title: string; description: string; confirm: string }
> = {
  retry_failed_and_missing: {
    title: "Retry failed and blocked windows?",
    description:
      "Resets every failed or blocked historical window to pending. The scheduler reprocesses them one at a time during the next Clover export window. Completed windows are left untouched.",
    confirm: "Retry windows",
  },
  unblock: {
    title: "Unblock parked windows?",
    description:
      "Resets only blocked (parked) windows to pending so the scheduler retries them. Completed and cooling windows are left untouched.",
    confirm: "Unblock windows",
  },
};

export function BackfillTab() {
  const query = useOpsOverview();
  const requeue = useRequeueBackfill();
  const [pendingAction, setPendingAction] = useState<BackfillRequeueAction | null>(null);

  if (query.isLoading) {
    return <Skeleton className="h-[240px] w-full" />;
  }

  if (query.isError || !query.data) {
    return <p className="text-sm text-muted-foreground">Could not load backfill progress.</p>;
  }

  const backfill = query.data.historicalBackfill;
  const retryableWindows = backfill.failedWindows + backfill.blockedWindows;

  const runAction = (action: BackfillRequeueAction) => {
    requeue.mutate(
      { action, windowStart: null, windowEnd: null },
      {
        onSuccess: (result) => {
          toast.success(
            result.requeuedWindows > 0
              ? `Requeued ${result.requeuedWindows.toLocaleString()} window${result.requeuedWindows === 1 ? "" : "s"}`
              : "No matching windows to requeue",
          );
        },
        onError: (error) =>
          toast.error(error instanceof Error ? error.message : "Requeue failed"),
      },
    );
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle className="text-base font-medium">Historical Backfill</CardTitle>
            <CardDescription>
              {backfill.expectedWindows.toLocaleString()} expected windows,{" "}
              {backfill.completedWindows.toLocaleString()} completed.
            </CardDescription>
          </div>
          <StatusBadge
            status={backfillStatus(backfill.currentWindowStatus)}
            label={backfill.currentWindowStatus.replaceAll("_", " ")}
          />
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        {backfill.needsManualIntervention ? (
          <div className="flex items-start gap-2 rounded-md border border-[color:var(--destructive)]/30 bg-[color:var(--destructive)]/10 p-3 text-sm">
            <TriangleAlert className="mt-0.5 size-4 shrink-0 text-[color:var(--destructive)]" />
            <span>
              <span className="font-medium tabular-nums">{backfill.parkedWindows}</span> window
              {backfill.parkedWindows === 1 ? "" : "s"} parked — auto-recovery is exhausted and the
              scheduler will not retry them. Use <span className="font-medium">Retry</span> or{" "}
              <span className="font-medium">Unblock</span> below to resume.
            </span>
          </div>
        ) : null}

        <div className="space-y-2">
          <div className="flex justify-between text-sm">
            <span className="text-muted-foreground">Progress</span>
            <span className="font-medium tabular-nums">{backfill.progressPct.toFixed(1)}%</span>
          </div>
          <Progress value={backfill.progressPct} className="h-2" />
        </div>

        <div className="grid gap-3 text-sm md:grid-cols-4">
          <div>
            <p className="text-muted-foreground">Failed</p>
            <p className="text-lg font-medium tabular-nums">{backfill.failedWindows}</p>
          </div>
          <div>
            <p className="text-muted-foreground">Blocked</p>
            <p className="text-lg font-medium tabular-nums">{backfill.blockedWindows}</p>
          </div>
          <div>
            <p className="text-muted-foreground">Last completed</p>
            <p className="font-medium">
              <RelativeTime iso={backfill.lastCompletedAt} />
            </p>
          </div>
          <div>
            <p className="text-muted-foreground">Next window</p>
            <p className="font-medium">
              <RelativeTime iso={backfill.nextHistoricalWindowAt} />
            </p>
          </div>
        </div>

        <div className="grid gap-3 text-sm md:grid-cols-4">
          <div>
            <p className="text-muted-foreground">Running</p>
            <p className="text-lg font-medium tabular-nums">
              {backfill.runningWindows} / {backfill.maxConcurrentWindows}
            </p>
          </div>
          <div>
            <p className="text-muted-foreground">Done (24h)</p>
            <p className="text-lg font-medium tabular-nums">{backfill.windowsCompletedLast24h}</p>
          </div>
          <div>
            <p className="text-muted-foreground">Est. complete</p>
            <p className="font-medium">
              <RelativeTime iso={backfill.estimatedCompletionAt} />
            </p>
          </div>
          <div>
            <p className="text-muted-foreground">Rows loaded</p>
            <p className="text-lg font-medium tabular-nums">
              {backfill.rowsWrittenTotal.toLocaleString()}
            </p>
          </div>
        </div>

        {backfill.currentWindowStart && backfill.currentWindowEnd ? (
          <div className="rounded-md border border-card-border bg-muted/30 p-3 text-sm">
            <p className="text-muted-foreground">Current window</p>
            <p className="font-mono text-xs tabular-nums">
              {backfill.currentWindowStart} to {backfill.currentWindowEnd}
            </p>
          </div>
        ) : null}

        {backfill.lastError ? (
          <p className="text-sm text-[color:var(--destructive)]">{backfill.lastError}</p>
        ) : null}

        {backfill.attentionWindows.length > 0 ? (
          <div className="space-y-2">
            <p className="text-sm text-muted-foreground">Windows needing attention</p>
            <div className="rounded-md border border-card-border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Window</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Fails</TableHead>
                    <TableHead>Last error</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {backfill.attentionWindows.slice(0, ATTENTION_VISIBLE).map((window) => {
                    const badge = attentionBadge(window);
                    return (
                      <TableRow key={`${window.windowStart}|${window.windowEnd}`}>
                        <TableCell className="font-mono text-xs tabular-nums whitespace-nowrap">
                          {isoDay(window.windowStart)} → {isoDay(window.windowEnd)}
                        </TableCell>
                        <TableCell>
                          <StatusBadge status={badge.tone} label={badge.label} />
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{window.failureCount}</TableCell>
                        <TableCell className="max-w-[18rem] truncate text-xs text-muted-foreground">
                          {window.lastError ?? "—"}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
            {backfill.attentionWindows.length > ATTENTION_VISIBLE ? (
              <p className="text-xs text-muted-foreground">
                Showing {ATTENTION_VISIBLE} of {backfill.attentionWindows.length.toLocaleString()}.
              </p>
            ) : null}
          </div>
        ) : null}

        <div className="flex flex-wrap gap-2 border-t border-card-border pt-4">
          <Button
            variant="outline"
            size="sm"
            disabled={requeue.isPending || retryableWindows === 0}
            onClick={() => setPendingAction("retry_failed_and_missing")}
          >
            <RotateCcw className="size-4" />
            Retry failed + blocked
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={requeue.isPending || backfill.blockedWindows === 0}
            onClick={() => setPendingAction("unblock")}
          >
            <Unlock className="size-4" />
            Unblock parked
          </Button>
        </div>
      </CardContent>

      <AlertDialog
        open={pendingAction !== null}
        onOpenChange={(open) => {
          if (!open) setPendingAction(null);
        }}
      >
        <AlertDialogContent>
          {pendingAction ? (
            <>
              <AlertDialogHeader>
                <AlertDialogTitle>{ACTION_COPY[pendingAction].title}</AlertDialogTitle>
                <AlertDialogDescription>
                  {ACTION_COPY[pendingAction].description}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel disabled={requeue.isPending}>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  disabled={requeue.isPending}
                  onClick={() => runAction(pendingAction)}
                >
                  {ACTION_COPY[pendingAction].confirm}
                </AlertDialogAction>
              </AlertDialogFooter>
            </>
          ) : null}
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
