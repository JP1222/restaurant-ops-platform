"use client";

import { Download } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle
} from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { ActionCards } from "@/components/menu/action-cards";
import { CostUnknownCard } from "@/components/menu/cost-unknown-card";
import { ItemDetailSheet } from "@/components/menu/item-detail-sheet";
import { ItemsTable } from "@/components/menu/items-table";
import { MethodNote } from "@/components/menu/method-note";
import { PopularityControl } from "@/components/menu/popularity-control";
import { QuadrantChart } from "@/components/menu/quadrant-chart";
import { useMenuEngineering } from "@/hooks/use-menu-engineering";
import { classifyMenu, POP_FACTOR_DEFAULT } from "@/lib/menu/kasavana-smith";
import { downloadMenuCsv } from "@/lib/menu/export-csv";
import { parseMenuFilters, serializeMenuFilters } from "@/lib/menu/url-state";
import { useAiAssistantStore } from "@/stores/ai-assistant";

const DAY_PRESETS = [7, 14, 30, 60, 90];

export function MenuPageClient() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const setViewSnapshot = useAiAssistantStore((s) => s.setViewSnapshot);

  const filters = useMemo(
    () => parseMenuFilters(searchParams ?? new URLSearchParams()),
    [searchParams]
  );

  const [popFactor, setPopFactor] = useState(POP_FACTOR_DEFAULT);
  const query = useMenuEngineering(filters.days);

  const view = useMemo(
    () =>
      query.data
        ? classifyMenu(query.data.items, {
            popFactor,
            windowDays: query.data.days
          })
        : null,
    [query.data, popFactor]
  );

  useEffect(() => {
    if (!view) return;
    const qs = searchParams?.toString() ?? "";
    setViewSnapshot({
      view: "menu",
      url: qs ? `${pathname}?${qs}` : pathname,
      data: view,
      capturedAt: new Date().toISOString()
    });
  }, [view, pathname, searchParams, setViewSnapshot]);

  const selectedItem = useMemo(() => {
    if (!filters.item || !view) return null;
    return view.items.find((row) => row.item_fingerprint === filters.item) ?? null;
  }, [filters.item, view]);

  function updateFilters(next: { days?: number; item?: string | null }) {
    const params = serializeMenuFilters({ ...filters, ...next });
    const qs = params.toString();
    router.replace(qs ? `/menu?${qs}` : "/menu", { scroll: false });
  }

  return (
    <div className="mx-auto flex max-w-[1200px] flex-col gap-6 p-6">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Menu engineering</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {view
              ? `${view.activeCount} costed items over the last ${filters.days} days — Kasavana-Smith classification on contribution margin.`
              : `Kasavana-Smith classification over the last ${filters.days} days.`}
          </p>
        </div>
        <Select
          value={String(filters.days)}
          onValueChange={(value) => updateFilters({ days: Number(value) })}
        >
          <SelectTrigger className="w-[160px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {DAY_PRESETS.map((days) => (
              <SelectItem key={days} value={String(days)}>
                Last {days} days
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </header>

      {query.isLoading ? (
        <div className="space-y-4">
          <Skeleton className="h-[460px] w-full" />
          <Skeleton className="h-[320px] w-full" />
        </div>
      ) : query.isError ? (
        <p className="text-sm text-destructive">
          Could not load menu data:{" "}
          {query.error instanceof Error ? query.error.message : "unknown"}
        </p>
      ) : view ? (
        <>
          {view.activeCount > 0 ? (
            <>
              <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
                <Card className="min-w-0">
                  <CardHeader>
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                      <div className="flex flex-col gap-1.5">
                        <CardTitle className="text-base font-medium">
                          Profitability matrix
                        </CardTitle>
                        <CardDescription>
                          Contribution margin vs. menu mix. Click any item to open its
                          breakdown.
                        </CardDescription>
                      </div>
                      <PopularityControl value={popFactor} onChange={setPopFactor} />
                    </div>
                  </CardHeader>
                  <CardContent>
                    <QuadrantChart
                      view={view}
                      onSelect={(fingerprint) => updateFilters({ item: fingerprint })}
                    />
                  </CardContent>
                </Card>
                <ActionCards view={view} />
              </div>

              <CostUnknownCard items={view.costUnknown} />

              <Card>
                <CardHeader>
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex flex-col gap-1.5">
                      <CardTitle className="text-base font-medium">Items</CardTitle>
                      <CardDescription>
                        Ranked by contribution dollars. Tap a column to re-sort.
                      </CardDescription>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      className="shrink-0 gap-1.5"
                      onClick={() => downloadMenuCsv(view)}
                    >
                      <Download className="size-[15px] text-muted-foreground" />
                      Export CSV
                    </Button>
                  </div>
                </CardHeader>
                <CardContent>
                  <ItemsTable
                    view={view}
                    onSelect={(fingerprint) => updateFilters({ item: fingerprint })}
                  />
                </CardContent>
              </Card>

              <MethodNote view={view} />
            </>
          ) : (
            <>
              <Card>
                <CardContent className="py-12 text-center text-sm text-muted-foreground">
                  No costed items sold in the last {filters.days} days. Add recipes so
                  items get a plate cost and appear in the matrix.
                </CardContent>
              </Card>
              <CostUnknownCard items={view.costUnknown} />
            </>
          )}

          <ItemDetailSheet
            item={selectedItem}
            view={view}
            onOpenChange={(open) => {
              if (!open) updateFilters({ item: null });
            }}
          />
        </>
      ) : null}
    </div>
  );
}
