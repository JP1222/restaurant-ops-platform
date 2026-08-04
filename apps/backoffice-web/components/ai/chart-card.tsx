"use client";

import { type ReactNode } from "react";
import { Bar, BarChart, CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts";
import { z } from "zod";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ChartContainer, ChartTooltip, type ChartConfig } from "@/components/ui/chart";
import { formatCents, formatCount, formatRate } from "@/lib/format";

// Charts in chat are rendered from a tool's ACTUAL returned data — never from
// model-transcribed numbers — so every plotted figure traces to a tool result
// (Backoffice numeric-governance rule). Each chartable tool has a known output
// shape (validated with zod) and a natural chart type: a metric time-series is a
// line, best-sellers are categorical bars. Invalid/unknown shapes return null so
// the caller falls back to the raw tool-output card.

const CHARTABLE_TOOLS = new Set(["get_trends", "get_top_items"]);

export function isChartableTool(name: string): boolean {
  return CHARTABLE_TOOLS.has(name);
}

// --- get_trends -> line chart (matches TrendsView from trends-transform.ts) ---
const trendsSchema = z.object({
  metric: z.enum(["net_sales", "orders", "avg_ticket", "refund_rate"]),
  granularity: z.enum(["day", "week"]),
  points: z.array(z.object({ bucket_start: z.string(), value: z.number() })).min(1),
});

// --- get_top_items -> bar chart (matches TopItemsView from top-items-transform.ts) ---
const topItemsSchema = z.object({
  window_days: z.number(),
  top: z.array(z.object({ item_name: z.string(), gross_sales_cents: z.number() })).min(1),
});

const METRIC_LABEL = {
  net_sales: "Net sales",
  orders: "Orders",
  avg_ticket: "Avg ticket",
  refund_rate: "Refund rate",
} as const;

type TrendMetric = keyof typeof METRIC_LABEL;

// net_sales / avg_ticket arrive in cents; orders is a count; refund_rate is a 0..1 ratio.
function tooltipFormat(metric: TrendMetric): (value: number) => string {
  if (metric === "orders") return (v) => formatCount(v);
  if (metric === "refund_rate") return (v) => formatRate(v);
  return (v) => formatCents(v);
}

function axisFormat(metric: TrendMetric): (value: number) => string {
  if (metric === "orders") return (v) => `${v}`;
  if (metric === "refund_rate") return (v) => `${Math.round(v * 100)}%`;
  return (v) => `$${Math.round(v / 100)}`;
}

interface TipProps {
  active?: boolean;
  label?: string | number;
  payload?: Array<{ value?: number | string }>;
  format: (value: number) => string;
}

function ChartTip({ active, label, payload, format }: TipProps) {
  if (!active || !payload?.length) return null;
  const raw = payload[0]?.value;
  return (
    <div className="bg-background grid min-w-32 gap-1 rounded-lg border px-3 py-2 text-xs shadow-xl">
      <div className="text-muted-foreground">{label}</div>
      <div className="font-mono font-medium tabular-nums">
        {typeof raw === "number" ? format(raw) : (raw ?? "—")}
      </div>
    </div>
  );
}

function TrendsLineCard({ view }: { view: z.infer<typeof trendsSchema> }) {
  const data = view.points.map((p) => ({ label: p.bucket_start.slice(5), value: p.value }));
  const config = {
    value: { label: METRIC_LABEL[view.metric], color: "var(--chart-1)" },
  } satisfies ChartConfig;

  return (
    <Card className="w-full">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium">
          {METRIC_LABEL[view.metric]} — {view.granularity === "day" ? "daily" : "weekly"}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <ChartContainer config={config} className="h-[240px] w-full">
          <LineChart accessibilityLayer data={data} margin={{ left: 4, right: 8, top: 8 }}>
            <CartesianGrid vertical={false} strokeDasharray="3 3" />
            <XAxis dataKey="label" axisLine={false} tickLine={false} tickMargin={8} minTickGap={16} />
            <YAxis axisLine={false} tickLine={false} width={52} tickFormatter={axisFormat(view.metric)} />
            <ChartTooltip content={<ChartTip format={tooltipFormat(view.metric)} />} />
            <Line
              dataKey="value"
              type="monotone"
              stroke="var(--color-value)"
              strokeWidth={2.5}
              dot={false}
              isAnimationActive={false}
            />
          </LineChart>
        </ChartContainer>
      </CardContent>
    </Card>
  );
}

function TopItemsBarCard({ view }: { view: z.infer<typeof topItemsSchema> }) {
  const data = view.top.slice(0, 8).map((t) => ({
    label: t.item_name.length > 14 ? `${t.item_name.slice(0, 13)}…` : t.item_name,
    value: t.gross_sales_cents,
  }));
  const config = { value: { label: "Revenue", color: "var(--chart-1)" } } satisfies ChartConfig;

  return (
    <Card className="w-full">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium">Top items — last {view.window_days} days</CardTitle>
      </CardHeader>
      <CardContent>
        <ChartContainer config={config} className="h-[260px] w-full">
          <BarChart accessibilityLayer data={data} margin={{ left: 4, right: 8, top: 8 }}>
            <CartesianGrid vertical={false} strokeDasharray="3 3" />
            <XAxis
              dataKey="label"
              axisLine={false}
              tickLine={false}
              tickMargin={8}
              angle={-30}
              textAnchor="end"
              height={64}
              interval={0}
            />
            <YAxis axisLine={false} tickLine={false} width={52} tickFormatter={(v: number) => `$${Math.round(v / 100)}`} />
            <ChartTooltip content={<ChartTip format={formatCents} />} />
            <Bar dataKey="value" fill="var(--color-value)" radius={[4, 4, 0, 0]} isAnimationActive={false} />
          </BarChart>
        </ChartContainer>
      </CardContent>
    </Card>
  );
}

/**
 * Render a chartable tool's output as a chart, or null if the tool isn't
 * chartable or its output doesn't match the expected shape (caller then falls
 * back to the raw tool-output card).
 */
export function renderToolChart(toolName: string, output: unknown): ReactNode | null {
  if (toolName === "get_trends") {
    const parsed = trendsSchema.safeParse(output);
    return parsed.success ? <TrendsLineCard view={parsed.data} /> : null;
  }
  if (toolName === "get_top_items") {
    const parsed = topItemsSchema.safeParse(output);
    return parsed.success ? <TopItemsBarCard view={parsed.data} /> : null;
  }
  return null;
}
