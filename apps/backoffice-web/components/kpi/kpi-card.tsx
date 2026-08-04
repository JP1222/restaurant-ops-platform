"use client";

import type { ReactNode } from "react";
import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { formatPercent } from "@/lib/format";
import { cn } from "@/lib/utils";

export interface KpiCardProps {
  label: string;
  value: string;
  comparisonLabel: string;
  wowPct: number | null;
  sparkline?: ReactNode;
  hint?: string;
}

export function KpiCard({ label, value, comparisonLabel, wowPct, sparkline, hint }: KpiCardProps) {
  const direction = wowPct === null ? "neutral" : wowPct > 0 ? "up" : wowPct < 0 ? "down" : "flat";
  const Icon = direction === "up" ? ArrowUpRight : direction === "down" ? ArrowDownRight : Minus;

  const trendColor =
    direction === "neutral" || direction === "flat"
      ? "text-muted-foreground"
      : direction === "up"
        ? "text-[color:var(--trend-up)]"
        : "text-[color:var(--trend-down)]";

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardDescription>{label}</CardDescription>
        <CardTitle className="text-3xl font-medium tracking-tight tabular-nums">{value}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        <div className={cn("flex items-center gap-1 text-sm", trendColor)}>
          <Icon className="size-4" />
          {wowPct === null ? (
            <span className="text-muted-foreground">No comparison</span>
          ) : (
            <>
              <span className="font-medium tabular-nums">{formatPercent(wowPct)}</span>
              <span className="text-muted-foreground">{comparisonLabel}</span>
            </>
          )}
        </div>
        {hint ? <p className="text-muted-foreground text-xs">{hint}</p> : null}
        {sparkline ? <div className="mt-2 h-12">{sparkline}</div> : null}
      </CardContent>
    </Card>
  );
}

export function KpiCardSkeleton() {
  return (
    <Card>
      <CardHeader className="pb-2">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="mt-2 h-9 w-32" />
      </CardHeader>
      <CardContent className="space-y-2">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-3 w-20" />
      </CardContent>
    </Card>
  );
}
