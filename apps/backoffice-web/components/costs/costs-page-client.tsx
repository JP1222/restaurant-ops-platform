"use client";

import { TrendingDown, TrendingUp } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle
} from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  FoodCostCard,
  LaborCostCard,
  PrimeCostCard,
  YieldVarianceCard
} from "@/components/costs/cost-cards";
import { GrossMarginTrend } from "@/components/costs/gross-margin-trend";
import { LaborCostDialog } from "@/components/costs/labor-cost-dialog";
import { ProvenanceTable } from "@/components/costs/provenance-table";
import { useCosts } from "@/hooks/use-costs";
import { formatRate } from "@/lib/format";

const DAY_PRESETS = [7, 14, 30, 60, 90];
const DEFAULT_DAYS = 30;
const MIN_DAYS = 7;
const MAX_DAYS = 90;

function parseDays(searchParams: URLSearchParams): number {
  const raw = searchParams.get("days");
  if (raw == null) return DEFAULT_DAYS;
  const parsed = Number(raw);
  if (Number.isInteger(parsed) && parsed >= MIN_DAYS && parsed <= MAX_DAYS) {
    return parsed;
  }
  return DEFAULT_DAYS;
}

export function CostsPageClient() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const days = parseDays(searchParams ?? new URLSearchParams());

  const query = useCosts(days);
  const [laborOpen, setLaborOpen] = useState(false);

  function setDays(next: number) {
    const params = new URLSearchParams(searchParams?.toString() ?? "");
    if (next === DEFAULT_DAYS) params.delete("days");
    else params.set("days", String(next));
    const qs = params.toString();
    router.replace(qs ? `/costs?${qs}` : "/costs", { scroll: false });
  }

  const data = query.data;
  const grossMargin = data?.metrics.gross_margin_pct;
  const trend = data?.marginTrend ?? [];
  const trendPoints = trend.filter((p) => p.value != null);
  const delta =
    trendPoints.length >= 2
      ? (trendPoints[trendPoints.length - 1]!.value ?? 0) - (trendPoints[0]!.value ?? 0)
      : 0;
  const deltaUp = delta >= 0;

  return (
    <div className="mx-auto flex max-w-[1200px] flex-col gap-6 p-6">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Cost &amp; prime cost</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Food cost, margin &amp; prime economics over the last {days} days — every figure
            resolves through a registered metric.
          </p>
        </div>
        <Select value={String(days)} onValueChange={(value) => setDays(Number(value))}>
          <SelectTrigger className="w-[160px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {DAY_PRESETS.map((preset) => (
              <SelectItem key={preset} value={String(preset)}>
                Last {preset} days
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </header>

      {query.isLoading ? (
        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-[208px] w-full" />
            ))}
          </div>
          <Skeleton className="h-[360px] w-full" />
        </div>
      ) : query.isError ? (
        <p className="text-sm text-destructive">
          Could not load cost data:{" "}
          {query.error instanceof Error ? query.error.message : "unknown"}
        </p>
      ) : data ? (
        <>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <FoodCostCard
              foodCost={data.metrics.food_cost_pct}
              coverage={data.metrics.cost_coverage_pct}
            />
            <LaborCostCard
              labor={data.metrics.labor_cost_pct}
              onEdit={() => setLaborOpen(true)}
            />
            <PrimeCostCard
              foodCost={data.metrics.food_cost_pct}
              laborCost={data.metrics.labor_cost_pct}
              prime={data.metrics.prime_cost_pct}
              coverage={data.metrics.cost_coverage_pct}
            />
            <YieldVarianceCard
              yieldVariance={data.metrics.yield_variance_cents}
              actualCogs={data.metrics.actual_cogs_cents}
            />
          </div>

          <Card>
            <CardHeader>
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="flex flex-col gap-1.5">
                  <CardTitle className="text-base font-medium">Gross-margin trend</CardTitle>
                  <CardDescription>
                    (net sales − theoretical food cost) ÷ net sales, across the window.
                  </CardDescription>
                </div>
                <div className="flex items-end gap-4">
                  <div className="text-right">
                    <div
                      className="font-mono text-2xl font-semibold tabular-nums tracking-tight"
                      style={{ color: "var(--trend-up)" }}
                    >
                      {grossMargin?.value == null ? "—" : formatRate(grossMargin.value)}
                    </div>
                    <div className="text-[11px] text-muted-foreground">period margin</div>
                  </div>
                  <div className="text-right">
                    <div
                      className="inline-flex items-center gap-1 font-mono text-sm font-medium tabular-nums"
                      style={{ color: deltaUp ? "var(--trend-up)" : "var(--trend-down)" }}
                    >
                      {deltaUp ? (
                        <TrendingUp className="size-3.5" />
                      ) : (
                        <TrendingDown className="size-3.5" />
                      )}
                      {`${delta >= 0 ? "+" : ""}${(delta * 100).toFixed(1)} pts`}
                    </div>
                    <div className="text-[11px] text-muted-foreground">start → end</div>
                  </div>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              <GrossMarginTrend trend={trend} />
            </CardContent>
          </Card>

          <ProvenanceTable metrics={data.metrics} />
        </>
      ) : null}

      <LaborCostDialog open={laborOpen} onOpenChange={setLaborOpen} />
    </div>
  );
}
