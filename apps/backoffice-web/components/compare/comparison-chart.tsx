"use client";

import { Bar, BarChart, CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ChartContainer, ChartTooltip, type ChartConfig } from "@/components/ui/chart";
import { Skeleton } from "@/components/ui/skeleton";
import type { ComparePoint, CompareView } from "@/lib/compare/compare-transform";
import { formatCents, formatCount, formatPercent, formatRate } from "@/lib/format";

const METRIC_LABELS: Record<CompareView["metric"], string> = {
  net_sales: "Net Sales",
  orders: "Orders",
  avg_ticket: "Avg Ticket",
  refund_rate: "Refund Rate",
  discounts: "Discounts",
};

const chartConfig = {
  primary_value: {
    label: "Primary",
    color: "var(--chart-1)",
  },
  compare_value: {
    label: "Comparison",
    color: "var(--chart-3)",
  },
} satisfies ChartConfig;

interface TooltipPayloadItem {
  color?: string;
  dataKey?: string | number;
  name?: string | number;
  payload?: ComparePoint;
  value?: number | null;
}

interface CompareTooltipProps {
  active?: boolean;
  label?: string | number;
  payload?: TooltipPayloadItem[];
  metric: CompareView["metric"];
}

function formatMetricValue(value: number, metric: CompareView["metric"]): string {
  if (metric === "net_sales" || metric === "avg_ticket" || metric === "discounts")
    return formatCents(value);
  if (metric === "orders") return formatCount(value);
  return formatRate(value);
}

function yAxisTick(value: number, metric: CompareView["metric"]): string {
  if (metric === "net_sales" || metric === "avg_ticket" || metric === "discounts")
    return `$${(value / 100).toFixed(0)}`;
  if (metric === "orders") return formatCount(value);
  return `${(value * 100).toFixed(1)}%`;
}

function diffClass(diff: number): string {
  return diff >= 0 ? "text-[color:var(--trend-up)]" : "text-[color:var(--trend-down)]";
}

function CompareTooltip({ active, label, payload, metric }: CompareTooltipProps) {
  const point = payload?.find((item) => item.payload)?.payload;

  if (!active || !point) return null;

  return (
    <div className="bg-background grid min-w-56 gap-2 rounded-lg border px-3 py-2 text-xs shadow-xl">
      <div className="font-medium">{label}</div>
      <div className="grid gap-1.5">
        <TooltipRow
          color="var(--chart-1)"
          label={point.primary_date ? `Primary - ${point.primary_date}` : "Primary"}
          value={point.primary_value === null ? "No data" : formatMetricValue(point.primary_value, metric)}
        />
        <TooltipRow
          color="var(--chart-3)"
          label={point.compare_date ? `Comparison - ${point.compare_date}` : "Comparison"}
          value={point.compare_value === null ? "No data" : formatMetricValue(point.compare_value, metric)}
        />
        {point.diff_pct !== null ? (
          <div className="flex items-center justify-between gap-6 border-t pt-1.5">
            <span className="text-muted-foreground">Diff</span>
            <span className={`font-mono font-medium tabular-nums ${diffClass(point.diff ?? 0)}`}>
              {formatPercent(point.diff_pct)}
            </span>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function TooltipRow({ color, label, value }: { color: string; label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-6">
      <span className="text-muted-foreground flex min-w-0 items-center gap-2">
        <span
          className="size-2 shrink-0 rounded-[2px]"
          style={{ backgroundColor: color }}
          aria-hidden="true"
        />
        <span className="truncate">{label}</span>
      </span>
      <span className="font-mono font-medium tabular-nums">{value}</span>
    </div>
  );
}

function ChartLegend() {
  return (
    <div className="text-muted-foreground flex items-center justify-end gap-4 text-xs">
      <LegendItem color="var(--chart-1)" label="Primary" />
      <LegendItem color="var(--chart-3)" label="Comparison" />
    </div>
  );
}

function LegendItem({ color, label }: { color: string; label: string }) {
  return (
    <div className="flex items-center gap-2">
      <span
        className="size-2.5 rounded-[3px]"
        style={{ backgroundColor: color }}
        aria-hidden="true"
      />
      <span>{label}</span>
    </div>
  );
}

export function ComparisonChart({ data }: { data: CompareView }) {
  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <div>
            <CardTitle className="text-base font-medium">{METRIC_LABELS[data.metric]}</CardTitle>
            <CardDescription>
              {data.primary_range.from} to {data.primary_range.to} vs {data.compare_range.from} to{" "}
              {data.compare_range.to}
            </CardDescription>
          </div>
          {data.totals.diff_pct !== null ? (
            <div className="text-sm">
              <span className="text-muted-foreground">Total diff </span>
              <span className={`font-mono font-medium tabular-nums ${diffClass(data.totals.diff)}`}>
                {formatPercent(data.totals.diff_pct)}
              </span>
            </div>
          ) : (
            <div className="text-muted-foreground text-sm">Total diff unavailable</div>
          )}
        </div>
      </CardHeader>
      <CardContent>
        <div className="flex flex-col gap-4">
          <ChartLegend />
          <ChartContainer config={chartConfig} className="h-[320px] w-full">
            {data.chart_kind === "bar" ? (
              <BarChart accessibilityLayer data={data.points} barCategoryGap={20}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="position_label" axisLine={false} tickLine={false} />
                <YAxis
                  axisLine={false}
                  tickLine={false}
                  tickFormatter={(value: number) => yAxisTick(value, data.metric)}
                  width={70}
                />
                <ChartTooltip content={<CompareTooltip metric={data.metric} />} />
                <Bar
                  dataKey="compare_value"
                  fill="var(--color-compare_value)"
                  isAnimationActive={false}
                  radius={[4, 4, 0, 0]}
                />
                <Bar
                  dataKey="primary_value"
                  fill="var(--color-primary_value)"
                  isAnimationActive={false}
                  radius={[4, 4, 0, 0]}
                />
              </BarChart>
            ) : (
              <LineChart accessibilityLayer data={data.points}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="position_label" axisLine={false} tickLine={false} />
                <YAxis
                  axisLine={false}
                  tickLine={false}
                  tickFormatter={(value: number) => yAxisTick(value, data.metric)}
                  width={70}
                />
                <ChartTooltip content={<CompareTooltip metric={data.metric} />} />
                <Line
                  dataKey="compare_value"
                  dot={false}
                  isAnimationActive={false}
                  stroke="var(--color-compare_value)"
                  strokeDasharray="4 4"
                  strokeWidth={2}
                  type="monotone"
                />
                <Line
                  dataKey="primary_value"
                  dot={false}
                  isAnimationActive={false}
                  stroke="var(--color-primary_value)"
                  strokeWidth={2.5}
                  type="monotone"
                />
              </LineChart>
            )}
          </ChartContainer>
        </div>
      </CardContent>
    </Card>
  );
}

export function ComparisonChartSkeleton() {
  return (
    <Card>
      <CardHeader>
        <Skeleton className="h-5 w-48" />
        <Skeleton className="h-4 w-96 max-w-full" />
      </CardHeader>
      <CardContent>
        <Skeleton className="h-[320px] w-full" />
      </CardContent>
    </Card>
  );
}
