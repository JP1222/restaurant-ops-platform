"use client";

import {
  CartesianGrid,
  Cell,
  ReferenceArea,
  ReferenceLine,
  Scatter,
  ScatterChart,
  XAxis,
  YAxis,
  ZAxis
} from "recharts";
import type { MenuQuadrant } from "@rop/contracts";
import { ChartContainer, ChartTooltip, type ChartConfig } from "@/components/ui/chart";
import { formatCents, formatCount, formatRate } from "@/lib/format";
import { QUADRANT_COLOR, QUADRANT_LABEL } from "@/lib/menu/quadrant-colors";
import type { MenuEngineeringItem, MenuEngineeringView } from "@/lib/menu/kasavana-smith";

const chartConfig = {
  items: { label: "Items", color: "var(--chart-1)" }
} satisfies ChartConfig;

type ChartPoint = MenuEngineeringItem & { marginDollars: number };

interface QuadrantTooltipProps {
  active?: boolean;
  payload?: { payload?: ChartPoint }[];
}

function QuadrantTooltip({ active, payload }: QuadrantTooltipProps) {
  const row = payload?.[0]?.payload;
  if (!active || !row) return null;

  const quadrant: MenuQuadrant = row.quadrant;
  return (
    <div className="grid min-w-52 gap-2 rounded-lg border bg-popover px-3 py-2.5 text-xs text-popover-foreground shadow-xl">
      <div className="flex items-center justify-between gap-3">
        <span className="font-medium text-foreground">{row.item_name}</span>
        <span className="inline-flex items-center gap-1.5 text-muted-foreground">
          <span
            aria-hidden
            className="inline-block size-2 rounded-full"
            style={{ background: QUADRANT_COLOR[quadrant] }}
          />
          {QUADRANT_LABEL[quadrant]}
        </span>
      </div>
      <div className="grid grid-cols-2 gap-x-4 gap-y-1 tabular-nums">
        <span className="text-muted-foreground">Units</span>
        <span className="text-right font-mono">{formatCount(row.units)}</span>
        <span className="text-muted-foreground">Menu mix</span>
        <span className="text-right font-mono">{formatRate(row.mix)}</span>
        <span className="text-muted-foreground">Contribution</span>
        <span className="text-right font-mono">{formatCents(row.margin_cents)}</span>
        <span className="text-muted-foreground">Revenue</span>
        <span className="text-right font-mono">{formatCents(row.revenue_cents)}</span>
      </div>
    </div>
  );
}

interface QuadrantRegion {
  quadrant: MenuQuadrant;
  x1: number;
  x2: number;
  y1: number;
  y2: number;
  label: string;
  position:
    | "insideTopRight"
    | "insideBottomRight"
    | "insideTopLeft"
    | "insideBottomLeft";
}

export interface QuadrantChartProps {
  view: MenuEngineeringView;
  onSelect: (fingerprint: string) => void;
}

export function QuadrantChart({ view, onSelect }: QuadrantChartProps) {
  const data: ChartPoint[] = view.items.map((item) => ({
    ...item,
    marginDollars: item.margin_cents / 100
  }));

  const xThreshold = view.xThreshold;
  const yThreshold = view.yThresholdCents / 100;

  const mixMax = Math.max(...data.map((d) => d.mix), xThreshold);
  const marginValues = data.map((d) => d.marginDollars);
  const marginMax = Math.max(...marginValues, yThreshold);
  const marginMin = Math.min(...marginValues, 0);

  const xMax = mixMax * 1.15;
  const yPad = Math.max(0.5, marginMax * 0.12);
  const yMax = marginMax + yPad;
  const yMin = marginMin < 0 ? marginMin - yPad : 0;

  const regions: QuadrantRegion[] = [
    {
      quadrant: "star",
      x1: xThreshold,
      x2: xMax,
      y1: yThreshold,
      y2: yMax,
      label: "STARS",
      position: "insideTopRight"
    },
    {
      quadrant: "plowhorse",
      x1: xThreshold,
      x2: xMax,
      y1: yMin,
      y2: yThreshold,
      label: "PLOWHORSES",
      position: "insideBottomRight"
    },
    {
      quadrant: "puzzle",
      x1: 0,
      x2: xThreshold,
      y1: yThreshold,
      y2: yMax,
      label: "PUZZLES",
      position: "insideTopLeft"
    },
    {
      quadrant: "dog",
      x1: 0,
      x2: xThreshold,
      y1: yMin,
      y2: yThreshold,
      label: "DOGS",
      position: "insideBottomLeft"
    }
  ];

  return (
    <ChartContainer config={chartConfig} className="h-[460px] w-full">
      <ScatterChart margin={{ top: 16, right: 20, bottom: 28, left: 8 }}>
        {regions.map((region) => (
          <ReferenceArea
            key={region.quadrant}
            x1={region.x1}
            x2={region.x2}
            y1={region.y1}
            y2={region.y2}
            fill={QUADRANT_COLOR[region.quadrant]}
            fillOpacity={0.07}
            stroke="none"
            label={{
              value: region.label,
              position: region.position,
              fill: "var(--muted-foreground)",
              fontSize: 11,
              fontWeight: 600,
              letterSpacing: "0.08em"
            }}
          />
        ))}
        <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
        <XAxis
          type="number"
          dataKey="mix"
          name="Menu mix"
          domain={[0, xMax]}
          tickFormatter={(value: number) => formatRate(value, 0)}
          tickLine={false}
          axisLine={false}
          fontSize={11}
          label={{
            value: "Menu mix %  (share of units sold)",
            position: "insideBottom",
            offset: -16,
            fill: "var(--muted-foreground)",
            fontSize: 11
          }}
        />
        <YAxis
          type="number"
          dataKey="marginDollars"
          name="Contribution margin"
          domain={[yMin, yMax]}
          tickFormatter={(value: number) => `$${value.toFixed(2)}`}
          tickLine={false}
          axisLine={false}
          width={64}
          fontSize={11}
          label={{
            value: "Contribution margin / item",
            angle: -90,
            position: "insideLeft",
            fill: "var(--muted-foreground)",
            fontSize: 11,
            style: { textAnchor: "middle" }
          }}
        />
        <ZAxis type="number" dataKey="units" range={[80, 620]} name="Units" />
        <ReferenceLine
          x={xThreshold}
          stroke="var(--muted-foreground)"
          strokeDasharray="5 4"
          strokeOpacity={0.55}
        />
        <ReferenceLine
          y={yThreshold}
          stroke="var(--muted-foreground)"
          strokeDasharray="5 4"
          strokeOpacity={0.55}
        />
        <ChartTooltip content={<QuadrantTooltip />} cursor={{ strokeDasharray: "3 3" }} />
        <Scatter data={data} isAnimationActive={false}>
          {data.map((item) => (
            <Cell
              key={item.item_fingerprint}
              fill={QUADRANT_COLOR[item.quadrant]}
              fillOpacity={0.8}
              stroke="var(--background)"
              strokeWidth={1.5}
              style={{ cursor: "pointer" }}
              onClick={() => onSelect(item.item_fingerprint)}
            />
          ))}
        </Scatter>
      </ScatterChart>
    </ChartContainer>
  );
}
