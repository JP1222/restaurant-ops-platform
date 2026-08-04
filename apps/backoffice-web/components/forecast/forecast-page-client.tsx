"use client";

import { useMemo, useState } from "react";
import { RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { Area, CartesianGrid, ComposedChart, Line, XAxis, YAxis } from "recharts";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ChartContainer, ChartTooltip, type ChartConfig } from "@/components/ui/chart";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useForecast, useRunForecast } from "@/hooks/use-forecast";
import { formatCents, formatCount, formatRate } from "@/lib/format";

type Metric = "net_sales_cents" | "order_count";

const METRIC_LABELS: Record<Metric, string> = {
  net_sales_cents: "Net Sales",
  order_count: "Orders",
};

const chartConfig = {
  value: { label: "Forecast", color: "var(--chart-1)" },
} satisfies ChartConfig;

function formatMetric(metric: Metric, value: number): string {
  return metric === "net_sales_cents" ? formatCents(value) : formatCount(Math.round(value));
}

function yAxisTick(metric: Metric, value: number): string {
  return metric === "net_sales_cents" ? `$${(value / 100).toFixed(0)}` : formatCount(Math.round(value));
}

interface ForecastTooltipProps {
  active?: boolean;
  label?: string | number;
  payload?: { payload?: { target_date: string; value: number; band: [number, number] } }[];
  metric: Metric;
}

function ForecastTooltip({ active, label, payload, metric }: ForecastTooltipProps) {
  const point = payload?.find((item) => item.payload)?.payload;
  if (!active || !point) return null;
  return (
    <div className="bg-background grid min-w-44 gap-2 rounded-lg border px-3 py-2 text-xs shadow-xl">
      <div className="font-medium">{label}</div>
      <div className="grid gap-1.5">
        <div className="flex items-center justify-between gap-6">
          <span className="text-muted-foreground">Forecast</span>
          <span className="font-mono font-medium tabular-nums">{formatMetric(metric, point.value)}</span>
        </div>
        <div className="flex items-center justify-between gap-6">
          <span className="text-muted-foreground">80% range</span>
          <span className="font-mono tabular-nums text-muted-foreground">
            {formatMetric(metric, point.band[0])} – {formatMetric(metric, point.band[1])}
          </span>
        </div>
      </div>
    </div>
  );
}

export function ForecastPageClient() {
  const [metric, setMetric] = useState<Metric>("net_sales_cents");
  const query = useForecast();
  const run = useRunForecast();

  const data = query.data;
  const chartData = useMemo(() => {
    if (!data) return [];
    return data.points
      .filter((point) => point.metric === metric)
      .map((point) => ({
        target_date: point.target_date,
        value: point.value,
        band: [point.lo, point.hi] as [number, number],
      }));
  }, [data, metric]);

  const backtest = data?.backtest.find((b) => b.metric === metric);
  const hasForecast = chartData.length > 0;

  async function refresh() {
    try {
      await run.mutateAsync();
      toast.success("Forecast updated");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not refresh the forecast");
    }
  }

  return (
    <div className="mx-auto flex max-w-[1200px] flex-col gap-6 p-6">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Forecast</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Demand for the next two weeks from a weekday-seasonal model, with an 80%
            prediction band. Accuracy is our own held-out backtest — an estimate, not a promise.
          </p>
        </div>
        <div className="flex items-center gap-3">
          {data?.generated_at ? (
            <span className="text-[11px] text-muted-foreground">
              Updated {data.generated_at.slice(0, 16).replace("T", " ")}
            </span>
          ) : null}
          <Button variant="outline" size="sm" onClick={refresh} disabled={run.isPending}>
            <RefreshCw className={run.isPending ? "size-4 animate-spin" : "size-4"} />
            {run.isPending ? "Refreshing" : "Refresh"}
          </Button>
        </div>
      </header>

      <Tabs value={metric} onValueChange={(value) => setMetric(value as Metric)}>
        <TabsList>
          <TabsTrigger value="net_sales_cents">Net Sales</TabsTrigger>
          <TabsTrigger value="order_count">Orders</TabsTrigger>
        </TabsList>
      </Tabs>

      {query.isLoading ? (
        <Skeleton className="h-[360px] w-full" />
      ) : query.isError ? (
        <p className="text-sm text-destructive">
          Could not load the forecast:{" "}
          {query.error instanceof Error ? query.error.message : "unknown"}
        </p>
      ) : hasForecast ? (
        <>
          <Card>
            <CardHeader>
              <CardTitle className="text-base font-medium">{METRIC_LABELS[metric]} forecast</CardTitle>
              <CardDescription>Point forecast (line) with the 80% prediction band (shaded).</CardDescription>
            </CardHeader>
            <CardContent>
              <ChartContainer config={chartConfig} className="h-[340px] w-full">
                <ComposedChart accessibilityLayer data={chartData}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} />
                  <XAxis
                    dataKey="target_date"
                    axisLine={false}
                    tickLine={false}
                    tickFormatter={(value: string) => value.slice(5)}
                  />
                  <YAxis
                    axisLine={false}
                    tickLine={false}
                    width={70}
                    tickFormatter={(value: number) => yAxisTick(metric, value)}
                  />
                  <ChartTooltip content={<ForecastTooltip metric={metric} />} />
                  <Area
                    dataKey="band"
                    type="monotone"
                    stroke="none"
                    fill="var(--color-value)"
                    fillOpacity={0.15}
                    isAnimationActive={false}
                  />
                  <Line
                    dataKey="value"
                    type="monotone"
                    dot={false}
                    isAnimationActive={false}
                    stroke="var(--color-value)"
                    strokeWidth={2.5}
                  />
                </ComposedChart>
              </ChartContainer>
            </CardContent>
          </Card>

          <BacktestCard metric={metric} backtest={backtest} />
        </>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle className="text-base font-medium">No forecast yet</CardTitle>
            <CardDescription>
              Generate the first forecast from the store&apos;s sales history. It needs a few
              weeks of data to learn the weekday pattern.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button onClick={refresh} disabled={run.isPending}>
              <RefreshCw className={run.isPending ? "size-4 animate-spin" : "size-4"} />
              {run.isPending ? "Generating" : "Generate forecast"}
            </Button>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function BacktestCard({
  metric,
  backtest,
}: {
  metric: Metric;
  backtest: { mape: number | null; wape: number | null; sample_count: number } | undefined;
}) {
  const hasScore = backtest != null && backtest.mape != null;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base font-medium">Forecast vs actual (backtest)</CardTitle>
        <CardDescription>
          How this model scored on the most recent held-out history for {METRIC_LABELS[metric]} —
          our own measure, never a vendor claim. Lower is better.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {hasScore ? (
          <div className="flex flex-wrap gap-8">
            <Stat label="MAPE" value={formatRate(backtest!.mape!)} hint="mean abs % error" />
            <Stat
              label="WAPE"
              value={backtest!.wape == null ? "—" : formatRate(backtest!.wape)}
              hint="weighted abs % error"
            />
            <Stat label="Held-out days" value={formatCount(backtest!.sample_count)} hint="scored window" />
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            Not enough history to backtest yet — keep syncing sales and check back.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</span>
      <span className="font-mono text-2xl font-semibold tabular-nums tracking-tight">{value}</span>
      <span className="text-[11px] text-muted-foreground">{hint}</span>
    </div>
  );
}
