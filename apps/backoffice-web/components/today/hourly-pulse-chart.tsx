"use client";

import { Area, CartesianGrid, ComposedChart, Line, ReferenceLine, XAxis, YAxis } from "recharts";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ChartContainer, ChartTooltip, type ChartConfig } from "@/components/ui/chart";
import { Skeleton } from "@/components/ui/skeleton";
import type { HourlyPulse } from "@/lib/analytics-api/hourly-transform";
import { formatCents } from "@/lib/format";

const WEEKDAY_LABEL = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

interface HourlyChartPoint {
  hour: number;
  hourLabel: string;
  today: number | null;
  baseline: number;
  band_range: [number, number];
  today_orders: number;
  today_hour_sales: number | null;
  today_aov: number | null;
  delta_vs_avg: number | null;
}

interface TooltipPayloadItem {
  value?: number | [number, number] | null;
  dataKey?: string | number;
  name?: string | number;
  color?: string;
  payload?: HourlyChartPoint;
}

interface HourlyTooltipProps {
  active?: boolean;
  label?: string | number;
  payload?: TooltipPayloadItem[];
}

const chartConfig = {
  today: {
    label: "Today",
    color: "var(--chart-1)",
  },
  baseline: {
    label: "Same-weekday avg",
    color: "var(--chart-3)",
  },
} satisfies ChartConfig;

export interface HourlyPulseChartProps {
  data: HourlyPulse;
}

function buildSeries(data: HourlyPulse): HourlyChartPoint[] {
  return data.points.map((point, index) => {
    const previous = index > 0 ? data.points[index - 1]?.today_cumulative : 0;
    const todayHourSales =
      point.today_cumulative === null || previous === null
        ? null
        : point.today_cumulative - (previous ?? 0);

    return {
      hour: point.hour,
      hourLabel: point.hour.toString().padStart(2, "0"),
      today: point.today_cumulative,
      baseline: point.baseline_mean,
      band_range: [point.baseline_lower, point.baseline_upper],
      today_orders: point.today_orders,
      today_hour_sales: todayHourSales,
      today_aov:
        todayHourSales !== null && point.today_orders > 0
          ? todayHourSales / point.today_orders
          : null,
      delta_vs_avg:
        point.today_cumulative === null ? null : point.today_cumulative - point.baseline_mean,
    };
  });
}

function HourlyPulseTooltip({ active, label, payload }: HourlyTooltipProps) {
  const point = payload?.find((item) => item.payload)?.payload;

  if (!active || !point) {
    return null;
  }

  return (
    <div className="bg-background grid min-w-44 gap-2 rounded-lg border px-3 py-2 text-xs shadow-xl">
      <div className="font-medium">{label}:00</div>
      <div className="grid gap-1.5">
        <TooltipRow
          label="Today"
          value={point.today === null ? "Future" : formatCents(point.today)}
        />
        <TooltipRow label="Avg" value={formatCents(point.baseline)} />
        <TooltipRow
          label="Delta"
          value={point.delta_vs_avg === null ? "n/a" : formatCents(point.delta_vs_avg)}
        />
        <TooltipRow label="Orders" value={point.today_orders.toLocaleString()} />
        <TooltipRow
          label="AOV"
          value={point.today_aov === null ? "n/a" : formatCents(point.today_aov)}
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

export function HourlyPulseChart({ data }: HourlyPulseChartProps) {
  const series = buildSeries(data);
  const weekdayLabel = `${WEEKDAY_LABEL[data.weekday]} avg`;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base font-medium">Hourly Pulse</CardTitle>
        <CardDescription>
          Today&apos;s running net sales vs {weekdayLabel} (4-week average +/-1 sigma band).
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ChartContainer
          config={{
            ...chartConfig,
            baseline: { label: weekdayLabel, color: "var(--chart-3)" },
          }}
          className="h-[300px] w-full"
        >
          <ComposedChart accessibilityLayer data={series}>
            <CartesianGrid strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey="hourLabel" axisLine={false} tickLine={false} />
            <YAxis
              axisLine={false}
              tickLine={false}
              tickFormatter={(value: number) => `$${(value / 100).toFixed(0)}`}
              width={60}
            />
            <Area
              dataKey="band_range"
              fill="var(--color-baseline)"
              fillOpacity={0.12}
              isAnimationActive={false}
              stroke="none"
              type="monotone"
            />
            <Line
              dataKey="baseline"
              dot={false}
              isAnimationActive={false}
              stroke="var(--color-baseline)"
              strokeDasharray="4 4"
              strokeWidth={2}
              type="monotone"
            />
            <Line
              connectNulls={false}
              dataKey="today"
              dot={false}
              isAnimationActive={false}
              stroke="var(--color-today)"
              strokeWidth={2.5}
              type="monotone"
            />
            {data.is_current_day && data.pacing ? (
              <ReferenceLine
                stroke="var(--foreground)"
                strokeDasharray="2 2"
                strokeOpacity={0.3}
                x={data.pacing.current_hour.toString().padStart(2, "0")}
              />
            ) : null}
            <ChartTooltip content={<HourlyPulseTooltip />} />
          </ComposedChart>
        </ChartContainer>
      </CardContent>
    </Card>
  );
}

export function HourlyPulseChartSkeleton() {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base font-medium">Hourly Pulse</CardTitle>
        <CardDescription>Loading hourly sales profile.</CardDescription>
      </CardHeader>
      <CardContent>
        <Skeleton className="h-[300px] w-full" />
      </CardContent>
    </Card>
  );
}
