"use client";

import { useState } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useTrendsBreakdown } from "@/hooks/use-trends-breakdown";
import { toShares, type SegmentDim } from "@/lib/trends/breakdown";
import { formatCents, formatRate } from "@/lib/format";

const CHART_VARS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
  "var(--chart-6)",
];

const DIMS: { key: SegmentDim; label: string; note: string }[] = [
  { key: "order_type", label: "Order Type", note: "Net sales by order type" },
  { key: "tender", label: "Tender", note: "Payment amount by tender" },
  { key: "daypart", label: "Daypart", note: "Net sales by daypart" },
];

export function SegmentBreakdown({ from, to }: { from: string; to: string }) {
  const [dim, setDim] = useState<SegmentDim>("order_type");
  const query = useTrendsBreakdown(from, to);
  const active = DIMS.find((d) => d.key === dim) ?? DIMS[0]!;
  const slices = query.data ? toShares(dim, query.data[dim]) : [];
  const hasData = slices.some((slice) => slice.value_cents > 0);

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex flex-col gap-1">
            <CardTitle className="text-base font-medium">Segment breakdown</CardTitle>
            <CardDescription>
              {active.note} · {from} to {to}
            </CardDescription>
          </div>
          <Tabs value={dim} onValueChange={(value) => setDim(value as SegmentDim)}>
            <TabsList>
              {DIMS.map((d) => (
                <TabsTrigger key={d.key} value={d.key}>
                  {d.label}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        </div>
      </CardHeader>
      <CardContent>
        {query.isLoading ? (
          <Skeleton className="h-[180px] w-full" />
        ) : query.isError ? (
          <p className="text-sm text-destructive">
            {query.error instanceof Error ? query.error.message : "Could not load breakdown."}
          </p>
        ) : hasData ? (
          <div className="flex flex-col gap-4">
            <div className="flex h-3 w-full overflow-hidden rounded-full">
              {slices
                .filter((slice) => slice.share > 0)
                .map((slice, index) => (
                  <div
                    key={slice.key}
                    style={{
                      width: `${slice.share * 100}%`,
                      background: CHART_VARS[index % CHART_VARS.length],
                    }}
                    title={`${slice.label} · ${formatRate(slice.share)}`}
                  />
                ))}
            </div>
            <div className="flex flex-col gap-1.5">
              {slices.map((slice, index) => (
                <div key={slice.key} className="flex items-center gap-3 text-sm">
                  <span
                    aria-hidden
                    className="size-2.5 shrink-0 rounded-full"
                    style={{ background: CHART_VARS[index % CHART_VARS.length] }}
                  />
                  <span className="flex-1 truncate">{slice.label}</span>
                  <span className="w-24 text-right font-mono tabular-nums">
                    {formatCents(slice.value_cents)}
                  </span>
                  <span className="w-14 text-right font-mono tabular-nums text-muted-foreground">
                    {formatRate(slice.share)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <p className="text-muted-foreground text-sm">No data in this range.</p>
        )}
      </CardContent>
    </Card>
  );
}
