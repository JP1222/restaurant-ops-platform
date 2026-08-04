"use client";

import { useEffect, useMemo } from "react";
import { AlertCircle } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ComparisonChart, ComparisonChartSkeleton } from "@/components/compare/comparison-chart";
import { DateRangeButton } from "@/components/trends/date-range-button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useCompare } from "@/hooks/use-compare";
import {
  COMPARE_PRESETS,
  parseCompareFilters,
  serializeCompareFilters,
  type CompareFilters,
} from "@/lib/compare/url-state";
import { useAiAssistantStore } from "@/stores/ai-assistant";

export function ComparePageClient() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const setViewSnapshot = useAiAssistantStore((s) => s.setViewSnapshot);
  const filters = useMemo(
    () => parseCompareFilters(new URLSearchParams(searchParams.toString())),
    [searchParams],
  );
  const compare = useCompare(filters);

  useEffect(() => {
    if (!compare.data) return;
    const qs = searchParams.toString();
    setViewSnapshot({
      view: "compare",
      url: qs ? `${pathname}?${qs}` : pathname,
      data: compare.data,
      capturedAt: new Date().toISOString(),
    });
  }, [compare.data, pathname, searchParams, setViewSnapshot]);

  function update(partial: Partial<CompareFilters>) {
    const next = { ...filters, ...partial };
    router.replace(`/compare?${serializeCompareFilters(next).toString()}`, { scroll: false });
  }

  function applyPreset(presetId: string) {
    const preset = COMPARE_PRESETS.find((item) => item.id === presetId);
    if (!preset) return;

    update(preset.apply());
  }

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-3xl font-medium tracking-tight">Compare</h1>
        <p className="text-muted-foreground">
          Side-by-side comparison of any two periods, aligned by relative position.
        </p>
      </header>

      <div className="flex flex-wrap items-center gap-2">
        {COMPARE_PRESETS.map((preset) => (
          <Button
            key={preset.id}
            variant="outline"
            size="sm"
            onClick={() => applyPreset(preset.id)}
          >
            {preset.label}
          </Button>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-muted-foreground text-sm">Primary</span>
          <DateRangeButton
            from={filters.primary_from}
            to={filters.primary_to}
            onChange={(from, to) => update({ primary_from: from, primary_to: to })}
          />
        </div>
        <span className="text-muted-foreground text-sm">vs</span>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-muted-foreground text-sm">Comparison</span>
          <DateRangeButton
            from={filters.compare_from}
            to={filters.compare_to}
            onChange={(from, to) => update({ compare_from: from, compare_to: to })}
          />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Tabs
          value={filters.metric}
          onValueChange={(value) => update({ metric: value as CompareFilters["metric"] })}
        >
          <TabsList>
            <TabsTrigger value="net_sales">Net Sales</TabsTrigger>
            <TabsTrigger value="orders">Orders</TabsTrigger>
            <TabsTrigger value="avg_ticket">Avg Ticket</TabsTrigger>
            <TabsTrigger value="refund_rate">Refund Rate</TabsTrigger>
            <TabsTrigger value="discounts">Discounts</TabsTrigger>
          </TabsList>
        </Tabs>

        <Tabs
          value={filters.grain}
          onValueChange={(value) => update({ grain: value as CompareFilters["grain"] })}
        >
          <TabsList>
            <TabsTrigger value="day">Day</TabsTrigger>
            <TabsTrigger value="week">Week</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      {compare.isError ? (
        <Alert variant="destructive">
          <AlertCircle className="size-4" />
          <AlertTitle>Could not load comparison</AlertTitle>
          <AlertDescription>
            {compare.error instanceof Error ? compare.error.message : "Unknown error."}
          </AlertDescription>
        </Alert>
      ) : null}

      {compare.isLoading ? (
        <ComparisonChartSkeleton />
      ) : compare.data ? (
        <ComparisonChart data={compare.data} />
      ) : null}
    </div>
  );
}
