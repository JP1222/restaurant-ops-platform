"use client";

import { CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts";
import type { DaypartsView } from "@/lib/analytics-api/dayparts-transform";
import { ChartContainer, ChartTooltip, type ChartConfig } from "@/components/ui/chart";
import { formatCents } from "@/lib/format";

const WEEKDAY_COLORS: Record<number, string> = {
  0: "var(--chart-6)", // Sun
  1: "var(--chart-1)", // Mon
  2: "var(--chart-2)", // Tue
  3: "var(--chart-3)", // Wed
  4: "var(--chart-4)", // Thu
  5: "var(--chart-5)", // Fri
  6: "var(--chart-6)" // Sat (reuse chart-6 with different stroke handled below)
};

const WEEKDAY_STROKE_WIDTH: Record<number, number> = {
  0: 2,
  1: 1.5,
  2: 1.5,
  3: 1.5,
  4: 1.5,
  5: 2,
  6: 2.5 // emphasize Saturday a bit
};

interface WeekdayCurvesChartProps {
  view: DaypartsView;
}

interface TooltipPayloadItem {
  value?: number;
  name?: string;
  color?: string;
  dataKey?: string | number;
}

function hourLabel(hour: number): string {
  if (hour === 0) return "12a";
  if (hour === 12) return "12p";
  if (hour < 12) return `${hour}a`;
  return `${hour - 12}p`;
}

export function WeekdayCurvesChart({ view }: WeekdayCurvesChartProps) {
  // Reshape to one row per hour, one column per weekday.
  const data = Array.from({ length: 24 }, (_, hour) => {
    const row: Record<string, number | string> = { hour, hourLabel: hourLabel(hour) };
    for (const curve of view.weekdayCurves) {
      row[curve.label] = curve.hourly[hour]?.netSalesCents ?? 0;
    }
    return row;
  });

  const chartConfig = view.weekdayCurves.reduce<ChartConfig>((acc, curve) => {
    acc[curve.label] = {
      label: curve.label,
      color: WEEKDAY_COLORS[curve.weekday] ?? "var(--chart-1)"
    };
    return acc;
  }, {} satisfies ChartConfig);

  return (
    <ChartContainer config={chartConfig} className="h-[340px] w-full">
      <LineChart data={data} margin={{ top: 8, right: 16, bottom: 8, left: 16 }}>
        <CartesianGrid strokeDasharray="3 3" />
        <XAxis
          dataKey="hourLabel"
          tickLine={false}
          axisLine={false}
          interval={2}
          fontSize={12}
        />
        <YAxis
          tickFormatter={(value) => formatCents(Number(value))}
          tickLine={false}
          axisLine={false}
          fontSize={12}
          width={70}
        />
        <ChartTooltip
          content={({ active, payload, label }) => {
            if (!active || !payload?.length) return null;
            const items = payload as unknown as TooltipPayloadItem[];
            return (
              <div className="rounded-md border bg-background p-2 text-xs shadow-md">
                <div className="mb-1 font-medium">{label}</div>
                <ul className="space-y-0.5 tabular-nums">
                  {items
                    .slice()
                    .sort((a, b) => Number(b.value ?? 0) - Number(a.value ?? 0))
                    .map((item) => (
                      <li key={String(item.dataKey)} className="flex items-center gap-2">
                        <span
                          className="inline-block h-2 w-2 rounded-full"
                          style={{ background: item.color }}
                        />
                        <span className="text-muted-foreground">{item.name}</span>
                        <span className="ml-auto">{formatCents(Number(item.value ?? 0))}</span>
                      </li>
                    ))}
                </ul>
              </div>
            );
          }}
        />
        {view.weekdayCurves.map((curve) => (
          <Line
            key={curve.weekday}
            type="monotone"
            dataKey={curve.label}
            stroke={WEEKDAY_COLORS[curve.weekday] ?? "var(--chart-1)"}
            strokeWidth={WEEKDAY_STROKE_WIDTH[curve.weekday] ?? 1.5}
            dot={false}
            isAnimationActive={false}
          />
        ))}
      </LineChart>
    </ChartContainer>
  );
}
