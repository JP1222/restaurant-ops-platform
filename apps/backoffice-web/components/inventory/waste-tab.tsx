"use client";

import * as React from "react";
import { ArrowDownRight, ArrowUpRight, Download, Eye, Plus } from "lucide-react";
import { Cell, Pie, PieChart } from "recharts";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle
} from "@/components/ui/card";
import { ChartContainer, type ChartConfig } from "@/components/ui/chart";
import { useCosts } from "@/hooks/use-costs";
import { formatCents } from "@/lib/format";
import { downloadWasteCsv } from "@/lib/inventory/export-csv";
import { cn } from "@/lib/utils";
import type {
  InventoryDataset,
  InventoryItem,
  InventoryWasteEntry,
  InventoryWasteReason
} from "@rop/contracts";

import { ToneBadge } from "./status-badge";

const TODAY = "2026-05-21";
const YESTERDAY = "2026-05-20";

const fmtTime = (ts: string) => ts.split(" ")[1] ?? ts;
const fmtDate = (ts: string) => ts.split(" ")[0] ?? ts;

function wasteCost(w: InventoryWasteEntry, byId: Record<string, InventoryItem>): number {
  const it = byId[w.sku];
  return it ? Math.round(it.cost_cents * w.qty) : 0;
}

function ReasonDonut({
  slices,
  total
}: {
  slices: { id: string; label: string; color: string; amt: number }[];
  total: number;
}) {
  const config: ChartConfig = Object.fromEntries(
    slices.map((s) => [s.id, { label: s.label, color: s.color }])
  );
  const chartData = slices.map((s) => ({ name: s.id, value: s.amt, fill: s.color }));

  return (
    <div className="flex flex-col items-center gap-5 sm:flex-row">
      <div className="relative">
        <ChartContainer config={config} className="aspect-square h-[144px] w-[144px]">
          <PieChart>
            <Pie
              data={chartData}
              cx="50%"
              cy="50%"
              innerRadius={48}
              outerRadius={64}
              stroke="var(--background)"
              strokeWidth={2}
              dataKey="value"
              nameKey="name"
              isAnimationActive={false}
            >
              {chartData.map((entry) => (
                <Cell key={entry.name} fill={entry.fill} />
              ))}
            </Pie>
          </PieChart>
        </ChartContainer>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Today</div>
          <div className="font-mono text-xl font-medium tabular-nums">{formatCents(total)}</div>
        </div>
      </div>
      <div className="flex-1 space-y-1.5">
        {slices.map((s) => (
          <div key={s.id} className="flex items-center gap-2 text-xs">
            <span
              className="size-2.5 flex-none rounded-sm"
              style={{ background: s.color }}
            />
            <span className="flex-1 text-muted-foreground">{s.label}</span>
            <span className="font-mono tabular-nums">{formatCents(s.amt)}</span>
            <span className="w-9 text-right tabular-nums text-muted-foreground">
              {((s.amt / total) * 100).toFixed(0)}%
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function WasteRow({
  entry,
  byId,
  reasonsById
}: {
  entry: InventoryWasteEntry;
  byId: Record<string, InventoryItem>;
  reasonsById: Record<string, InventoryWasteReason>;
}) {
  const it = byId[entry.sku];
  const r = reasonsById[entry.reason];
  const cost = it ? Math.round(it.cost_cents * entry.qty) : 0;

  return (
    <tr className="border-b border-border last:border-0 hover:bg-secondary/40">
      <td className="px-4 py-3">
        <div className="font-mono text-xs tabular-nums text-muted-foreground">
          {fmtTime(entry.at)}
        </div>
        <div className="font-mono text-[11px] text-muted-foreground/70">{fmtDate(entry.at)}</div>
      </td>
      <td className="px-4 py-3">
        <div className="text-sm font-medium">{it?.name}</div>
        <div className="font-mono text-[11px] text-muted-foreground">{it?.sku}</div>
      </td>
      <td className="px-4 py-3">
        <ToneBadge tone="outline" className="text-[10px]">
          <span className="size-2 rounded-sm" style={{ background: r?.color }} />
          {r?.label}
        </ToneBadge>
      </td>
      <td className="px-4 py-3 text-right font-mono text-sm tabular-nums">
        {entry.qty} <span className="text-muted-foreground">{it?.unit}</span>
      </td>
      <td className="px-4 py-3 text-right font-mono text-sm tabular-nums">{formatCents(cost)}</td>
      <td className="px-4 py-3 text-sm text-muted-foreground">{entry.who}</td>
      <td className="hidden px-4 py-3 lg:table-cell">
        <span className="block max-w-[260px] truncate text-xs text-muted-foreground">
          {entry.notes}
        </span>
      </td>
      <td className="px-4 py-3">
        <div className="flex items-center gap-1.5">
          {entry.photo && (
            <Eye className="size-3.5 text-muted-foreground" aria-label="Photo attached" />
          )}
          {entry.approved ? (
            <ToneBadge tone="accent" className="text-[10px]" dot>
              Posted
            </ToneBadge>
          ) : (
            <ToneBadge tone="warn" className="text-[10px]" dot>
              Pending
            </ToneBadge>
          )}
        </div>
      </td>
    </tr>
  );
}

export interface WasteTabProps {
  data: InventoryDataset;
  onOpenRecord: () => void;
}

export function WasteTab({ data, onOpenRecord }: WasteTabProps) {
  const [reasonFilter, setReasonFilter] = React.useState("all");

  const byId = React.useMemo(
    () => Object.fromEntries(data.items.map((i) => [i.id, i])) as Record<string, InventoryItem>,
    [data.items]
  );
  const reasonsById = React.useMemo(
    () =>
      Object.fromEntries(data.waste_reasons.map((r) => [r.id, r])) as Record<
        string,
        InventoryWasteReason
      >,
    [data.waste_reasons]
  );

  const todayLog = data.waste_log.filter((w) => w.at.startsWith(TODAY));
  const yestLog = data.waste_log.filter((w) => w.at.startsWith(YESTERDAY));

  const todayCost = todayLog.reduce((s, w) => s + wasteCost(w, byId), 0);
  const yestCost = yestLog.reduce((s, w) => s + wasteCost(w, byId), 0);
  const deltaPct = yestCost ? ((todayCost - yestCost) / yestCost) * 100 : 0;

  // Theoretical COGS today from analytics (ADR-0573), replacing the former seeded
  // cogs_trend. Null until costed sales exist today -> the ratio shows an honest
  // dash rather than a fabricated number.
  const costsQuery = useCosts(1);
  const todayCogs = costsQuery.data?.metrics.food_cost_cents?.value ?? null;
  const wasteOfCogs = todayCogs ? (todayCost / todayCogs) * 100 : null;

  const slices = data.waste_reasons
    .map((r) => {
      const amt = todayLog
        .filter((w) => w.reason === r.id)
        .reduce((s, w) => s + wasteCost(w, byId), 0);
      return { id: r.id, label: r.label, color: r.color, amt };
    })
    .filter((s) => s.amt > 0);

  const filteredLog = data.waste_log.filter(
    (w) => reasonFilter === "all" || w.reason === reasonFilter
  );

  const pendingApproval = data.waste_log.filter((w) => !w.approved).length;

  type Offender = { item?: InventoryItem; qty: number; cost: number; events: number };
  const offenderMap: Record<string, Offender> = {};
  for (const w of data.waste_log) {
    const c = wasteCost(w, byId);
    const existing = offenderMap[w.sku] ?? { item: byId[w.sku], qty: 0, cost: 0, events: 0 };
    existing.qty += w.qty;
    existing.cost += c;
    existing.events += 1;
    offenderMap[w.sku] = existing;
  }
  const offenders = Object.values(offenderMap).sort((a, b) => b.cost - a.cost).slice(0, 5);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Today&apos;s waste</CardDescription>
            <CardTitle className="mt-1 font-mono text-2xl font-medium tabular-nums">
              {formatCents(todayCost)}
            </CardTitle>
          </CardHeader>
          <CardContent className="flex items-center gap-1 text-xs">
            {deltaPct < 0 ? (
              <>
                <ArrowDownRight className="size-3 text-trend-up" />
                <span className="font-mono tabular-nums text-trend-up">
                  {deltaPct.toFixed(1)}%
                </span>
              </>
            ) : (
              <>
                <ArrowUpRight className="size-3 text-trend-down" />
                <span className="font-mono tabular-nums text-trend-down">
                  +{deltaPct.toFixed(1)}%
                </span>
              </>
            )}
            <span className="ml-1 text-muted-foreground">vs yesterday</span>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>% of today&apos;s COGS</CardDescription>
            <CardTitle
              className={cn(
                "mt-1 font-mono text-2xl font-medium tabular-nums",
                wasteOfCogs != null && wasteOfCogs > 2 && "text-trend-down"
              )}
            >
              {wasteOfCogs == null ? "—" : `${wasteOfCogs.toFixed(2)}%`}
            </CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">
            {wasteOfCogs == null
              ? "Needs costed sales today"
              : "Target ≤ 1.5% · industry avg ~3%"}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Events logged today</CardDescription>
            <CardTitle className="mt-1 font-mono text-2xl font-medium tabular-nums">
              {todayLog.length}
            </CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">
            {data.waste_log.length} this week
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Pending approval</CardDescription>
            <CardTitle className="mt-1 font-mono text-2xl font-medium tabular-nums">
              {pendingApproval}
            </CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">
            Over {formatCents(data.waste_settings.manager_approval_over_cents)} needs sign-off.
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader>
            <div className="flex items-start justify-between gap-2">
              <div>
                <CardTitle>Today by reason</CardTitle>
                <CardDescription>
                  Where the dollars are going. Slices use the reason taxonomy colors.
                </CardDescription>
              </div>
              <Button size="sm" onClick={onOpenRecord}>
                <Plus className="size-3.5" />
                Record waste
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            {slices.length === 0 ? (
              <p className="py-6 text-sm text-muted-foreground">Nothing logged today.</p>
            ) : (
              <ReasonDonut slices={slices} total={todayCost} />
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Top offending SKUs — week</CardTitle>
            <CardDescription>Reduce waste here first.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2.5">
            {offenders.map((o, i) => (
              <div key={i} className="flex items-center gap-3">
                <div className="flex size-7 items-center justify-center rounded-md bg-secondary font-mono text-xs tabular-nums text-muted-foreground">
                  {i + 1}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{o.item?.name}</div>
                  <div className="text-xs text-muted-foreground">
                    {o.events} events · {o.qty.toFixed(1)} {o.item?.unit}
                  </div>
                </div>
                <div className="font-mono text-sm font-medium tabular-nums">
                  {formatCents(o.cost)}
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <CardTitle>Waste log</CardTitle>
              <CardDescription>All recorded events, newest first.</CardDescription>
            </div>
            <div className="flex items-center gap-2">
              <select
                value={reasonFilter}
                onChange={(e) => setReasonFilter(e.target.value)}
                className="h-9 rounded-md border border-border bg-background px-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              >
                <option value="all">All reasons</option>
                {data.waste_reasons.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.label}
                  </option>
                ))}
              </select>
              <Button
                size="sm"
                variant="outline"
                onClick={() => downloadWasteCsv(filteredLog, data.items)}
                disabled={filteredLog.length === 0}
              >
                <Download className="size-3.5" />
                Export
              </Button>
              <Button size="sm" onClick={onOpenRecord}>
                <Plus className="size-3.5" />
                Record
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div className="-mx-6 overflow-x-auto px-6">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-secondary/30 text-xs text-muted-foreground">
                  <th className="px-4 py-2 text-left font-medium">When</th>
                  <th className="px-4 py-2 text-left font-medium">Item</th>
                  <th className="px-4 py-2 text-left font-medium">Reason</th>
                  <th className="px-4 py-2 text-right font-medium">Qty</th>
                  <th className="px-4 py-2 text-right font-medium">$ impact</th>
                  <th className="px-4 py-2 text-left font-medium">Logged by</th>
                  <th className="hidden px-4 py-2 text-left font-medium lg:table-cell">Notes</th>
                  <th className="px-4 py-2 text-left font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {filteredLog.map((w) => (
                  <WasteRow
                    key={w.id}
                    entry={w}
                    byId={byId}
                    reasonsById={reasonsById}
                  />
                ))}
                {filteredLog.length === 0 && (
                  <tr>
                    <td colSpan={8} className="py-10 text-center text-muted-foreground">
                      No waste matches this filter.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

    </div>
  );
}
