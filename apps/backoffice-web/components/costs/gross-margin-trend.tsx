"use client";

import { Area, AreaChart, CartesianGrid, Label, ReferenceLine, XAxis, YAxis } from "recharts";
import { ChartContainer, ChartTooltip, type ChartConfig } from "@/components/ui/chart";
import { formatRate } from "@/lib/format";
import type { CostsResponse } from "@/lib/analytics-api/types";

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec"
];

function formatDate(iso: string): string {
  const parts = iso.split("-").map(Number);
  const month = parts[1] ?? 1;
  const day = parts[2] ?? 1;
  return `${MONTHS[month - 1] ?? ""} ${day}`;
}

const chartConfig = {
  value: { label: "Gross margin", color: "var(--trend-up)" }
} satisfies ChartConfig;

type TrendPoint = { business_date: string; value: number };

interface TrendTooltipProps {
  active?: boolean;
  payload?: { payload?: TrendPoint }[];
}

function TrendTooltip({ active, payload }: TrendTooltipProps) {
  const row = payload?.[0]?.payload;
  if (!active || !row) return null;
  return (
    <div className="grid min-w-[150px] gap-1.5 rounded-lg border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-xl">
      <div className="font-medium text-foreground">{formatDate(row.business_date)}</div>
      <div className="flex items-center justify-between gap-3 tabular-nums">
        <span className="text-muted-foreground">Gross margin</span>
        <span className="text-right font-mono font-medium" style={{ color: "var(--trend-up)" }}>
          {formatRate(row.value)}
        </span>
      </div>
    </div>
  );
}

export interface GrossMarginTrendProps {
  trend: CostsResponse["marginTrend"];
}

export function GrossMarginTrend({ trend }: GrossMarginTrendProps) {
  const points: TrendPoint[] = trend
    .filter((p): p is { business_date: string; value: number } => p.value != null)
    .map((p) => ({ business_date: p.business_date, value: p.value }));

  if (points.length === 0) {
    return (
      <div className="flex h-[268px] items-center justify-center text-sm text-muted-foreground">
        No margin data in this window.
      </div>
    );
  }

  const avg = points.reduce((sum, p) => sum + p.value, 0) / points.length;

  return (
    <ChartContainer config={chartConfig} className="h-[268px] w-full">
      <AreaChart data={points} margin={{ top: 16, right: 16, bottom: 8, left: 4 }}>
        <defs>
          <linearGradient id="gmFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--trend-up)" stopOpacity={0.22} />
            <stop offset="100%" stopColor="var(--trend-up)" stopOpacity={0.02} />
          </linearGradient>
        </defs>
        <CartesianGrid vertical={false} stroke="var(--border)" />
        <XAxis
          dataKey="business_date"
          tickFormatter={formatDate}
          tickLine={false}
          axisLine={false}
          fontSize={11}
          minTickGap={24}
        />
        <YAxis
          tickFormatter={(value: number) => formatRate(value, 0)}
          tickLine={false}
          axisLine={false}
          width={44}
          fontSize={11}
        />
        <ReferenceLine y={avg} stroke="var(--muted-foreground)" strokeDasharray="5 4" strokeOpacity={0.6}>
          <Label
            value={`avg ${formatRate(avg)}`}
            position="insideTopRight"
            fill="var(--muted-foreground)"
            fontSize={10}
          />
        </ReferenceLine>
        <ChartTooltip content={<TrendTooltip />} cursor={{ strokeDasharray: "3 3" }} />
        <Area
          type="monotone"
          dataKey="value"
          stroke="var(--trend-up)"
          strokeWidth={2.25}
          fill="url(#gmFill)"
          isAnimationActive={false}
        />
      </AreaChart>
    </ChartContainer>
  );
}
