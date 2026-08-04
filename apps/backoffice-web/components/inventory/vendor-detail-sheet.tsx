"use client";

import { Archive, CheckCircle, Pencil, Plus, Truck } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle
} from "@/components/ui/card";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { formatCents } from "@/lib/format";
import { formatCentsCompact, formatRatePct } from "@/lib/inventory/helpers";
import { cn } from "@/lib/utils";
import type { InventoryDataset, InventoryVendor } from "@rop/contracts";

import { ToneBadge } from "./status-badge";

function scoreColor(value: number): string {
  if (value >= 0.95) return "bg-accent";
  if (value >= 0.85) return "bg-amber-500";
  return "bg-trend-down";
}

function ScoreBar({ label, value }: { label: string; value: number }) {
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

function TrendBars({ trend }: { trend: number[] }) {
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

function VendorDetailContent({
  vendor,
  data,
  onPickSku,
  onEdit,
  onArchive,
  onNewPo,
  mobile
}: {
  vendor: InventoryVendor;
  data: InventoryDataset;
  onPickSku?: (id: string) => void;
  onEdit?: (vendor: InventoryVendor) => void;
  onArchive?: (id: string) => void;
  onNewPo?: (vendorName: string) => void;
  mobile: boolean;
}) {
  const skusFromVendor = data.items.filter((it) => {
    const q = data.vendor_quotes.find((qq) => qq.sku === it.id);
    if (q) return q.quotes.some((qx) => qx.vid === vendor.id && qx.primary);
    return it.vendor === vendor.name;
  });

  const comparison = data.vendor_quotes
    .filter((q) => q.quotes.some((qx) => qx.vid === vendor.id))
    .map((q) => {
      const it = data.items.find((i) => i.id === q.sku);
      const here = q.quotes.find((qx) => qx.vid === vendor.id);
      const others = q.quotes.filter((qx) => qx.vid !== vendor.id);
      const first = q.quotes[0];
      const best = first ? q.quotes.reduce((m, qx) => (qx.cents < m.cents ? qx : m), first) : null;
      return { it, here, others, best };
    })
    .filter((row) => row.it && row.here && row.best) as {
    it: NonNullable<ReturnType<typeof data.items.find>>;
    here: NonNullable<(typeof data.vendor_quotes)[number]["quotes"][number]>;
    others: (typeof data.vendor_quotes)[number]["quotes"];
    best: NonNullable<(typeof data.vendor_quotes)[number]["quotes"][number]>;
  }[];

  const recentPos = data.pos.filter((p) => p.vendor === vendor.name).slice(0, 6);
  const totalMonthlyPurchases = data.vendors.reduce((s, v) => s + v.spend_30d, 0);

  return (
    <div className="flex h-full flex-col">
      <header
        className={cn(
          "flex flex-none items-start gap-3 border-b border-border",
          mobile ? "px-4 py-3 pr-12" : "p-5 pr-12"
        )}
      >
        <div className="flex size-12 flex-none items-center justify-center rounded-lg bg-secondary">
          <span className="text-base font-semibold tracking-tight">
            {vendor.name.split(" ").slice(0, 2).map((w) => w[0]).join("").toUpperCase()}
          </span>
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-lg font-semibold tracking-tight">{vendor.name}</h2>
            {vendor.preferred && (
              <ToneBadge tone="accent" className="text-[10px]">
                Preferred
              </ToneBadge>
            )}
            <ToneBadge tone="outline" className="text-[10px]">
              {vendor.type}
            </ToneBadge>
          </div>
          <div className="mt-0.5 text-xs text-muted-foreground">
            {vendor.contact} · <span className="font-mono">{vendor.phone}</span> ·{" "}
            <span className="font-mono">{vendor.email}</span>
          </div>
          <div className="mt-0.5 font-mono text-xs text-muted-foreground">
            Account {vendor.account}
          </div>
        </div>
      </header>

      <div className="flex-1 space-y-6 overflow-y-auto p-5">
        <section className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <div className="rounded-lg border border-border p-3">
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Terms</div>
            <div className="mt-1 text-sm font-medium">{vendor.terms}</div>
          </div>
          <div className="rounded-lg border border-border p-3">
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
              Min order
            </div>
            <div className="mt-1 font-mono text-sm font-medium tabular-nums">
              {formatCents(vendor.min_order_cents)}
            </div>
          </div>
          <div className="rounded-lg border border-border p-3">
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Cutoff</div>
            <div className="mt-1 text-sm font-medium">{vendor.cutoff}</div>
          </div>
          <div className="rounded-lg border border-border p-3">
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
              Delivery
            </div>
            <div className="mt-1 text-sm font-medium">{vendor.delivery_days.join(", ")}</div>
          </div>
        </section>

        <section className="rounded-xl border border-border p-4">
          <div className="mb-3 flex items-center justify-between">
            <div>
              <div className="text-sm font-medium">Performance — last 90 days</div>
              <div className="text-xs text-muted-foreground">From received PO reconciliation.</div>
            </div>
            <ToneBadge tone="outline" className="text-[10px]">
              {vendor.credits_90d} credit{vendor.credits_90d !== 1 ? "s" : ""} issued
            </ToneBadge>
          </div>
          <div className="grid grid-cols-3 gap-4">
            <ScoreBar label="Fill rate" value={vendor.fill_rate} />
            <ScoreBar label="On-time" value={vendor.on_time} />
            <ScoreBar label="Price stability" value={vendor.price_stability} />
          </div>
        </section>

        <section className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Card className="sm:col-span-1">
            <CardHeader className="pb-2">
              <CardDescription>30-day spend</CardDescription>
              <CardTitle className="mt-1 font-mono text-2xl font-medium tabular-nums">
                {formatCents(vendor.spend_30d)}
              </CardTitle>
            </CardHeader>
            <CardContent className="text-xs text-muted-foreground">
              {((vendor.spend_30d / totalMonthlyPurchases) * 100).toFixed(1)}% of monthly purchases
            </CardContent>
          </Card>
          <Card className="sm:col-span-2">
            <CardHeader className="pb-2">
              <CardDescription>Weekly trend</CardDescription>
            </CardHeader>
            <CardContent>
              <TrendBars trend={vendor.trend_4w} />
              <div className="mt-1.5 grid grid-cols-4 text-center font-mono text-[10px] tabular-nums text-muted-foreground">
                {vendor.trend_4w.map((c, i) => (
                  <span key={i}>{formatCentsCompact(c)}</span>
                ))}
              </div>
            </CardContent>
          </Card>
        </section>

        <section>
          <div className="mb-2 flex items-center justify-between">
            <div>
              <div className="text-sm font-medium">
                Catalog — primary SKUs ({skusFromVendor.length})
              </div>
              <div className="text-xs text-muted-foreground">
                Items you mostly buy from this vendor.
              </div>
            </div>
            <Button size="sm" variant="ghost">
              View all
            </Button>
          </div>
          <div className="max-h-[200px] divide-y divide-border overflow-y-auto rounded-lg border border-border">
            {skusFromVendor.length === 0 && (
              <div className="p-3 text-sm text-muted-foreground">No primary SKUs assigned.</div>
            )}
            {skusFromVendor.map((it) => (
              <button
                key={it.id}
                onClick={() => onPickSku?.(it.id)}
                className="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-secondary/40"
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{it.name}</div>
                  <div className="font-mono text-[11px] text-muted-foreground">{it.sku}</div>
                </div>
                <div className="text-right">
                  <div className="font-mono text-sm tabular-nums">
                    {formatCents(it.cost_cents)}
                  </div>
                  <div className="text-[11px] text-muted-foreground">/{it.unit}</div>
                </div>
              </button>
            ))}
          </div>
        </section>

        {comparison.length > 0 && (
          <section>
            <div className="mb-2">
              <div className="text-sm font-medium">Price comparison vs other vendors</div>
              <div className="text-xs text-muted-foreground">
                Cheapest highlighted; spread shows leverage room.
              </div>
            </div>
            <div className="overflow-hidden rounded-lg border border-border">
              <table className="w-full text-sm">
                <thead className="bg-secondary/40 text-xs text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 text-left font-medium">Item</th>
                    <th className="px-3 py-2 text-right font-medium">{vendor.name}</th>
                    <th className="px-3 py-2 text-right font-medium">Alternates</th>
                    <th className="px-3 py-2 text-right font-medium">Spread</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {comparison.map(({ it, here, others, best }) => {
                    const cheapest = best.vid === vendor.id;
                    const spread = ((here.cents - best.cents) / best.cents) * 100;
                    return (
                      <tr key={it.id}>
                        <td className="px-3 py-2">
                          <div className="max-w-[180px] truncate font-medium">{it.name}</div>
                          <div className="text-[11px] text-muted-foreground">/{it.unit}</div>
                        </td>
                        <td className="px-3 py-2 text-right">
                          <span
                            className={cn(
                              "font-mono tabular-nums",
                              cheapest && "font-semibold text-trend-up"
                            )}
                          >
                            {formatCents(here.cents)}
                          </span>
                          {cheapest && (
                            <CheckCircle className="ml-1 inline size-3 text-trend-up" />
                          )}
                        </td>
                        <td className="px-3 py-2 text-right">
                          <div className="space-y-0.5">
                            {others.map((o) => (
                              <div
                                key={o.vid}
                                className="font-mono text-xs tabular-nums"
                              >
                                <span className="mr-1 text-muted-foreground">
                                  {data.vendors.find((vv) => vv.id === o.vid)?.name.split(" ")[0]}
                                </span>
                                {formatCents(o.cents)}
                              </div>
                            ))}
                          </div>
                        </td>
                        <td className="px-3 py-2 text-right">
                          <span
                            className={cn(
                              "font-mono text-xs tabular-nums",
                              spread > 5 ? "text-trend-down" : "text-muted-foreground"
                            )}
                          >
                            {cheapest ? "—" : `+${spread.toFixed(1)}%`}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        )}

        <section>
          <div className="mb-2 text-sm font-medium">Recent purchase orders</div>
          <div className="divide-y divide-border rounded-lg border border-border">
            {recentPos.length === 0 && (
              <div className="p-3 text-sm text-muted-foreground">No POs this week.</div>
            )}
            {recentPos.map((po) => (
              <div key={po.id} className="flex items-center gap-3 px-3 py-2">
                <Truck className="size-4 flex-none text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <div className="font-mono text-sm tabular-nums">{po.id}</div>
                  <div className="text-[11px] text-muted-foreground">
                    Placed {po.placed} · {po.lines} lines
                  </div>
                </div>
                <ToneBadge
                  tone={
                    po.status === "received"
                      ? "accent"
                      : po.status === "in-transit"
                        ? "warn"
                        : "info"
                  }
                  className="text-[10px]"
                  dot
                >
                  {po.status}
                </ToneBadge>
                <div className="w-20 text-right font-mono text-sm tabular-nums">
                  {formatCents(po.total_cents)}
                </div>
              </div>
            ))}
          </div>
        </section>
      </div>

      <footer className="flex flex-none items-center gap-2 border-t border-border p-4">
        <Button variant="outline" onClick={() => onEdit?.(vendor)}>
          <Pencil className="size-3.5" />
          Edit vendor
        </Button>
        <Button
          variant="outline"
          className="text-trend-down hover:text-trend-down"
          onClick={() => onArchive?.(vendor.id)}
        >
          <Archive className="size-3.5" />
          Archive
        </Button>
        <div className="ml-auto" />
        <Button onClick={() => onNewPo?.(vendor.name)}>
          <Plus className="size-3.5" />
          New PO
        </Button>
      </footer>
    </div>
  );
}

export interface VendorDetailSheetProps {
  openId: string | null;
  data: InventoryDataset;
  onClose: () => void;
  onPickSku?: (id: string) => void;
  onEdit?: (vendor: InventoryVendor) => void;
  onArchive?: (id: string) => void;
  onNewPo?: (vendorName: string) => void;
  mobile: boolean;
}

export function VendorDetailSheet({
  openId,
  data,
  onClose,
  onPickSku,
  onEdit,
  onArchive,
  onNewPo,
  mobile
}: VendorDetailSheetProps) {
  const vendor = openId ? data.vendors.find((v) => v.id === openId) : null;
  const open = Boolean(vendor);

  return (
    <Sheet open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <SheetContent
        side={mobile ? "bottom" : "right"}
        className={cn(
          "p-0 sm:max-w-[680px]",
          mobile && "max-h-[92vh] rounded-t-2xl border-t"
        )}
      >
        <SheetTitle className="sr-only">{vendor ? vendor.name : "Vendor detail"}</SheetTitle>
        {vendor ? (
          <VendorDetailContent
            vendor={vendor}
            data={data}
            onPickSku={onPickSku}
            onEdit={onEdit}
            onArchive={onArchive}
            onNewPo={onNewPo}
            mobile={mobile}
          />
        ) : null}
      </SheetContent>
    </Sheet>
  );
}
