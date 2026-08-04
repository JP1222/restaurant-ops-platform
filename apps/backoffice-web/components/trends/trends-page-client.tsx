"use client";

import { useEffect, useMemo } from "react";
import { AlertCircle, Download } from "lucide-react";
import { DateTime } from "luxon";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts";
import { CalendarHeatmap, CalendarHeatmapSkeleton } from "@/components/trends/calendar-heatmap";
import { DateRangeButton } from "@/components/trends/date-range-button";
import { SegmentBreakdown } from "@/components/trends/segment-breakdown";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ChartContainer, ChartTooltip, type ChartConfig } from "@/components/ui/chart";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useTrends } from "@/hooks/use-trends";
import { downloadTrendsCsv } from "@/lib/trends/export-csv";
import type { TrendMetric } from "@/lib/analytics-api/trends-transform";
import { formatCents, formatCount, formatRate } from "@/lib/format";
import {
  parseTrendsFilters,
  serializeTrendsFilters,
  type TrendsFilters,
} from "@/lib/trends/url-state";
import { useAiAssistantStore } from "@/stores/ai-assistant";

const METRIC_LABELS: Record<TrendMetric, string> = {
  net_sales: "Net Sales",
  orders: "Orders",
  avg_ticket: "Avg Ticket",
  refund_rate: "Refund Rate",
  discounts: "Discounts",
};

interface TooltipPayloadItem {
  payload?: {
    bucket_start: string;
    value: number;
    order_count: number;
    net_sales_cents: number;
  };
}

interface TrendsTooltipProps {
  active?: boolean;
  label?: string | number;
  payload?: TooltipPayloadItem[];
  metric: TrendMetric;
}

const chartConfig = {
  value: {
    label: "Value",
    color: "var(--chart-1)",
  },
} satisfies ChartConfig;

const STORE_TZ = "America/Chicago";

function formatMetricValue(value: number, metric: TrendMetric): string {
  if (metric === "net_sales" || metric === "avg_ticket" || metric === "discounts")
    return formatCents(value);
  if (metric === "orders") return formatCount(value);
  return formatRate(value);
}

function yAxisTick(value: number, metric: TrendMetric): string {
  if (metric === "net_sales" || metric === "avg_ticket" || metric === "discounts")
    return `$${(value / 100).toFixed(0)}`;
  if (metric === "orders") return formatCount(value);
  return `${(value * 100).toFixed(1)}%`;
}

function TrendsTooltip({ active, label, payload, metric }: TrendsTooltipProps) {
  const point = payload?.find((item) => item.payload)?.payload;

  if (!active || !point) return null;

  return (
    <div className="bg-background grid min-w-44 gap-2 rounded-lg border px-3 py-2 text-xs shadow-xl">
      <div className="font-medium">{label}</div>
      <div className="grid gap-1.5">
        <TooltipRow label={METRIC_LABELS[metric]} value={formatMetricValue(point.value, metric)} />
        <TooltipRow label="Net Sales" value={formatCents(point.net_sales_cents)} />
        <TooltipRow label="Orders" value={formatCount(point.order_count)} />
      </div>
    </div>
  );
}

function TooltipRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-6">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-mono font-medium tabular-nums">{value}</span>
    </div>
  );
}

export function TrendsPageClient() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const setViewSnapshot = useAiAssistantStore((s) => s.setViewSnapshot);
  const filters = useMemo(
    () => parseTrendsFilters(new URLSearchParams(searchParams.toString())),
    [searchParams],
  );
  const trends = useTrends(filters);
  const heatmapWindow = useMemo(() => {
    const today = DateTime.now().setZone(STORE_TZ).startOf("day");

    return {
      from: today.minus({ days: 90 }).toISODate()!,
      to: today.toISODate()!,
      metric: "net_sales" as const,
      grain: "day" as const,
    };
  }, []);
  const heatmapTrends = useTrends(heatmapWindow);

  useEffect(() => {
    if (!trends.data) return;
    const qs = searchParams.toString();
    setViewSnapshot({
      view: "trends",
      url: qs ? `${pathname}?${qs}` : pathname,
      data: trends.data,
      capturedAt: new Date().toISOString(),
    });
  }, [trends.data, pathname, searchParams, setViewSnapshot]);

  function update(partial: Partial<TrendsFilters>) {
    const next = { ...filters, ...partial };
    router.replace(`/trends?${serializeTrendsFilters(next).toString()}`, { scroll: false });
  }

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-3xl font-medium tracking-tight">Trends</h1>
        <p className="text-muted-foreground">
          Long-range time series across net sales, orders, average ticket, refund rate, and
          discounts given.
        </p>
      </header>

      <div className="flex flex-wrap items-center gap-3">
        <DateRangeButton
          from={filters.from}
          to={filters.to}
          onChange={(from, to) => update({ from, to })}
        />

        <Tabs
          value={filters.metric}
          onValueChange={(value) => update({ metric: value as TrendsFilters["metric"] })}
        >
          <TabsList>
            <TabsTrigger value="net_sales">Net Sales</TabsTrigger>
            <TabsTrigger value="orders">Orders</TabsTrigger>
            <TabsTrigger value="avg_ticket">Avg Ticket</TabsTrigger>
            <TabsTrigger value="refund_rate">Refund Rate</TabsTrigger>
            <TabsTrigger value="discounts">Discounts</TabsTrigger>
          </TabsList>
        </Tabs>

        <Tabs
          value={filters.grain}
          onValueChange={(value) => update({ grain: value as TrendsFilters["grain"] })}
        >
          <TabsList>
            <TabsTrigger value="day">Day</TabsTrigger>
            <TabsTrigger value="week">Week</TabsTrigger>
          </TabsList>
        </Tabs>

        <Button
          variant="outline"
          size="sm"
          className="ml-auto"
          disabled={!trends.data || trends.data.points.length === 0}
          onClick={() => trends.data && downloadTrendsCsv(trends.data)}
        >
          <Download className="size-4" />
          Export CSV
        </Button>
      </div>

      {trends.isError ? (
        <Alert variant="destructive">
          <AlertCircle className="size-4" />
          <AlertTitle>Could not load trends</AlertTitle>
          <AlertDescription>
            {trends.error instanceof Error ? trends.error.message : "Unknown error."}
          </AlertDescription>
        </Alert>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-base font-medium">{METRIC_LABELS[filters.metric]}</CardTitle>
          <CardDescription>
            {filters.from} to {filters.to} · {filters.grain === "day" ? "daily" : "weekly"}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {trends.isLoading ? (
            <Skeleton className="h-[320px] w-full" />
          ) : trends.data && trends.data.points.length > 0 ? (
            <ChartContainer config={chartConfig} className="h-[320px] w-full">
              <LineChart accessibilityLayer data={trends.data.points}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} />
                <XAxis
                  dataKey="bucket_start"
                  axisLine={false}
                  tickLine={false}
                  tickFormatter={(value: string) => value.slice(5)}
                />
                <YAxis
                  axisLine={false}
                  tickLine={false}
                  tickFormatter={(value: number) => yAxisTick(value, filters.metric)}
                  width={70}
                />
                <ChartTooltip content={<TrendsTooltip metric={filters.metric} />} />
                <Line
                  dataKey="value"
                  dot={false}
                  isAnimationActive={false}
                  stroke="var(--color-value)"
                  strokeWidth={2.5}
                  type="monotone"
                />
              </LineChart>
            </ChartContainer>
          ) : (
            <p className="text-muted-foreground text-sm">No data in this range.</p>
          )}
        </CardContent>
      </Card>

      {heatmapTrends.isLoading ? (
        <CalendarHeatmapSkeleton />
      ) : heatmapTrends.data ? (
        <CalendarHeatmap points={heatmapTrends.data.points} />
      ) : null}

      <SegmentBreakdown from={filters.from} to={filters.to} />
    </div>
  );
}
