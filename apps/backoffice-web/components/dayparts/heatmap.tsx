"use client";

import type { DaypartsView, HeatmapCell } from "@/lib/analytics-api/dayparts-transform";
import { WEEKDAY_LABELS } from "@/lib/analytics-api/dayparts-transform";
import { formatCents } from "@/lib/format";

// 9-stop perceptually uniform sequential scale (Viridis-inspired). Hardcoded
// here so the component has no runtime dep on a color library. Order: low -> high.
const VIRIDIS_STOPS = [
  "#440154", // dark purple
  "#482878",
  "#3e4989",
  "#31688e",
  "#26828e",
  "#1f9e89",
  "#35b779",
  "#6ece58",
  "#fde725" // bright yellow
];

function colorForIntensity(intensity: number): string {
  if (intensity <= 0) return "var(--card)";
  const clamped = Math.max(0, Math.min(1, intensity));
  const idx = Math.min(VIRIDIS_STOPS.length - 1, Math.floor(clamped * VIRIDIS_STOPS.length));
  return VIRIDIS_STOPS[idx]!;
}

function hourLabel(hour: number): string {
  if (hour === 0) return "12a";
  if (hour === 12) return "12p";
  if (hour < 12) return `${hour}a`;
  return `${hour - 12}p`;
}

interface DaypartsHeatmapProps {
  view: DaypartsView;
  /**
   * Legend caption. Data semantics differ between the Dayparts page (net
   * sales, all orders) and the per-item Menu drill-down (gross sales for
   * one item). Defaults to the Dayparts wording.
   */
  valueLabel?: string;
}

export function DaypartsHeatmap({
  view,
  valueLabel = "Color = average net sales for that weekday + hour"
}: DaypartsHeatmapProps) {
  const maxCellSales = view.heatmap.reduce((max, cell) => Math.max(max, cell.netSalesCents), 0);

  // Lay out: column 0 = hour labels, columns 1..7 = Sun..Sat.
  return (
    <div
      role="figure"
      aria-label={`Hour-of-day by weekday revenue heatmap covering ${view.daysInWindow} days`}
      className="overflow-x-auto"
    >
      <div
        className="grid gap-[2px] text-xs tabular-nums"
        style={{
          gridTemplateColumns: "auto repeat(7, minmax(40px, 1fr))",
          gridTemplateRows: `auto repeat(24, 18px)`
        }}
      >
        {/* Header row: blank corner + weekday labels */}
        <div aria-hidden />
        {WEEKDAY_LABELS.map((label) => (
          <div key={label} className="px-1 text-center font-medium text-muted-foreground">
            {label}
          </div>
        ))}

        {/* For each hour, render hour label + 7 cells */}
        {Array.from({ length: 24 }, (_, hour) => {
          const cellsForHour = view.heatmap.filter((c) => c.hour === hour);
          return (
            <CellRow
              key={hour}
              hour={hour}
              cells={cellsForHour}
              maxCellSales={maxCellSales}
            />
          );
        })}
      </div>

      <div className="mt-4 flex items-center gap-3 text-xs text-muted-foreground">
        <span>Low</span>
        <div className="flex h-2 w-32">
          {VIRIDIS_STOPS.map((stop) => (
            <div key={stop} style={{ background: stop }} className="h-full flex-1" />
          ))}
        </div>
        <span>High</span>
        <span className="ml-4">{valueLabel}</span>
      </div>
    </div>
  );
}

function CellRow({
  hour,
  cells,
  maxCellSales
}: {
  hour: number;
  cells: HeatmapCell[];
  maxCellSales: number;
}) {
  return (
    <>
      <div className="px-1 text-right text-muted-foreground" style={{ lineHeight: "18px" }}>
        {hourLabel(hour)}
      </div>
      {cells
        .slice()
        .sort((a, b) => a.weekday - b.weekday)
        .map((cell) => {
          const intensity = maxCellSales > 0 ? cell.netSalesCents / maxCellSales : 0;
          const fmtCents = formatCents(cell.netSalesCents);
          const label = `${WEEKDAY_LABELS[cell.weekday]} ${hourLabel(cell.hour)}: ${fmtCents} avg (${cell.sampleSize} weeks sampled)`;
          return (
            <div
              key={`${cell.weekday}-${cell.hour}`}
              role="img"
              aria-label={label}
              title={label}
              className="rounded-[2px]"
              style={{ background: colorForIntensity(intensity) }}
            />
          );
        })}
    </>
  );
}
