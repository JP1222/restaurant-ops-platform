"use client";

import { CircleDot, History, Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle
} from "@/components/ui/card";
import { formatCents } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { InventoryCountRecord, InventoryDataset } from "@rop/contracts";

import { ToneBadge } from "./status-badge";

function CountCard({ count }: { count: InventoryCountRecord }) {
  return (
    <div className="rounded-lg border border-border bg-card p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium">{count.scope}</div>
          <div className="mt-0.5 text-xs text-muted-foreground">
            <span className="font-mono tabular-nums">{count.id}</span> · {count.who}
          </div>
        </div>
        <ToneBadge tone="outline" dot>
          Closed
        </ToneBadge>
      </div>
      <div className="mt-3 grid grid-cols-3 gap-2 text-xs">
        <div>
          <div className="text-muted-foreground">Items</div>
          <div className="mt-0.5 font-mono font-medium tabular-nums">{count.items}</div>
        </div>
        <div>
          <div className="text-muted-foreground">Variance</div>
          <div
            className={cn(
              "mt-0.5 font-mono font-medium tabular-nums",
              count.variance_pct != null && count.variance_pct < -2
                ? "text-trend-down"
                : count.variance_pct != null && count.variance_pct > 0
                  ? "text-trend-up"
                  : ""
            )}
          >
            {count.variance_pct == null
              ? "—"
              : `${count.variance_pct > 0 ? "+" : ""}${count.variance_pct.toFixed(1)}%`}
          </div>
        </div>
        <div>
          <div className="text-muted-foreground">$ impact</div>
          <div
            className={cn(
              "mt-0.5 font-mono font-medium tabular-nums",
              count.variance_cents != null && count.variance_cents < 0
                ? "text-trend-down"
                : "text-trend-up"
            )}
          >
            {count.variance_cents == null
              ? "—"
              : `${count.variance_cents < 0 ? "-" : "+"}${formatCents(
                  Math.abs(count.variance_cents)
                )}`}
          </div>
        </div>
      </div>
    </div>
  );
}

export interface CountsTabProps {
  data: InventoryDataset;
  mobile: boolean;
  onStartCount: () => void;
}

export function CountsTab({ data, mobile, onStartCount }: CountsTabProps) {
  const inProgress = data.counts.find((c) => c.status === "in-progress");
  const closed = data.counts.filter((c) => c.status === "closed");

  return (
    <div className="space-y-4">
      {inProgress && (
        <Card className="border-accent/30 bg-trend-up-bg/30">
          <CardHeader>
            <div className="flex items-start gap-3">
              <div className="flex size-9 flex-none items-center justify-center rounded-md bg-accent/15">
                <CircleDot className="size-4 text-accent" />
              </div>
              <div className="flex-1">
                <CardTitle>Count in progress · {inProgress.scope}</CardTitle>
                <CardDescription>
                  Started by {inProgress.who} on{" "}
                  <span className="font-mono tabular-nums">{inProgress.date}</span> ·{" "}
                  <span className="font-mono tabular-nums">{inProgress.items}</span> items in
                  scope
                </CardDescription>
              </div>
              <Button size={mobile ? "lg" : "default"} onClick={onStartCount}>
                Resume
              </Button>
            </div>
          </CardHeader>
          {/* No counted / elapsed / variance readout here on purpose. An in-progress
              InventoryCountRecord carries none of them: counted-so-far and the elapsed
              timer are ephemeral client state in CountModeModal, and variance_pct /
              variance_cents stay null until the count is submitted (closed). Don't
              reintroduce them as placeholder constants — the live view is the count
              screen, reached via Resume. */}
          <CardContent className="pt-0">
            <p className="text-sm text-muted-foreground">
              Item-by-item progress, elapsed time, and running variance show in the count
              screen while you work. Tap Resume to continue or review.
            </p>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0">
              <CardTitle>Recent counts</CardTitle>
              <CardDescription>
                Variance = counted − theoretical, in cost dollars.
              </CardDescription>
            </div>
            <div className="flex flex-none items-center gap-2">
              <Button size="sm" variant="outline">
                <History className="size-3.5" />
                {mobile ? "" : "History"}
              </Button>
              <Button size="sm" onClick={onStartCount}>
                <Plus className="size-3.5" />
                {mobile ? "Start" : "Start count"}
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className={mobile ? "px-4 pb-4" : undefined}>
          {closed.length === 0 ? (
            <p className="py-4 text-sm text-muted-foreground">
              No counts recorded yet. Start a count to build variance history.
            </p>
          ) : mobile ? (
            <div className="space-y-2">
              {closed.map((c) => (
                <CountCard key={c.id} count={c} />
              ))}
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th className="py-2 pr-4 font-medium">Count</th>
                  <th className="py-2 pr-4 font-medium">Scope</th>
                  <th className="py-2 pr-4 font-medium">Counter</th>
                  <th className="py-2 pr-4 text-right font-medium">Items</th>
                  <th className="py-2 pr-4 text-right font-medium">Variance</th>
                  <th className="py-2 pr-4 text-right font-medium">$ impact</th>
                  <th className="py-2 pl-4 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {closed.map((c) => (
                  <tr
                    key={c.id}
                    className="border-b border-border last:border-0 hover:bg-secondary/40"
                  >
                    <td className="py-3 pr-4 font-mono text-xs tabular-nums">{c.id}</td>
                    <td className="py-3 pr-4">{c.scope}</td>
                    <td className="py-3 pr-4 text-muted-foreground">{c.who}</td>
                    <td className="py-3 pr-4 text-right font-mono tabular-nums">{c.items}</td>
                    <td
                      className={cn(
                        "py-3 pr-4 text-right font-mono tabular-nums",
                        c.variance_pct != null && c.variance_pct < -2
                          ? "text-trend-down"
                          : c.variance_pct != null && c.variance_pct > 0
                            ? "text-trend-up"
                            : "text-muted-foreground"
                      )}
                    >
                      {c.variance_pct == null
                        ? "—"
                        : `${c.variance_pct > 0 ? "+" : ""}${c.variance_pct.toFixed(1)}%`}
                    </td>
                    <td
                      className={cn(
                        "py-3 pr-4 text-right font-mono tabular-nums",
                        c.variance_cents != null && c.variance_cents < 0
                          ? "text-trend-down"
                          : "text-trend-up"
                      )}
                    >
                      {c.variance_cents == null
                        ? "—"
                        : `${c.variance_cents < 0 ? "-" : "+"}${formatCents(
                            Math.abs(c.variance_cents)
                          )}`}
                    </td>
                    <td className="py-3 pl-4">
                      <ToneBadge tone="outline" dot>
                        Closed
                      </ToneBadge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
