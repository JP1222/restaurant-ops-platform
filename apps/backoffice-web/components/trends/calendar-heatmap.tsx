"use client";

import { DateTime } from "luxon";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { formatCents } from "@/lib/format";
import { bucketByQuantile } from "@/lib/trends/heatmap-buckets";
import { cn } from "@/lib/utils";

const STORE_TZ = "America/Chicago";
const WEEKS = 13;
const DAYS_PER_WEEK = 7;
const DAY_LABELS = ["S", "M", "T", "W", "T", "F", "S"];
const BUCKET_BG = [
  "bg-muted/40",
  "bg-chart-1/20",
  "bg-chart-1/40",
  "bg-chart-1/70",
  "bg-chart-1",
] as const;

interface DayPoint {
  bucket_start: string;
  net_sales_cents: number;
}

interface HeatmapDay {
  iso: string;
  value: number;
  isFuture: boolean;
}

interface HeatmapColumn {
  weekStartIso: string;
  days: HeatmapDay[];
}

export interface CalendarHeatmapProps {
  points: DayPoint[];
}

function currentSunday(today: DateTime): DateTime {
  return today.minus({ days: today.weekday % DAYS_PER_WEEK }).startOf("day");
}

function buildColumns(points: DayPoint[], today: DateTime): HeatmapColumn[] {
  const byDate = new Map(points.map((point) => [point.bucket_start, point.net_sales_cents]));
  const start = currentSunday(today).minus({ weeks: WEEKS - 1 });

  return Array.from({ length: WEEKS }, (_, column) => {
    const weekStart = start.plus({ weeks: column });
    const days = Array.from({ length: DAYS_PER_WEEK }, (_, day) => {
      const date = weekStart.plus({ days: day });
      const iso = date.toISODate() ?? "";

      return {
        iso,
        value: byDate.get(iso) ?? 0,
        isFuture: date > today,
      };
    });

    return {
      weekStartIso: weekStart.toISODate() ?? "",
      days,
    };
  });
}

function monthLabels(columns: HeatmapColumn[]): Array<string | null> {
  return columns.map((column, index) => {
    const monthStart = column.days.find((day) => DateTime.fromISO(day.iso).day === 1);
    if (monthStart) return DateTime.fromISO(monthStart.iso).toFormat("LLL");
    if (index === 0) return DateTime.fromISO(column.weekStartIso).toFormat("LLL");
    return null;
  });
}

export function CalendarHeatmap({ points }: CalendarHeatmapProps) {
  const today = DateTime.now().setZone(STORE_TZ).startOf("day");
  const columns = buildColumns(points, today);
  const values = columns.flatMap((column) => column.days.map((day) => day.value));
  const buckets = bucketByQuantile(values);
  const labels = monthLabels(columns);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base font-medium">Net sales - last {WEEKS} weeks</CardTitle>
        <CardDescription>
          Each cell is one day. Darker emerald means higher net sales relative to the period.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto">
          <TooltipProvider delayDuration={100}>
            <div className="flex gap-3">
              <div className="text-muted-foreground flex flex-col gap-1 pt-5 text-[10px]">
                {DAY_LABELS.map((label, index) => (
                  <div key={`${label}-${index}`} className="size-3 leading-3 tabular-nums">
                    {label}
                  </div>
                ))}
              </div>

              <div className="min-w-max">
                <div className="mb-1 flex gap-1">
                  {labels.map((label, index) => (
                    <div
                      key={`${columns[index]?.weekStartIso ?? index}-label`}
                      className="text-muted-foreground h-4 w-3 text-[10px] tabular-nums"
                    >
                      {label ?? ""}
                    </div>
                  ))}
                </div>

                <div className="grid grid-flow-col grid-rows-7 gap-1">
                  {columns.flatMap((column, columnIndex) =>
                    column.days.map((day, dayIndex) => {
                      const bucketIndex = columnIndex * DAYS_PER_WEEK + dayIndex;
                      const bucket = buckets[bucketIndex]?.bucket ?? 0;

                      return (
                        <Tooltip key={day.iso}>
                          <TooltipTrigger asChild>
                            <button
                              type="button"
                              className={cn(
                                "border-border size-3 cursor-default rounded-[3px] border p-0 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                                day.isFuture
                                  ? "border-dashed bg-transparent opacity-30"
                                  : BUCKET_BG[bucket],
                              )}
                              aria-label={`${day.iso}: ${
                                day.isFuture ? "future date" : formatCents(day.value)
                              }`}
                            />
                          </TooltipTrigger>
                          <TooltipContent side="top">
                            <div className="grid gap-1">
                              <div className="font-medium">
                                {DateTime.fromISO(day.iso).toFormat("LLL d, yyyy")}
                              </div>
                              <div className="font-mono tabular-nums text-background/75">
                                {day.isFuture ? "Future date" : formatCents(day.value)}
                              </div>
                            </div>
                          </TooltipContent>
                        </Tooltip>
                      );
                    }),
                  )}
                </div>
              </div>
            </div>
          </TooltipProvider>

          <div className="text-muted-foreground mt-3 flex items-center justify-end gap-2 text-[10px]">
            <span>Less</span>
            {BUCKET_BG.map((className) => (
              <div
                key={className}
                className={cn("border-border size-3 rounded-[3px] border", className)}
                aria-hidden="true"
              />
            ))}
            <span>More</span>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export function CalendarHeatmapSkeleton() {
  return (
    <Card>
      <CardHeader>
        <Skeleton className="h-5 w-48" />
        <Skeleton className="h-4 w-80 max-w-full" />
      </CardHeader>
      <CardContent>
        <Skeleton className="h-[140px] w-full" />
      </CardContent>
    </Card>
  );
}
