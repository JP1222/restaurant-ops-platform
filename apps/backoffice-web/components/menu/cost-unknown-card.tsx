"use client";

import Link from "next/link";
import { ArrowUpRight, Info } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { formatCents, formatCount } from "@/lib/format";
import type { CostUnknownItem } from "@/lib/menu/kasavana-smith";

export interface CostUnknownCardProps {
  items: CostUnknownItem[];
}

/**
 * Items that sold but have no plate cost on file. They are excluded from the
 * matrix entirely — missing cost is never treated as $0, which would falsely
 * mark a high-price item a Star (invariant #6).
 */
export function CostUnknownCard({ items }: CostUnknownCardProps) {
  if (items.length === 0) return null;

  return (
    <Card className="border-dashed bg-muted/30">
      <CardContent className="flex flex-col gap-4 p-4 sm:flex-row sm:items-start">
        <div
          className="flex size-9 shrink-0 items-center justify-center rounded-full"
          style={{ background: "var(--accent-soft)" }}
        >
          <Info className="size-[18px]" style={{ color: "var(--accent)" }} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span className="font-medium">
              {items.length} {items.length === 1 ? "item needs" : "items need"} a recipe
            </span>
            <span className="text-xs text-muted-foreground">excluded from the matrix</span>
            <Link
              href="/inventory?tab=recipes"
              className="ml-auto inline-flex items-center gap-1 text-xs font-medium text-accent hover:underline"
            >
              Add recipes <ArrowUpRight className="size-3.5" />
            </Link>
          </div>
          <p className="mt-1 max-w-prose text-xs leading-relaxed text-muted-foreground">
            These items have no plate cost on file, so their contribution margin is
            unknown. They are left out of the quadrants entirely — we never assume a cost
            of $0, which would falsely mark a high-price item a Star.
          </p>
          <ul className="mt-3 divide-y divide-border/70 rounded-lg border bg-card">
            {items.map((item) => (
              <li
                key={item.item_fingerprint}
                className="flex items-center justify-between gap-3 px-3 py-2 text-sm"
              >
                <span className="truncate font-medium">{item.item_name}</span>
                <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                  {formatCount(item.units)} units &middot;{" "}
                  {formatCents(item.unit_price_cents)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      </CardContent>
    </Card>
  );
}
