"use client";

import * as React from "react";
import { ChevronRight, Download, Plus, RotateCcw, Search } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useArchiveVendor, useArchivedVendors } from "@/hooks/use-inventory";
import { formatCents } from "@/lib/format";
import { downloadVendorsCsv } from "@/lib/inventory/export-csv";
import { formatRatePct } from "@/lib/inventory/helpers";
import { cn } from "@/lib/utils";
import type { InventoryDataset, InventoryVendor } from "@rop/contracts";

import { NewPoBuilder } from "./new-po-builder";
import { ToneBadge } from "./status-badge";
import { VendorDetailSheet } from "./vendor-detail-sheet";
import { VendorDialog } from "./vendor-dialog";

function scoreColor(value: number): string {
  if (value >= 0.95) return "bg-accent";
  if (value >= 0.85) return "bg-amber-500";
  return "bg-trend-down";
}

function MiniScoreBar({ label, value }: { label: string; value: number }) {
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-mono font-medium tabular-nums">{formatRatePct(value)}</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-secondary">
        <div className={cn("h-full", scoreColor(value))} style={{ width: `${value * 100}%` }} />
      </div>
    </div>
  );
}

function MiniTrendBars({ trend }: { trend: number[] }) {
  const max = Math.max(...trend) * 1.1;
  return (
    <div className="flex h-10 items-end gap-1">
      {trend.map((v, i) => (
        <div
          key={i}
          className={cn(
            "flex-1 rounded-sm",
            i === trend.length - 1 ? "bg-accent" : "bg-accent/40"
          )}
          style={{ height: `${(v / max) * 100}%` }}
          title={formatCents(v)}
        />
      ))}
    </div>
  );
}

function VendorRow({
  vendor,
  onPick
}: {
  vendor: InventoryVendor;
  onPick: (id: string) => void;
}) {
  return (
    <tr
      onClick={() => onPick(vendor.id)}
      className="cursor-pointer border-b border-border hover:bg-secondary/40"
    >
      <td className="px-4 py-3">
        <div className="flex items-center gap-3">
          <div className="flex size-9 flex-none items-center justify-center rounded-md bg-secondary">
            <span className="text-[11px] font-semibold tracking-tight">
              {vendor.name.split(" ").slice(0, 2).map((w) => w[0]).join("").toUpperCase()}
            </span>
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="truncate text-sm font-medium">{vendor.name}</span>
              {vendor.preferred && (
                <ToneBadge tone="accent" className="px-1.5 py-0 text-[10px]">
                  Preferred
                </ToneBadge>
              )}
            </div>
            <div className="truncate text-xs text-muted-foreground">
              {vendor.type} · {vendor.contact}
            </div>
          </div>
        </div>
      </td>
      <td className="hidden px-4 py-3 md:table-cell">
        <div className="flex flex-wrap gap-1">
          {vendor.tags.map((t) => (
            <ToneBadge key={t} tone="outline" className="px-1.5 py-0 text-[10px]">
              {t}
            </ToneBadge>
          ))}
        </div>
      </td>
      <td className="hidden px-4 py-3 lg:table-cell">
        <div className="text-xs">
          <div>{vendor.terms}</div>
          <div className="text-muted-foreground">{vendor.delivery_days.join(" / ")}</div>
        </div>
      </td>
      <td className="hidden w-[150px] px-4 py-3 xl:table-cell">
        <MiniTrendBars trend={vendor.trend_4w} />
      </td>
      <td className="px-4 py-3 text-right">
        <div className="font-mono text-sm font-medium tabular-nums">
          {formatCents(vendor.spend_30d)}
        </div>
        <div className="text-xs text-muted-foreground">30 d</div>
      </td>
      <td className="hidden px-4 py-3 lg:table-cell">
        <div className="flex items-center gap-2">
          <div className="min-w-[60px] flex-1">
            <MiniScoreBar label="Fill" value={vendor.fill_rate} />
          </div>
          <div className="min-w-[60px] flex-1">
            <MiniScoreBar label="On-time" value={vendor.on_time} />
          </div>
        </div>
      </td>
      <td className="w-8 px-2 py-3">
        <ChevronRight className="size-4 text-muted-foreground" />
      </td>
    </tr>
  );
}

function ArchivedVendorList({
  vendors,
  isLoading,
  onRestore
}: {
  vendors: InventoryVendor[];
  isLoading: boolean;
  onRestore: (id: string) => void;
}) {
  if (isLoading) {
    return (
      <p className="py-10 text-center text-sm text-muted-foreground">Loading archived vendors…</p>
    );
  }
  if (vendors.length === 0) {
    return <p className="py-10 text-center text-sm text-muted-foreground">No archived vendors.</p>;
  }
  return (
    <div className="space-y-2">
      {vendors.map((v) => (
        <div
          key={v.id}
          className="flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-3"
        >
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium">{v.name}</div>
            <div className="truncate text-xs text-muted-foreground">
              {v.type || "—"} · {v.contact || "no contact"}
            </div>
          </div>
          <Button variant="outline" size="sm" onClick={() => onRestore(v.id)}>
            <RotateCcw className="size-3.5" />
            Restore
          </Button>
        </div>
      ))}
    </div>
  );
}

export interface VendorsTabProps {
  data: InventoryDataset;
  mobile: boolean;
  onPickSku?: (id: string) => void;
}

export function VendorsTab({ data, mobile, onPickSku }: VendorsTabProps) {
  const [query, setQuery] = React.useState("");
  const [openId, setOpenId] = React.useState<string | null>(null);
  const [typeFilter, setTypeFilter] = React.useState("all");
  const [addOpen, setAddOpen] = React.useState(false);
  const [editVendor, setEditVendor] = React.useState<InventoryVendor | null>(null);
  const [showArchived, setShowArchived] = React.useState(false);
  const [newPoVendor, setNewPoVendor] = React.useState<string | null>(null);
  const archivedQuery = useArchivedVendors(showArchived);
  const archiveVendor = useArchiveVendor();

  const types = React.useMemo(
    () => ["all", ...Array.from(new Set(data.vendors.map((v) => v.type)))],
    [data.vendors]
  );

  const filtered = data.vendors.filter((v) => {
    if (typeFilter !== "all" && v.type !== typeFilter) return false;
    if (query) {
      const q = query.toLowerCase();
      if (!v.name.toLowerCase().includes(q) && !v.contact.toLowerCase().includes(q)) {
        return false;
      }
    }
    return true;
  });

  const totalSpend = data.vendors.reduce((s, v) => s + v.spend_30d, 0);
  const avgFill = data.vendors.reduce((s, v) => s + v.fill_rate, 0) / data.vendors.length;
  const avgOnTime = data.vendors.reduce((s, v) => s + v.on_time, 0) / data.vendors.length;
  const preferred = data.vendors.filter((v) => v.preferred).length;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Spend — 30 days</CardDescription>
            <CardTitle className="mt-1 font-mono text-2xl font-medium tabular-nums">
              {formatCents(totalSpend)}
            </CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">
            {data.vendors.length} vendors
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Avg fill rate</CardDescription>
            <CardTitle className="mt-1 font-mono text-2xl font-medium tabular-nums">
              {formatRatePct(avgFill)}
            </CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">Target ≥ 95%</CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Avg on-time</CardDescription>
            <CardTitle className="mt-1 font-mono text-2xl font-medium tabular-nums">
              {formatRatePct(avgOnTime)}
            </CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">
            PFG below target — review.
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Preferred vendors</CardDescription>
            <CardTitle className="mt-1 font-mono text-2xl font-medium tabular-nums">
              {preferred}
              <span className="text-lg text-muted-foreground"> / {data.vendors.length}</span>
            </CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">
            Contracted pricing in effect.
          </CardContent>
        </Card>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[220px] max-w-md flex-1">
          <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="pl-8"
            placeholder="Search vendors or contacts…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <select
          value={typeFilter}
          onChange={(e) => setTypeFilter(e.target.value)}
          className="h-9 rounded-md border border-border bg-background px-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
        >
          {types.map((t) => (
            <option key={t} value={t}>
              {t === "all" ? "All types" : t}
            </option>
          ))}
        </select>
        <div className="ml-auto flex items-center gap-2">
          <Button
            size="sm"
            variant={showArchived ? "default" : "outline"}
            onClick={() => setShowArchived((s) => !s)}
          >
            {showArchived ? "Active vendors" : "Archived"}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => downloadVendorsCsv(filtered, data.categories)}
            disabled={filtered.length === 0}
          >
            <Download className="size-3.5" />
            Export
          </Button>
          <Button size="sm" onClick={() => setAddOpen(true)}>
            <Plus className="size-3.5" />
            Add vendor
          </Button>
        </div>
      </div>

      {showArchived ? (
        <ArchivedVendorList
          vendors={archivedQuery.data ?? []}
          isLoading={archivedQuery.isLoading}
          onRestore={(id) => archiveVendor.mutate({ id, archived: false })}
        />
      ) : (
      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-secondary/30 text-xs text-muted-foreground">
                <th className="px-4 py-2 text-left font-medium">Vendor</th>
                <th className="hidden px-4 py-2 text-left font-medium md:table-cell">Tags</th>
                <th className="hidden px-4 py-2 text-left font-medium lg:table-cell">
                  Terms · delivery
                </th>
                <th className="hidden px-4 py-2 text-left font-medium xl:table-cell">
                  4 wk trend
                </th>
                <th className="px-4 py-2 text-right font-medium">Spend</th>
                <th className="hidden px-4 py-2 text-left font-medium lg:table-cell">
                  Performance
                </th>
                <th className="w-8 px-2 py-2" />
              </tr>
            </thead>
            <tbody>
              {filtered.map((v) => (
                <VendorRow key={v.id} vendor={v} onPick={setOpenId} />
              ))}
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={7} className="py-10 text-center text-muted-foreground">
                    No vendors match.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>
      )}

      <VendorDetailSheet
        openId={openId}
        data={data}
        onClose={() => setOpenId(null)}
        onPickSku={(id) => {
          setOpenId(null);
          onPickSku?.(id);
        }}
        onEdit={(vendor) => {
          setOpenId(null);
          setEditVendor(vendor);
        }}
        onArchive={(id) => {
          archiveVendor.mutate({ id, archived: true });
          setOpenId(null);
        }}
        onNewPo={(vendorName) => {
          setOpenId(null);
          setNewPoVendor(vendorName);
        }}
        mobile={mobile}
      />

      <VendorDialog
        key="add-vendor"
        open={addOpen}
        onOpenChange={setAddOpen}
        categories={data.categories}
      />
      {editVendor ? (
        <VendorDialog
          key={editVendor.id}
          open
          onOpenChange={(next) => {
            if (!next) setEditVendor(null);
          }}
          vendor={editVendor}
          categories={data.categories}
        />
      ) : null}
      {newPoVendor !== null ? (
        <NewPoBuilder
          key={newPoVendor}
          open
          onOpenChange={(next) => {
            if (!next) setNewPoVendor(null);
          }}
          data={data}
          initialVendor={newPoVendor}
        />
      ) : null}
    </div>
  );
}
