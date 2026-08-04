"use client";

import { useEffect } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useDayparts } from "@/hooks/use-dayparts";
import { DaypartsHeatmap } from "@/components/dayparts/heatmap";
import { DaypartMixChart } from "@/components/dayparts/daypart-mix-chart";
import { WeekdayCurvesChart } from "@/components/dayparts/weekday-curves-chart";
import { formatCents } from "@/lib/format";
import { WEEKDAY_LABELS } from "@/lib/analytics-api/dayparts-transform";
import { useAiAssistantStore } from "@/stores/ai-assistant";

function hourLabel(hour: number): string {
  if (hour === 0) return "12a";
  if (hour === 12) return "12p";
  if (hour < 12) return `${hour}a`;
  return `${hour - 12}p`;
}

export default function DaypartsPage() {
  const setViewSnapshot = useAiAssistantStore((s) => s.setViewSnapshot);
  const query = useDayparts();

  useEffect(() => {
    if (!query.data) return;
    setViewSnapshot({
      view: "dayparts",
      url: `${window.location.pathname}${window.location.search}`,
      data: query.data,
      capturedAt: new Date().toISOString(),
    });
  }, [query.data, setViewSnapshot]);

  return (
    <div className="space-y-6 p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Dayparts</h1>
        <p className="text-sm text-muted-foreground">
          Where in the week the revenue actually comes from. Default window: the last 8 weeks.
        </p>
      </header>

      {query.isLoading ? (
        <div className="space-y-4">
          <Skeleton className="h-[520px] w-full" />
          <Skeleton className="h-[300px] w-full" />
          <Skeleton className="h-[380px] w-full" />
        </div>
      ) : query.isError ? (
        <p className="text-sm text-destructive">
          Could not load dayparts:{" "}
          {query.error instanceof Error ? query.error.message : "unknown"}
        </p>
      ) : query.data ? (
        <>
          <Card>
            <CardHeader>
              <CardTitle className="text-base font-medium">Hour &times; Weekday heatmap</CardTitle>
              <CardDescription>
                Average net sales per weekday + hour, across {query.data.daysInWindow} days
                ({query.data.windowStart} → {query.data.windowEnd}).
                {query.data.peakCell ? (
                  <>
                    {" "}
                    Peak cell:{" "}
                    <span className="font-medium text-foreground">
                      {WEEKDAY_LABELS[query.data.peakCell.weekday]} {hourLabel(query.data.peakCell.hour)}
                    </span>{" "}
                    at {formatCents(query.data.peakCell.netSalesCents)} avg.
                  </>
                ) : null}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <DaypartsHeatmap view={query.data} />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base font-medium">Daypart revenue mix</CardTitle>
              <CardDescription>
                How each daypart contributes to net sales over the same window. Breakfast 5–10,
                lunch 11–14, dinner 17–21; everything else is off-peak.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <DaypartMixChart view={query.data} />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base font-medium">Hour-of-day curves by weekday</CardTitle>
              <CardDescription>
                Each line is the average revenue shape of a single weekday. Friday and Saturday
                get slightly thicker strokes to highlight weekend rhythm.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <WeekdayCurvesChart view={query.data} />
            </CardContent>
          </Card>
        </>
      ) : null}
    </div>
  );
}
