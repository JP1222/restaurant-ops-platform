"use client";

import * as React from "react";
import { ChevronRight, Download, RotateCcw, Search } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { useArchivedItems } from "@/hooks/use-inventory";
import { downloadItemsCsv } from "@/lib/inventory/export-csv";
import { formatUnitCost } from "@/lib/format";
import { STATUS_LABEL, STATUS_TONE, formatCentsCompact, statusOf } from "@/lib/inventory/helpers";
import { cn } from "@/lib/utils";
import type {
  InventoryCategory,
  InventoryDataset,
  InventoryItem,
  InventoryItemStatus
} from "@rop/contracts";

import { AddItemDialog } from "./add-item-dialog";
import { ScanRegisterSheet } from "./scan-register-sheet";
import { ItemThumb } from "./item-thumb";
import { ParBar } from "./par-bar";
import { ToneBadge } from "./status-badge";

// "archived" is a view, not an InventoryItemStatus — soft-deleted items live outside
// the active dataset and are fetched on demand (catalog D1).
type StatusFilter = "all" | InventoryItemStatus | "archived";

const STATUS_FILTERS: { id: StatusFilter; label: string; dotClass: string }[] = [
  { id: "all", label: "All", dotClass: "bg-muted-foreground/50" },
  { id: "critical", label: "Critical", dotClass: "bg-trend-down" },
  { id: "low", label: "Low", dotClass: "bg-amber-500" },
  { id: "ok", label: "Healthy", dotClass: "bg-accent" },
  { id: "over", label: "Overstock", dotClass: "bg-sky-500" },
  { id: "86", label: "86'd", dotClass: "bg-zinc-900 dark:bg-zinc-100" },
  { id: "archived", label: "Archived", dotClass: "bg-muted-foreground/40" }
];

function ItemRow({ item, onPick }: { item: InventoryItem; onPick: (id: string) => void }) {
  const status = statusOf(item);
  const valueCents = item.cost_cents * item.on_hand;
  return (
    <tr
      onClick={() => onPick(item.id)}
      className="cursor-pointer border-b border-border hover:bg-secondary/40"
    >
      <td className="px-4 py-3">
        <div className="flex items-center gap-3">
          <ItemThumb item={item} className="size-9 flex-none" />
          <div className="flex min-w-0 flex-col">
            <span className="truncate text-sm font-medium leading-tight">{item.name}</span>
            <span className="font-mono text-xs text-muted-foreground">{item.sku}</span>
          </div>
        </div>
      </td>
      <td className="hidden px-4 py-3 md:table-cell">
        <span className="text-sm capitalize text-muted-foreground">{item.category}</span>
      </td>
      <td className="px-4 py-3">
        <ToneBadge tone={STATUS_TONE[status]} dot>
          {STATUS_LABEL[status]}
        </ToneBadge>
      </td>
      <td className="hidden px-4 py-3 lg:table-cell">
        <div className="flex items-center gap-3">
          <ParBar item={item} status={status} />
          <span className="whitespace-nowrap font-mono text-xs tabular-nums text-muted-foreground">
            {item.par_min}/{item.par_max}
          </span>
        </div>
      </td>
      <td className="px-4 py-3 text-right">
        <span className="font-mono text-sm tabular-nums">
          {item.on_hand} <span className="text-muted-foreground">{item.unit}</span>
        </span>
      </td>
      <td className="hidden px-4 py-3 text-right lg:table-cell">
        <div className="font-mono text-sm tabular-nums text-muted-foreground">
          {formatUnitCost(item.cost_cents)}
        </div>
        {item.purchase_unit ? (
          <div className="font-mono text-[10px] tabular-nums text-muted-foreground/70">
            {item.purchase_unit} ({item.pack_qty})
          </div>
        ) : null}
      </td>
      <td className="px-4 py-3 text-right">
        <span className="font-mono text-sm tabular-nums">{formatCentsCompact(valueCents)}</span>
      </td>
      <td className="hidden px-4 py-3 xl:table-cell">
        <span className="text-xs text-muted-foreground">{item.vendor}</span>
      </td>
      <td className="hidden px-4 py-3 xl:table-cell">
        <span className="font-mono text-xs tabular-nums text-muted-foreground">
          {item.last_counted}
        </span>
      </td>
      <td className="w-8 px-2 py-3">
        <ChevronRight className="size-4 text-muted-foreground" />
      </td>
    </tr>
  );
}

function ItemCard({ item, onPick }: { item: InventoryItem; onPick: (id: string) => void }) {
  const status = statusOf(item);
  const valueCents = item.cost_cents * item.on_hand;
  return (
    <button
      onClick={() => onPick(item.id)}
      className="w-full rounded-lg border border-border bg-card px-3.5 py-3 text-left transition hover:bg-secondary/40 active:bg-secondary/60"
    >
      <div className="flex items-start gap-3">
        <ItemThumb item={item} className="size-9 flex-none" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[15px] font-medium leading-tight">{item.name}</span>
            <ToneBadge
              tone={STATUS_TONE[status]}
              dot
              className="px-1.5 py-0 text-[10px]"
            >
              {STATUS_LABEL[status]}
            </ToneBadge>
          </div>
          <div className="mt-0.5 font-mono text-[11px] tabular-nums text-muted-foreground">
            {item.sku} · <span className="capitalize">{item.category}</span>
          </div>
        </div>
        <div className="flex-none text-right">
          <div className="font-mono text-[15px] font-medium leading-tight tabular-nums">
            {item.on_hand}{" "}
            <span className="text-xs font-normal text-muted-foreground">{item.unit}</span>
          </div>
          <div className="font-mono text-[11px] tabular-nums text-muted-foreground">
            {formatCentsCompact(valueCents)}
          </div>
        </div>
      </div>
      <div className="mt-2.5 flex items-center gap-2">
        <ParBar item={item} status={status} className="h-1.5 flex-1" />
        <span className="whitespace-nowrap font-mono text-[11px] tabular-nums text-muted-foreground">
          par {item.par_min}/{item.par_max}
        </span>
      </div>
    </button>
  );
}

function ItemsToolbar({
  query,
  setQuery,
  statusFilter,
  setStatusFilter,
  category,
  setCategory,
  categories,
  count,
  total,
  mobile,
  onExport
}: {
  query: string;
  setQuery: (v: string) => void;
  statusFilter: StatusFilter;
  setStatusFilter: (v: StatusFilter) => void;
  category: string;
  setCategory: (v: string) => void;
  categories: InventoryCategory[];
  count: number;
  total: number;
  mobile: boolean;
  onExport: () => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[180px] flex-1 sm:min-w-[220px] sm:max-w-md">
          <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder={mobile ? "Search…" : "Search items, SKU, vendor…"}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className={cn("pl-8", mobile && "h-10")}
          />
        </div>

        <select
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          className={cn(
            "rounded-md border border-border bg-background px-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring",
            mobile ? "h-10" : "h-9"
          )}
        >
          <option value="">All categories</option>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>

        {!mobile && (
          <div className="ml-auto flex items-center gap-1.5">
            <Button size="sm" variant="outline" onClick={onExport} disabled={count === 0}>
              <Download className="size-3.5" />
              Export
            </Button>
            <ScanRegisterSheet categories={categories} mobile={false} />
            <AddItemDialog categories={categories} mobile={false} />
          </div>
        )}
      </div>

      <div
        className={cn(
          "flex items-center gap-2",
          mobile ? "-mx-4 overflow-x-auto px-4 pb-1" : "flex-wrap"
        )}
      >
        {STATUS_FILTERS.map((f) => (
          <button
            key={f.id}
            onClick={() => setStatusFilter(f.id)}
            className={cn(
              "inline-flex flex-none items-center gap-1.5 whitespace-nowrap rounded-full border px-3 text-xs font-medium transition-colors",
              mobile ? "h-8" : "h-7 rounded-md",
              statusFilter === f.id
                ? "border-foreground/30 bg-secondary text-foreground"
                : "border-border bg-background text-muted-foreground hover:bg-secondary/60"
            )}
          >
            <span className={cn("size-1.5 rounded-full", f.dotClass)} />
            {f.label}
          </button>
        ))}
        {!mobile && (
          <>
            <Separator orientation="vertical" className="mx-1 h-4" />
            <span className="text-xs text-muted-foreground">
              Showing{" "}
              <span className="font-mono tabular-nums text-foreground">{count}</span> of{" "}
              {total} items
            </span>
          </>
        )}
      </div>

      {mobile && (
        <div className="-mt-1 flex items-center justify-between">
          <span className="text-xs text-muted-foreground">
            <span className="font-mono tabular-nums text-foreground">{count}</span> of {total}
          </span>
          <div className="flex items-center gap-1.5">
            <Button size="sm" variant="outline">
              <Download className="size-3.5" />
            </Button>
            <ScanRegisterSheet categories={categories} mobile />
            <AddItemDialog categories={categories} mobile />
          </div>
        </div>
      )}
    </div>
  );
}

function ArchivedRow({ item, onRestore }: { item: InventoryItem; onRestore: (id: string) => void }) {
  return (
    <tr className="border-b border-border">
      <td className="px-4 py-3">
        <div className="flex flex-col">
          <span className="text-sm font-medium leading-tight">{item.name}</span>
          <span className="font-mono text-xs text-muted-foreground">{item.sku}</span>
        </div>
      </td>
      <td className="hidden px-4 py-3 md:table-cell">
        <span className="text-sm capitalize text-muted-foreground">{item.category}</span>
      </td>
      <td className="hidden px-4 py-3 xl:table-cell">
        <span className="text-xs text-muted-foreground">{item.vendor}</span>
      </td>
      <td className="hidden px-4 py-3 xl:table-cell">
        <span className="font-mono text-xs tabular-nums text-muted-foreground">
          {item.last_counted}
        </span>
      </td>
      <td className="px-4 py-3 text-right">
        <Button variant="outline" size="sm" onClick={() => onRestore(item.id)}>
          <RotateCcw className="size-3.5" />
          Restore
        </Button>
      </td>
    </tr>
  );
}

function ArchivedView({
  items,
  isLoading,
  isError,
  mobile,
  onRestore
}: {
  items: InventoryItem[];
  isLoading: boolean;
  isError: boolean;
  mobile: boolean;
  onRestore: (id: string) => void;
}) {
  if (isLoading) {
    return (
      <p className="py-12 text-center text-sm text-muted-foreground">Loading archived items…</p>
    );
  }
  if (isError) {
    return (
      <p className="py-12 text-center text-sm text-muted-foreground">
        Couldn&rsquo;t load archived items.
      </p>
    );
  }
  if (items.length === 0) {
    return (
      <p className="py-12 text-center text-sm text-muted-foreground">No archived items.</p>
    );
  }
  if (mobile) {
    return (
      <div className="space-y-2">
        {items.map((item) => (
          <div
            key={item.id}
            className="flex items-center gap-3 rounded-lg border border-border bg-card px-3.5 py-3"
          >
            <div className="min-w-0 flex-1">
              <div className="text-[15px] font-medium leading-tight">{item.name}</div>
              <div className="mt-0.5 font-mono text-[11px] tabular-nums text-muted-foreground">
                {item.sku} · <span className="capitalize">{item.category}</span>
              </div>
            </div>
            <Button variant="outline" size="sm" onClick={() => onRestore(item.id)}>
              <RotateCcw className="size-3.5" />
              Restore
            </Button>
          </div>
        ))}
      </div>
    );
  }
  return (
    <Card className="overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-secondary/30">
              <th className="px-4 py-2 text-left">Item</th>
              <th className="hidden px-4 py-2 text-left md:table-cell">Category</th>
              <th className="hidden px-4 py-2 text-left xl:table-cell">Vendor</th>
              <th className="hidden px-4 py-2 text-left xl:table-cell">Last counted</th>
              <th className="px-4 py-2 text-right">Action</th>
            </tr>
          </thead>
          <tbody>
            {items.map((it) => (
              <ArchivedRow key={it.id} item={it} onRestore={onRestore} />
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

export interface ItemsTabProps {
  data: InventoryDataset;
  mobile: boolean;
  onPick: (id: string) => void;
  onRestore: (id: string) => void;
}

export function ItemsTab({ data, mobile, onPick, onRestore }: ItemsTabProps) {
  const [query, setQuery] = React.useState("");
  const [statusFilter, setStatusFilter] = React.useState<StatusFilter>("all");
  const [category, setCategory] = React.useState("");

  const archivedMode = statusFilter === "archived";
  const archivedQuery = useArchivedItems(archivedMode);

  const matchesSearchCategory = React.useCallback(
    (it: InventoryItem) => {
      if (category && it.category !== category) return false;
      if (query) {
        const q = query.toLowerCase();
        if (
          !it.name.toLowerCase().includes(q) &&
          !it.sku.toLowerCase().includes(q) &&
          !it.vendor.toLowerCase().includes(q)
        ) {
          return false;
        }
      }
      return true;
    },
    [query, category]
  );

  const filtered = React.useMemo(() => {
    if (archivedMode) return [];
    return data.items.filter((it) => {
      if (statusFilter !== "all" && statusOf(it) !== statusFilter) return false;
      return matchesSearchCategory(it);
    });
  }, [data.items, statusFilter, archivedMode, matchesSearchCategory]);

  const archivedFiltered = React.useMemo(
    () => (archivedQuery.data ?? []).filter(matchesSearchCategory),
    [archivedQuery.data, matchesSearchCategory]
  );

  const count = archivedMode ? archivedFiltered.length : filtered.length;
  const total = archivedMode ? archivedQuery.data?.length ?? 0 : data.items.length;

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className={mobile ? "px-3 pb-3 pt-3" : "pt-5"}>
          <ItemsToolbar
            query={query}
            setQuery={setQuery}
            statusFilter={statusFilter}
            setStatusFilter={setStatusFilter}
            category={category}
            setCategory={setCategory}
            categories={data.categories}
            count={count}
            total={total}
            mobile={mobile}
            onExport={() =>
              downloadItemsCsv(archivedMode ? archivedFiltered : filtered, data.categories)
            }
          />
        </CardContent>
      </Card>

      {archivedMode ? (
        <ArchivedView
          items={archivedFiltered}
          isLoading={archivedQuery.isLoading}
          isError={archivedQuery.isError}
          mobile={mobile}
          onRestore={onRestore}
        />
      ) : mobile ? (
        <MobileCardList items={filtered} onPick={onPick} />
      ) : (
        <Card className="overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-secondary/30">
                  <th className="px-4 py-2 text-left">Item</th>
                  <th className="hidden px-4 py-2 text-left md:table-cell">Category</th>
                  <th className="px-4 py-2 text-left">Status</th>
                  <th className="hidden px-4 py-2 text-left lg:table-cell">Par level</th>
                  <th className="px-4 py-2 text-right">On hand</th>
                  <th className="hidden px-4 py-2 text-right lg:table-cell">Unit cost</th>
                  <th className="px-4 py-2 text-right">Value</th>
                  <th className="hidden px-4 py-2 text-left xl:table-cell">Vendor</th>
                  <th className="hidden px-4 py-2 text-left xl:table-cell">Last counted</th>
                  <th className="w-8 px-2 py-2" />
                </tr>
              </thead>
              <tbody>
                {filtered.map((it) => (
                  <ItemRow key={it.id} item={it} onPick={onPick} />
                ))}
                {filtered.length === 0 && (
                  <tr>
                    <td colSpan={10} className="py-12 text-center text-muted-foreground">
                      No items match your filters.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}

function MobileCardList({
  items,
  onPick
}: {
  items: InventoryItem[];
  onPick: (id: string) => void;
}) {
  if (items.length === 0) {
    return (
      <p className="py-12 text-center text-sm text-muted-foreground">
        No items match your filters.
      </p>
    );
  }
  const order: InventoryItemStatus[] = ["86", "critical", "low", "ok", "over"];
  const groups = order
    .map((s) => ({
      status: s,
      label: STATUS_LABEL[s],
      items: items.filter((it) => statusOf(it) === s)
    }))
    .filter((g) => g.items.length > 0);
  return (
    <div className="space-y-5">
      {groups.map((g) => (
        <section key={g.status}>
          <h3 className="mb-2 flex items-center gap-2 px-0.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            {g.label}
            <span className="font-mono tabular-nums opacity-80">{g.items.length}</span>
          </h3>
          <div className="space-y-2">
            {g.items.map((it) => (
              <ItemCard key={it.id} item={it} onPick={onPick} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
