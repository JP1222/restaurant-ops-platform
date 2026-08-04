"use client";

import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle
} from "@/components/ui/sheet";
import { DaypartsHeatmap } from "@/components/dayparts/heatmap";
import { useMenuItemHourly } from "@/hooks/use-menu-item-hourly";
import { useMenuItemModifiers } from "@/hooks/use-menu-item-modifiers";
import { formatCents, formatCount, formatRate } from "@/lib/format";
import {
  QUADRANT_ACTION,
  QUADRANT_COLOR,
  QUADRANT_LABEL
} from "@/lib/menu/quadrant-colors";
import type { MenuEngineeringItem, MenuEngineeringView } from "@/lib/menu/kasavana-smith";

interface KpiTileProps {
  label: string;
  value: string;
  accent?: boolean;
}

function KpiTile({ label, value, accent }: KpiTileProps) {
  return (
    <div className="rounded-lg border bg-card p-3">
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      <div
        className="mt-1 font-mono text-lg font-semibold tabular-nums"
        style={accent ? { color: "var(--trend-up)" } : { color: "var(--foreground)" }}
      >
        {value}
      </div>
    </div>
  );
}

interface ItemDetailContentProps {
  item: MenuEngineeringItem;
  view: MenuEngineeringView;
}

function ItemDetailContent({ item, view }: ItemDetailContentProps) {
  const hourlyQuery = useMenuItemHourly(item.item_fingerprint);
  const modifiersQuery = useMenuItemModifiers(item.item_fingerprint);

  const popular = item.mix >= view.xThreshold;
  const highMargin = item.margin_cents >= view.yThresholdCents;

  return (
    <div className="flex flex-col gap-6 overflow-y-auto px-4 pb-6">
      <section className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <KpiTile label="Unit price" value={formatCents(item.unit_price_cents)} />
        <KpiTile label="Plate cost" value={formatCents(item.plate_cost_cents)} />
        <KpiTile
          label="Contribution margin"
          value={formatCents(item.margin_cents)}
          accent
        />
        <KpiTile label="Margin %" value={formatRate(item.margin_pct)} />
        <KpiTile label="Units sold" value={formatCount(item.units)} />
        <KpiTile label="Menu mix" value={formatRate(item.mix)} />
      </section>

      <section className="rounded-lg border bg-card p-4">
        <div className="flex items-center gap-2 text-sm font-medium">
          <span
            aria-hidden
            className="inline-block size-2 rounded-full"
            style={{ background: QUADRANT_COLOR[item.quadrant] }}
          />
          Why it&apos;s a {QUADRANT_LABEL[item.quadrant]}
        </div>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          {popular ? "Above" : "Below"} the popularity line ({formatRate(item.mix)} vs{" "}
          {formatRate(view.xThreshold)} menu mix) and {highMargin ? "above" : "below"} the
          average margin line ({formatCents(item.margin_cents)} vs{" "}
          {formatCents(view.yThresholdCents)}).
        </p>
        <p className="mt-3 text-sm leading-relaxed">{QUADRANT_ACTION[item.quadrant]}</p>
      </section>

      <section className="flex flex-col gap-2">
        <h3 className="text-sm font-medium text-muted-foreground">When this item sells</h3>
        {hourlyQuery.isLoading ? (
          <Skeleton className="h-[320px] w-full" />
        ) : hourlyQuery.isError ? (
          <p className="text-sm text-muted-foreground">Could not load hourly heatmap.</p>
        ) : hourlyQuery.data ? (
          <DaypartsHeatmap
            view={hourlyQuery.data}
            valueLabel="Color = average gross sales for this item, per weekday + hour"
          />
        ) : (
          <p className="text-sm text-muted-foreground">No sales in the last 56 days.</p>
        )}
      </section>

      <section className="flex flex-col gap-2">
        <h3 className="text-sm font-medium text-muted-foreground">Top modifiers</h3>
        {modifiersQuery.isLoading ? (
          <Skeleton className="h-[160px] w-full" />
        ) : modifiersQuery.isError ? (
          <p className="text-sm text-muted-foreground">Could not load modifiers.</p>
        ) : modifiersQuery.data && modifiersQuery.data.length > 0 ? (
          <ul className="divide-y divide-border tabular-nums">
            {modifiersQuery.data.map((mod, idx) => (
              <li
                key={mod.modifier_name}
                className="grid grid-cols-[24px_1fr_64px_72px_88px] items-baseline gap-2 py-1.5 text-sm"
              >
                <span className="text-muted-foreground">{idx + 1}</span>
                <span className="truncate">{mod.modifier_name}</span>
                <span className="text-right text-muted-foreground">
                  {formatCount(mod.modifier_count)}
                </span>
                <span className="text-right">{formatRate(mod.attach_rate)}</span>
                <span className="text-right font-mono">
                  {formatCents(mod.modifier_total_cents)}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">
            No modifiers for this item in the window.
          </p>
        )}
      </section>

      <div className="flex items-center justify-between rounded-lg bg-muted/50 px-4 py-3 text-sm tabular-nums">
        <span className="text-muted-foreground">Contribution generated</span>
        <span className="font-mono font-semibold">
          {formatCents(item.contribution_cents)}
        </span>
      </div>
    </div>
  );
}

export interface ItemDetailSheetProps {
  item: MenuEngineeringItem | null;
  view: MenuEngineeringView;
  onOpenChange: (open: boolean) => void;
}

export function ItemDetailSheet({ item, view, onOpenChange }: ItemDetailSheetProps) {
  const isOpen = item !== null;

  return (
    <Sheet
      open={isOpen}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onOpenChange(false);
      }}
    >
      <SheetContent side="right" className="sm:max-w-2xl">
        {item ? (
          <>
            <SheetHeader>
              <SheetTitle>{item.item_name}</SheetTitle>
              <SheetDescription className="flex items-center gap-2">
                <span>Rank #{item.rank}</span>
                <span aria-hidden>&middot;</span>
                <Badge variant="outline" className="gap-1.5">
                  <span
                    aria-hidden
                    className="inline-block size-2 rounded-full"
                    style={{ background: QUADRANT_COLOR[item.quadrant] }}
                  />
                  {QUADRANT_LABEL[item.quadrant]}
                </Badge>
              </SheetDescription>
            </SheetHeader>
            <ItemDetailContent item={item} view={view} />
          </>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}
