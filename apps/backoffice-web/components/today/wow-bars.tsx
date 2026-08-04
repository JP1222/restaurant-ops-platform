"use client";

import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ChartContainer, ChartTooltip, type ChartConfig } from "@/components/ui/chart";
import { Skeleton } from "@/components/ui/skeleton";
import { formatBusinessDate } from "@/lib/analytics-api/today-display";
import type { WeekVsWeekView } from "@/lib/analytics-api/wow-transform";
import { formatCents, formatPercent } from "@/lib/format";

interface WowChartPoint {
  weekday_label: string;
  business_date: string;
  this_week: number;
  last_week: number;
  wow_pct: number | null;
}

interface TooltipPayloadItem {
  value?: number | null;
  dataKey?: string | number;
  name?: string | number;
  color?: string;
  payload?: WowChartPoint;
}

interface WowTooltipProps {
  active?: boolean;
  label?: string | number;
  payload?: TooltipPayloadItem[];
}

const chartConfig = {
  this_week: {
    label: "This week",
    color: "var(--chart-1)",
  },
  last_week: {
    label: "Last week",
    color: "var(--chart-3)",
  },
} satisfies ChartConfig;

function buildSeries(data: WeekVsWeekView): WowChartPoint[] {
  return data.points.map((point) => ({
    weekday_label: point.weekday_label,
    business_date: point.business_date,
    this_week: point.this_week_sales_cents,
    last_week: point.last_week_sales_cents,
    wow_pct: point.wow_pct,
  }));
}

function WowTooltip({ active, label, payload }: WowTooltipProps) {
  const point = payload?.find((item) => item.payload)?.payload;

  if (!active || !point) {
    return null;
  }

  return (
    <div className="bg-background grid min-w-44 gap-2 rounded-lg border px-3 py-2 text-xs shadow-xl">
      <div className="font-medium">
        {label} · {point.business_date}
      </div>
      <div className="grid gap-1.5">
        <TooltipRow label="This week" value={formatCents(point.this_week)} />
        <TooltipRow label="Last week" value={formatCents(point.last_week)} />
        <TooltipRow
          label="WoW"
          value={point.wow_pct === null ? "n/a" : formatPercent(point.wow_pct)}
        />
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

export interface WowBarsProps {
  data: WeekVsWeekView;
}

export function WowBars({ data }: WowBarsProps) {
  const series = buildSeries(data);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base font-medium">This Week vs Last Week</CardTitle>
        <CardDescription>
          Net sales by business day through {formatBusinessDate(data.anchor_date)}
          {data.wow_pct === null ? "." : ` (${formatPercent(data.wow_pct)} total).`}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ChartContainer config={chartConfig} className="h-[280px] w-full">
          <BarChart accessibilityLayer barCategoryGap={20} data={series}>
            <CartesianGrid strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey="weekday_label" axisLine={false} tickLine={false} />
            <YAxis
              axisLine={false}
              tickLine={false}
              tickFormatter={(value: number) => `$${(value / 100).toFixed(0)}`}
              width={60}
            />
            <Bar
              dataKey="last_week"
              fill="var(--color-last_week)"
              isAnimationActive={false}
              radius={[4, 4, 0, 0]}
            />
            <Bar
              dataKey="this_week"
              fill="var(--color-this_week)"
              isAnimationActive={false}
              radius={[4, 4, 0, 0]}
            />
            <ChartTooltip content={<WowTooltip />} />
          </BarChart>
        </ChartContainer>
      </CardContent>
    </Card>
  );
}

export function WowBarsSkeleton() {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base font-medium">This Week vs Last Week</CardTitle>
        <CardDescription>Loading weekly comparison.</CardDescription>
      </CardHeader>
      <CardContent>
        <Skeleton className="h-[280px] w-full" />
      </CardContent>
    </Card>
  );
}
