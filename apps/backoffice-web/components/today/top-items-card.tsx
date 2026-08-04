"use client";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import type { TopItemsView } from "@/lib/analytics-api/top-items-transform";
import { formatCents, formatCount } from "@/lib/format";

export interface TopItemsCardProps {
  data: TopItemsView;
}

export function TopItemsCard({ data }: TopItemsCardProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base font-medium">Top 5 Items</CardTitle>
        <CardDescription>
          Highest grossing menu items over the last {data.window_days} days.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {data.top.length === 0 ? (
          <p className="text-muted-foreground text-sm">No item sales found for this window.</p>
        ) : (
          <div className="flex flex-col gap-4">
            {data.top.map((item) => (
              <div key={item.item_fingerprint} className="flex flex-col gap-2">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="bg-muted text-muted-foreground inline-flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-medium tabular-nums">
                        {item.rank}
                      </span>
                      <p className="truncate text-sm font-medium">{item.item_name}</p>
                    </div>
                    <p className="text-muted-foreground mt-1 text-xs">
                      {formatCount(item.quantity)} sold
                      {item.alternate_name ? ` · ${item.alternate_name}` : ""}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="font-mono text-sm font-medium tabular-nums">
                      {formatCents(item.gross_sales_cents)}
                    </p>
                    <p className="text-muted-foreground text-xs">
                      {formatCount(item.line_count)} lines
                    </p>
                  </div>
                </div>
                <div className="bg-muted h-2 overflow-hidden rounded-full">
                  <div
                    className="h-full rounded-full bg-[color:var(--chart-1)]"
                    style={{
                      width: `${Math.min(100, Math.max(0, item.share_of_top * 100)).toFixed(1)}%`,
                    }}
                  />
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function TopItemsCardSkeleton() {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base font-medium">Top 5 Items</CardTitle>
        <CardDescription>Loading item mix.</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex flex-col gap-4">
          {Array.from({ length: 5 }, (_, index) => (
            <div key={index} className="flex flex-col gap-2">
              <div className="flex items-center justify-between gap-4">
                <div className="flex items-center gap-2">
                  <Skeleton className="size-6 rounded-full" />
                  <div className="flex flex-col gap-1.5">
                    <Skeleton className="h-4 w-36" />
                    <Skeleton className="h-3 w-20" />
                  </div>
                </div>
                <Skeleton className="h-5 w-20" />
              </div>
              <Skeleton className="h-2 w-full rounded-full" />
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
