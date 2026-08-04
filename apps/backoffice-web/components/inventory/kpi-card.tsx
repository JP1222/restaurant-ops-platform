import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";

import { cn } from "@/lib/utils";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle
} from "@/components/ui/card";

export interface KpiCardProps {
  label: string;
  value: string;
  hint?: string;
  deltaPct?: number | null;
  comparison?: string;
  /**
   * When set to "inverse", an upward trend is bad (cost/waste rising) and
   * gets the trend-down color, and vice versa.
   */
  accent?: "default" | "inverse";
}

export function KpiCard({
  label,
  value,
  hint,
  deltaPct = null,
  comparison,
  accent = "default"
}: KpiCardProps) {
  const dir = deltaPct == null ? "flat" : deltaPct > 0 ? "up" : deltaPct < 0 ? "down" : "flat";
  const Arrow = dir === "up" ? ArrowUpRight : dir === "down" ? ArrowDownRight : Minus;
  const goodUp = accent !== "inverse";

  const tone =
    dir === "flat"
      ? "text-muted-foreground"
      : (dir === "up") === goodUp
        ? "text-trend-up"
        : "text-trend-down";

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardDescription>{label}</CardDescription>
        <CardTitle className="mt-1 text-3xl font-medium tracking-tight tabular-nums">
          {value}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        <div className={cn("flex items-center gap-1 text-sm", tone)}>
          <Arrow className="size-4" />
          {deltaPct == null ? (
            <span className="text-muted-foreground">No comparison</span>
          ) : (
            <>
              <span className="font-mono font-medium tabular-nums">
                {deltaPct > 0 ? "+" : ""}
                {deltaPct.toFixed(1)}%
              </span>
              {comparison ? (
                <span className="text-muted-foreground">{comparison}</span>
              ) : null}
            </>
          )}
        </div>
        {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
      </CardContent>
    </Card>
  );
}
