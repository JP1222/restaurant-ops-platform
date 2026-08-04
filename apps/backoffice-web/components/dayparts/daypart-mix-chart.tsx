"use client";

import { Cell, Pie, PieChart, Legend } from "recharts";
import type { DaypartsView } from "@/lib/analytics-api/dayparts-transform";
import { ChartContainer, ChartTooltip, type ChartConfig } from "@/components/ui/chart";
import { formatCents, formatPercent } from "@/lib/format";

const DAYPART_COLORS: Record<string, string> = {
  breakfast: "var(--chart-3)",
  lunch: "var(--chart-1)",
  dinner: "var(--chart-2)",
  off_peak: "var(--chart-6)"
};

interface DaypartMixChartProps {
  view: DaypartsView;
}

interface TooltipPayloadItem {
  payload?: {
    label: string;
    netSalesCents: number;
    share: number;
  };
}

export function DaypartMixChart({ view }: DaypartMixChartProps) {
  const data = view.daypartMix.map((slice) => ({
    key: slice.key,
    label: slice.label,
    netSalesCents: slice.netSalesCents,
    share: slice.share
  }));

  const chartConfig = data.reduce<ChartConfig>((acc, slice) => {
    acc[slice.key] = {
      label: slice.label,
      color: DAYPART_COLORS[slice.key] ?? "var(--chart-1)"
    };
    return acc;
  }, {} satisfies ChartConfig);

  const total = view.totalNetSalesCents;

  return (
    <ChartContainer config={chartConfig} className="h-[260px] w-full">
      <PieChart>
        <ChartTooltip
          content={({ active, payload }) => {
            if (!active || !payload?.length) return null;
            const item = payload[0] as TooltipPayloadItem;
            const d = item.payload;
            if (!d) return null;
            return (
              <div className="rounded-md border bg-background p-2 text-xs shadow-md">
                <div className="font-medium">{d.label}</div>
                <div className="tabular-nums">
                  {formatCents(d.netSalesCents)} · {formatPercent(d.share, 1)}
                </div>
              </div>
            );
          }}
        />
        <Pie
          data={data}
          dataKey="netSalesCents"
          nameKey="label"
          cx="50%"
          cy="50%"
          innerRadius={60}
          outerRadius={100}
          paddingAngle={2}
          strokeWidth={2}
        >
          {data.map((slice) => (
            <Cell key={slice.key} fill={DAYPART_COLORS[slice.key] ?? "var(--chart-1)"} />
          ))}
        </Pie>
        <Legend
          verticalAlign="bottom"
          height={36}
          iconSize={10}
          formatter={(value, _entry, index) => {
            const slice = data[index];
            if (!slice) return value;
            return (
              <span className="text-xs">
                {slice.label} · {formatPercent(slice.share, 0)}
              </span>
            );
          }}
        />
      </PieChart>
      <p className="mt-2 text-center text-xs text-muted-foreground tabular-nums">
        Total {formatCents(total)} across {view.daysInWindow} days
      </p>
    </ChartContainer>
  );
}
