"use client";

import * as React from "react";
import {
  AlertTriangle,
  ChevronRight,
  ClipboardCheck,
  Clock,
  Flame,
  Minus,
  Package,
  Pencil,
  Plug,
  Plus,
  Scale,
  Slash,
  Trash2,
  Truck,
  X
} from "lucide-react";
import { Bar, BarChart, Cell, ReferenceLine, XAxis, YAxis } from "recharts";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ChartContainer, ChartTooltip, type ChartConfig } from "@/components/ui/chart";
import { Input } from "@/components/ui/input";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle
} from "@/components/ui/sheet";
import { useCosts } from "@/hooks/use-costs";
import { useCreatePurchaseOrder } from "@/hooks/use-inventory";
import { formatCents, formatRate } from "@/lib/format";
import {
  STATUS_LABEL,
  STATUS_TONE,
  formatCentsCompact,
  statusOf
} from "@/lib/inventory/helpers";
import { NO_VENDOR_LABEL, buildPosFromCart } from "@/lib/inventory/reorder-cart";
import { cn } from "@/lib/utils";
import type {
  InventoryActivityEntry,
  InventoryCategory,
  InventoryDataset,
  InventoryItem,
  InventoryItemStatus,
  InventoryPurchaseOrder,
  InventoryRecipe
} from "@rop/contracts";

import { ParBar } from "./par-bar";
import { ToneBadge } from "./status-badge";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// Short weekday label for an analytics business_date ("YYYY-MM-DD"). Parsed as UTC
// so the label matches the date the mart attributed the figure to.
function weekdayLabel(isoDate: string): string {
  const day = new Date(`${isoDate}T00:00:00Z`).getUTCDay();
  return WEEKDAYS[day] ?? isoDate.slice(5);
}

// ── shared derivations ─────────────────────────────────────────────────────

function recipeCostCents(
  recipe: InventoryRecipe,
  byId: Record<string, InventoryItem>
): number {
  return recipe.lines.reduce((sum, line) => sum + (byId[line.sku]?.cost_cents ?? 0) * line.qty, 0);
}

function suggestedQty(item: InventoryItem): number {
  return Math.max(1, Math.ceil(item.par_max - item.on_hand));
}

// Status-driven urgency copy. With no per-item daily-use signal in the contract,
// urgency is the par-ratio status (not a fabricated day count).
function urgencyLabel(status: InventoryItemStatus): string {
  if (status === "86") return "86'd on KDS";
  if (status === "critical") return "Critical · below 50% par";
  return "Low · below par";
}

interface QueueRow {
  item: InventoryItem;
  status: InventoryItemStatus;
  qty: number;
}

function buildQueue(items: InventoryItem[], ordered: Record<string, true>): QueueRow[] {
  return items
    .map((item) => ({ item, status: statusOf(item), qty: suggestedQty(item) }))
    .filter(
      (row) =>
        (row.status === "low" || row.status === "critical" || row.status === "86") &&
        !ordered[row.item.id]
    )
    .sort((a, b) => a.item.on_hand / a.item.par_min - b.item.on_hand / b.item.par_min);
}

// ── A. COGS sparkline (recharts via ChartContainer) ────────────────────────

const cogsChartConfig = { pct: { label: "COGS %" } } satisfies ChartConfig;

interface CogsPoint {
  /** business_date, unique per point — used as the React key. */
  date: string;
  day: string;
  pct: number;
  over: boolean;
}

function CogsTooltip({
  active,
  payload,
  targetPct
}: {
  active?: boolean;
  payload?: { payload?: CogsPoint }[];
  targetPct: number;
}) {
  const point = payload?.[0]?.payload;
  if (!active || !point) return null;
  return (
    <div className="grid min-w-28 gap-1 rounded-lg border bg-background px-2.5 py-1.5 text-xs shadow-xl">
      <div className="font-medium">{point.day}</div>
      <div className="flex items-center justify-between gap-5">
        <span className="text-muted-foreground">COGS %</span>
        <span className="font-mono font-medium tabular-nums">{point.pct.toFixed(1)}%</span>
      </div>
      <div className={cn("text-[11px]", point.over ? "text-trend-down" : "text-muted-foreground")}>
        {point.over ? "Over" : "At/under"} target {targetPct}%
      </div>
    </div>
  );
}

function CogsSpark({
  series,
  targetPct,
  loading
}: {
  series: CogsPoint[];
  targetPct: number;
  loading: boolean;
}) {
  if (loading) {
    return <div className="flex h-12 items-center text-[11px] text-muted-foreground">···</div>;
  }
  if (series.length === 0) {
    return (
      <div className="flex h-12 items-center text-[11px] text-muted-foreground">
        No costed sales yet
      </div>
    );
  }
  const pcts = series.map((d) => d.pct);
  const lo = Math.floor(Math.min(...pcts, targetPct) - 1);
  const hi = Math.ceil(Math.max(...pcts, targetPct) + 1);
  const todayOver = series[series.length - 1]?.over ?? false;
  const fill = todayOver ? "var(--trend-down)" : "var(--accent)";

  return (
    <ChartContainer config={cogsChartConfig} className="h-12 w-full">
      <BarChart accessibilityLayer data={series} margin={{ top: 4, right: 0, left: 0, bottom: 0 }}>
        <XAxis dataKey="day" hide />
        <YAxis hide domain={[lo, hi]} />
        <ReferenceLine y={targetPct} stroke="var(--border)" strokeDasharray="3 3" />
        <ChartTooltip cursor={false} content={<CogsTooltip targetPct={targetPct} />} />
        <Bar dataKey="pct" radius={2} isAnimationActive={false}>
          {series.map((d) => (
            <Cell key={d.date} fill={d.over ? "var(--trend-down)" : fill} fillOpacity={d.over ? 1 : 0.85} />
          ))}
        </Bar>
      </BarChart>
    </ChartContainer>
  );
}

// ── A. health donut ─────────────────────────────────────────────────────────

function HealthDonut({ value }: { value: number }) {
  const size = 56;
  const stroke = 7;
  const r = (size - stroke) / 2;
  const circumference = 2 * Math.PI * r;
  const clamped = Math.max(0, Math.min(100, value));
  const offset = circumference * (1 - clamped / 100);
  // Ring color via Tailwind text-token classes (amber has no CSS var in this repo,
  // only the palette utility); the arc reads it through `stroke-current`.
  const ringClass =
    value >= 75 ? "text-accent" : value >= 55 ? "text-amber-500" : "text-trend-down";
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      className={cn("flex-none", ringClass)}
      role="img"
      aria-label={`Stock health score ${Math.round(value)} of 100`}
    >
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--secondary)" strokeWidth={stroke} />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        className="stroke-current"
        strokeWidth={stroke}
        strokeDasharray={circumference}
        strokeDashoffset={offset}
        strokeLinecap="round"
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
      <text
        x="50%"
        y="52%"
        textAnchor="middle"
        dominantBaseline="middle"
        className="fill-foreground font-mono tabular-nums"
        fontSize={size * 0.3}
        fontWeight={600}
        style={{ letterSpacing: "-0.02em" }}
      >
        {Math.round(value)}
      </text>
    </svg>
  );
}

// ── A. delta chip ───────────────────────────────────────────────────────────

function Delta({ value, inverse = false }: { value: number | null; inverse?: boolean }) {
  if (value == null) return <span className="text-xs text-muted-foreground">—</span>;
  const dir = value > 0 ? "up" : value < 0 ? "down" : "flat";
  const good = inverse ? dir === "down" : dir === "up";
  const tone = dir === "flat" ? "text-muted-foreground" : good ? "text-trend-up" : "text-trend-down";
  const Arrow = dir === "up" ? Plus : dir === "down" ? Minus : null;
  return (
    <span className={cn("inline-flex items-center gap-0.5 text-xs font-semibold", tone)}>
      {Arrow ? <Arrow className="size-3" /> : null}
      <span className="font-mono tabular-nums">
        {value > 0 ? "+" : ""}
        {value.toFixed(1)}%
      </span>
    </span>
  );
}

// ── A. headline ribbon ──────────────────────────────────────────────────────

interface MetricCell {
  label: string;
  value: string;
  sub: string;
  delta: number | null;
  inverse: boolean;
}

function HeadlineRibbon({
  healthScore,
  atPar,
  total,
  urgentCount,
  metrics,
  spark
}: {
  healthScore: number;
  atPar: number;
  total: number;
  urgentCount: number;
  metrics: MetricCell[];
  spark: React.ReactNode;
}) {
  return (
    <Card className="flex flex-col items-stretch gap-0 overflow-hidden p-0 lg:flex-row">
      <div className="flex min-w-[218px] items-center gap-3 px-5 py-3.5">
        <HealthDonut value={healthScore} />
        <div>
          <div className="text-sm font-semibold">Stock health</div>
          <div className="mt-0.5 text-xs tabular-nums text-muted-foreground">
            <span className="font-medium text-foreground">{atPar}</span>/{total} at par ·{" "}
            <span className="font-medium text-trend-down">{urgentCount}</span> urgent
          </div>
        </div>
      </div>
      {metrics.map((metric) => (
        <div
          key={metric.label}
          className="flex flex-1 flex-col justify-center gap-1 border-t px-4 py-3.5 lg:border-l lg:border-t-0"
        >
          <span className="text-xs font-medium text-muted-foreground">{metric.label}</span>
          <div className="flex items-baseline gap-2">
            <span
              className="font-mono text-xl font-semibold tabular-nums"
              style={{ letterSpacing: "-0.02em" }}
            >
              {metric.value}
            </span>
            {metric.delta != null ? <Delta value={metric.delta} inverse={metric.inverse} /> : null}
          </div>
          <span className="text-[11px] tabular-nums text-muted-foreground">{metric.sub}</span>
        </div>
      ))}
      <div className="flex w-full flex-none flex-col justify-center border-t px-4 py-3 lg:w-[150px] lg:border-l lg:border-t-0">
        <span className="mb-1 text-[11px] text-muted-foreground">COGS % · 7d</span>
        {spark}
      </div>
    </Card>
  );
}

// ── B. action-queue row (with inline count + cart stepper) ─────────────────

function CartStepper({
  value,
  unit,
  onChange
}: {
  value: number;
  unit: string;
  onChange: (next: number) => void;
}) {
  return (
    <div className="inline-flex items-center rounded-md border border-border bg-card">
      <button
        type="button"
        onClick={() => onChange(Math.max(1, value - 1))}
        className="flex size-7 items-center justify-center rounded-l-md text-muted-foreground hover:bg-secondary"
        aria-label="Decrease quantity"
      >
        <Minus className="size-3.5" />
      </button>
      <span className="min-w-9 text-center font-mono text-xs font-semibold tabular-nums">
        {value}
        <span className="ml-0.5 text-[10px] font-normal text-muted-foreground">{unit}</span>
      </span>
      <button
        type="button"
        onClick={() => onChange(value + 1)}
        className="flex size-7 items-center justify-center rounded-r-md text-muted-foreground hover:bg-secondary"
        aria-label="Increase quantity"
      >
        <Plus className="size-3.5" />
      </button>
    </div>
  );
}

function ActionQueueRow({
  row,
  vendorName,
  categoryName,
  inCart,
  cartQty,
  onAdd,
  onSetQty,
  onRemove,
  onCount
}: {
  row: QueueRow;
  vendorName: string;
  categoryName: string;
  inCart: boolean;
  cartQty: number;
  onAdd: (id: string, qty: number) => void;
  onSetQty: (id: string, qty: number) => void;
  onRemove: (id: string) => void;
  onCount: (id: string, onHand: number) => void;
}) {
  const { item, status, qty } = row;
  const hot = status === "critical" || status === "86";
  const [counting, setCounting] = React.useState(false);
  const [draft, setDraft] = React.useState(String(item.on_hand));

  const startCount = () => {
    setDraft(String(item.on_hand));
    setCounting(true);
  };
  const saveCount = () => {
    const next = Math.max(0, Number.parseFloat(draft) || 0);
    setCounting(false);
    onCount(item.id, next);
  };

  const shownQty = inCart ? cartQty : qty;

  return (
    <div className="flex items-center gap-3.5 px-4 py-3 transition-colors hover:bg-secondary/40 sm:px-[18px]">
      <div className="min-w-0 flex-1">
        <div className="mb-1.5 flex items-center gap-2">
          <span className="truncate text-sm font-semibold">{item.name}</span>
          <ToneBadge tone={STATUS_TONE[status]} dot className="px-1.5 py-0 text-[10px]">
            {STATUS_LABEL[status]}
          </ToneBadge>
          <span className="hidden whitespace-nowrap text-[11px] text-muted-foreground sm:inline">
            {categoryName} · {vendorName}
          </span>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex max-w-[320px] flex-1 items-center gap-2">
            <ParBar item={item} status={status} className="h-1.5 w-full min-w-[60px]" />
            <span className="whitespace-nowrap font-mono text-[11px] tabular-nums text-muted-foreground">
              {item.on_hand}/{item.par_min} {item.unit}
            </span>
          </div>
          <span
            className={cn(
              "hidden whitespace-nowrap text-[11px] font-semibold tabular-nums md:inline",
              hot ? "text-trend-down" : "text-amber-600 dark:text-amber-400"
            )}
          >
            {urgencyLabel(status)}
          </span>
        </div>
      </div>

      {counting ? (
        <div className="flex flex-none items-center gap-2">
          <span className="hidden text-xs text-muted-foreground sm:inline">On hand</span>
          <Input
            autoFocus
            inputMode="decimal"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") saveCount();
              if (event.key === "Escape") setCounting(false);
            }}
            className="h-8 w-16 font-mono text-sm tabular-nums"
            aria-label={`On-hand count for ${item.name}`}
          />
          <span className="text-xs text-muted-foreground">{item.unit}</span>
          <Button size="sm" className="h-8 bg-accent text-accent-foreground hover:bg-accent/90" onClick={saveCount}>
            Save
          </Button>
          <Button size="sm" variant="ghost" className="h-8" onClick={() => setCounting(false)}>
            Cancel
          </Button>
        </div>
      ) : (
        <>
          <div className="w-20 flex-none text-right">
            <div className="font-mono text-sm font-semibold tabular-nums">
              +{shownQty} <span className="text-[11px] font-normal text-muted-foreground">{item.unit}</span>
            </div>
            <div className="font-mono text-[11px] tabular-nums text-muted-foreground">
              {formatCentsCompact(shownQty * item.cost_cents)}
            </div>
          </div>
          <div className="flex w-[168px] flex-none justify-end gap-1.5">
            {inCart ? (
              <>
                <CartStepper value={cartQty} unit={item.unit} onChange={(next) => onSetQty(item.id, next)} />
                <Button
                  size="sm"
                  variant="ghost"
                  className="size-8 p-0 text-muted-foreground"
                  onClick={() => onRemove(item.id)}
                  aria-label="Remove from reorder"
                >
                  <Trash2 className="size-3.5" />
                </Button>
              </>
            ) : (
              <>
                <Button size="sm" variant="outline" className="h-8" onClick={() => onAdd(item.id, qty)}>
                  {status === "86" ? "Reorder" : "Add"}
                </Button>
                <Button size="sm" variant="ghost" className="h-8" onClick={startCount}>
                  Count
                </Button>
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}

// ── B. arriving-today PO rail ────────────────────────────────────────────────

function isArrivingToday(po: InventoryPurchaseOrder): boolean {
  return po.status !== "received";
}

function ArrivingToday({ pos }: { pos: InventoryPurchaseOrder[] }) {
  const open = pos.filter(isArrivingToday);
  return (
    <Card className="gap-0 overflow-hidden p-0">
      <div className="flex items-center justify-between px-4 pb-3 pt-3.5">
        <div className="flex items-center gap-2">
          <Truck className="size-4 text-accent" />
          <span className="text-sm font-semibold">Arriving soon</span>
        </div>
        <ToneBadge tone="outline" className="text-[10px]">
          {open.length} open
        </ToneBadge>
      </div>
      {open.length === 0 ? (
        <p className="px-4 pb-4 text-xs text-muted-foreground">No open purchase orders.</p>
      ) : (
        <div className="divide-y divide-border">
          {open.map((po) => (
            <div key={po.id} className="px-4 py-2.5 transition-colors hover:bg-secondary/40">
              <div className="mb-0.5 flex items-baseline justify-between gap-2">
                <span className="whitespace-nowrap font-mono text-xs font-semibold">{po.id}</span>
                <span className="whitespace-nowrap font-mono text-xs tabular-nums text-muted-foreground">
                  {formatCentsCompact(po.total_cents)}
                </span>
              </div>
              <div className="text-xs text-foreground">{po.vendor}</div>
              <div className="mt-1 flex items-center justify-between">
                <span
                  className={cn(
                    "text-[11px] font-medium",
                    po.status === "in-transit" ? "text-accent" : "text-muted-foreground"
                  )}
                >
                  {po.status === "in-transit" ? "In transit" : "Submitted"} · {po.expected}
                </span>
                <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
                  {po.lines} line{po.lines === 1 ? "" : "s"}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

// ── B. activity feed ─────────────────────────────────────────────────────────

function activityIcon(action: string) {
  if (action.includes("count")) return ClipboardCheck;
  if (action.includes("86")) return Slash;
  if (action.includes("receiv")) return Truck;
  if (action.includes("waste")) return Trash2;
  if (action.includes("adjust")) return Pencil;
  return Clock;
}

function ActivityFeed({ activity }: { activity: InventoryActivityEntry[] }) {
  return (
    <Card className="p-4">
      <div className="mb-3 text-sm font-semibold">Recent activity</div>
      <ol className="space-y-3">
        {activity.slice(0, 5).map((entry, index) => {
          const Icon = activityIcon(entry.action);
          return (
            <li key={entry.id ?? `${entry.at}-${index}`} className="flex gap-2.5">
              <div className="mt-0.5 flex size-6 flex-none items-center justify-center rounded-full border border-border bg-secondary text-muted-foreground">
                <Icon className="size-3" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline gap-x-1 text-xs leading-snug">
                  <span className="font-medium">{entry.who}</span>
                  <span className="text-muted-foreground">{entry.action}</span>
                  <span className="font-medium">{entry.what}</span>
                </div>
                <div className="mt-0.5 text-[11px] text-muted-foreground">
                  <span className="font-mono tabular-nums">{entry.at}</span> · {entry.note}
                </div>
              </div>
            </li>
          );
        })}
      </ol>
    </Card>
  );
}

// ── C. menu margin movers ────────────────────────────────────────────────────

function MenuMarginMovers({
  recipes,
  byId,
  targetPct,
  onJump
}: {
  recipes: InventoryRecipe[];
  byId: Record<string, InventoryItem>;
  targetPct: number;
  onJump: (tabId: string) => void;
}) {
  const rows = recipes
    .map((recipe) => {
      const cost = recipeCostCents(recipe, byId);
      const fc = recipe.sell_cents > 0 ? (cost / recipe.sell_cents) * 100 : 0;
      const marginCents = (recipe.sell_cents - cost) * recipe.sold_today;
      return { recipe, fc, marginCents };
    })
    .sort((a, b) => b.fc - a.fc);

  return (
    <Card className="gap-0 overflow-hidden p-0">
      <div className="flex items-center justify-between border-b px-4 py-3 sm:px-[18px]">
        <div className="flex items-center gap-2">
          <Flame className="size-4 text-muted-foreground" />
          <span className="text-sm font-semibold">Menu margin movers</span>
          <ToneBadge tone="outline" className="text-[10px]">
            food cost %
          </ToneBadge>
        </div>
        <Button size="sm" variant="ghost" className="h-7" onClick={() => onJump("recipes")}>
          Recipes &amp; cost
          <ChevronRight className="size-3.5" />
        </Button>
      </div>
      <div className="divide-y divide-border">
        {rows.map(({ recipe, fc, marginCents }) => {
          const hot = fc > targetPct;
          return (
            <div
              key={recipe.id}
              className="grid grid-cols-[1.35fr_1.3fr_auto] items-center gap-3.5 px-4 py-2.5 transition-colors hover:bg-secondary/40 sm:px-[18px]"
            >
              <div className="min-w-0">
                <div className="truncate text-[13px] font-semibold">{recipe.name}</div>
                <div className="text-[11px] tabular-nums text-muted-foreground">
                  <span className="font-mono">{recipe.sold_today}</span> sold · {formatCents(recipe.sell_cents)}
                </div>
              </div>
              <div className="flex items-center gap-2.5">
                <div className="relative h-[7px] flex-1 overflow-hidden rounded-full bg-secondary">
                  <div
                    className={cn("absolute inset-y-0 left-0 rounded-full", hot ? "bg-trend-down" : "bg-accent")}
                    style={{ width: `${Math.min(100, fc * 2)}%` }}
                  />
                  <div
                    className="absolute inset-y-[-1px] w-px bg-foreground/40"
                    style={{ left: `${Math.min(100, targetPct * 2)}%` }}
                    title={`target ${targetPct}%`}
                  />
                </div>
                <span
                  className={cn(
                    "w-11 text-right font-mono text-xs font-semibold tabular-nums",
                    hot ? "text-trend-down" : "text-foreground"
                  )}
                >
                  {fc.toFixed(1)}%
                </span>
              </div>
              <div className="w-[78px] text-right">
                <div className="font-mono text-xs font-semibold tabular-nums">
                  {formatCentsCompact(marginCents)}
                </div>
                <div className="text-[10px] text-muted-foreground">margin</div>
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

// ── C. theoretical food cost (live from analytics) ──────────────────────────

function TheoreticalCostCard({
  foodCostPct,
  theoreticalCogsCents,
  coveragePct,
  wasteValueCents,
  targetPct,
  loading
}: {
  foodCostPct: number | null;
  theoreticalCogsCents: number | null;
  coveragePct: number | null;
  wasteValueCents: number;
  targetPct: number;
  loading: boolean;
}) {
  const hasValue = foodCostPct != null;
  const over = hasValue && foodCostPct * 100 > targetPct;
  const deltaPts = hasValue ? foodCostPct * 100 - targetPct : 0;

  return (
    <Card className="flex flex-col p-4">
      <div className="flex items-center gap-2">
        <Scale className="size-4 text-muted-foreground" />
        <span className="text-sm font-semibold">Food cost (theoretical)</span>
        <ToneBadge tone="outline" className="text-[10px]">
          Analytics
        </ToneBadge>
      </div>
      <p className="mt-1 text-xs leading-snug text-muted-foreground">
        Units sold times recipe plate cost, over net sales — your ideal food cost before waste and
        over-portioning.
      </p>

      <div className="mt-3.5 flex items-end justify-between border-b pb-3.5">
        <div>
          <div className="text-[11px] text-muted-foreground">Food cost %</div>
          <div
            className={cn(
              "font-mono text-2xl font-semibold tabular-nums",
              !hasValue ? "text-muted-foreground/45" : over ? "text-trend-down" : "text-foreground"
            )}
            style={{ letterSpacing: "-0.02em" }}
          >
            {loading ? "···" : hasValue ? formatRate(foodCostPct) : "—"}
          </div>
        </div>
        <div className="text-right">
          <div className="text-[11px] text-muted-foreground">Theoretical COGS</div>
          <div className="font-mono text-lg font-semibold tabular-nums">
            {theoreticalCogsCents == null ? "—" : formatCents(theoreticalCogsCents)}
          </div>
        </div>
      </div>

      <div className="mt-3 flex items-center justify-between text-xs">
        <span className="text-muted-foreground">vs {targetPct}% target</span>
        <span className={cn("font-medium tabular-nums", over ? "text-trend-down" : "text-accent")}>
          {hasValue ? `${deltaPts >= 0 ? "+" : ""}${deltaPts.toFixed(1)} pts` : "—"}
        </span>
      </div>
      <div className="mt-2 flex items-center justify-between text-xs">
        <span className="text-muted-foreground">Recipe coverage</span>
        <span className="font-medium tabular-nums">
          {coveragePct == null ? "—" : `${formatRate(coveragePct, 0)} of sales`}
        </span>
      </div>
      <div className="mt-2 flex items-center justify-between text-xs">
        <span className="text-muted-foreground">Logged waste today</span>
        <span className="font-medium tabular-nums">{formatCents(wasteValueCents)}</span>
      </div>

      <div className="mt-4 flex items-start gap-2 border-t pt-3.5">
        <Plug className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
        <p className="text-[11px] leading-snug text-muted-foreground">
          <span className="font-medium text-foreground">Yield variance</span> (actual minus
          theoretical) lights up once physical counts feed actual COGS — we don&apos;t fabricate
          leakage from the theoretical number.
        </p>
      </div>
    </Card>
  );
}

// ── D. stock health by category heatmap ─────────────────────────────────────

const HEATMAP_LEGEND: { label: string; swatch: string }[] = [
  { label: "Healthy", swatch: "bg-accent" },
  { label: "Low", swatch: "bg-amber-500" },
  { label: "Critical", swatch: "bg-trend-down" },
  { label: "86'd", swatch: "bg-primary" },
  { label: "Overstock", swatch: "bg-sky-500" }
];

interface TileClasses {
  container: string;
  bigNumber: string;
  sub: string;
  dot: string;
}

function tileClasses(status: InventoryItemStatus): TileClasses {
  switch (status) {
    case "86":
      return {
        container: "border-primary bg-primary text-primary-foreground",
        bigNumber: "text-primary-foreground",
        sub: "text-primary-foreground/60",
        dot: "bg-primary-foreground"
      };
    case "critical":
      return {
        container: "border-trend-down/30 bg-trend-down-bg",
        bigNumber: "text-trend-down",
        sub: "text-muted-foreground",
        dot: "bg-trend-down"
      };
    case "low":
      return {
        container: "border-amber-300 bg-amber-50 dark:border-amber-900/60 dark:bg-amber-950/40",
        bigNumber: "text-amber-600 dark:text-amber-400",
        sub: "text-muted-foreground",
        dot: "bg-amber-500"
      };
    case "over":
      return {
        container: "border-sky-200 bg-sky-50 dark:border-sky-900/60 dark:bg-sky-950/40",
        bigNumber: "text-sky-600 dark:text-sky-400",
        sub: "text-muted-foreground",
        dot: "bg-sky-500"
      };
    default:
      return {
        container: "border-border bg-card",
        bigNumber: "text-foreground",
        sub: "text-muted-foreground",
        dot: "bg-accent"
      };
  }
}

// The category tile big-number is the item's status (not a fabricated day count),
// since the contract carries no per-item daily-use signal.
function tileHeadline(status: InventoryItemStatus): { value: string; caption: string } {
  switch (status) {
    case "86":
      return { value: "86", caption: "on KDS" };
    case "critical":
      return { value: "Critical", caption: "below 50% par" };
    case "low":
      return { value: "Low", caption: "below par" };
    case "over":
      return { value: "Over", caption: "above max par" };
    default:
      return { value: "OK", caption: "at par" };
  }
}

function CategoryHeatmap({
  categories,
  items,
  cart,
  onAddTile
}: {
  categories: InventoryCategory[];
  items: InventoryItem[];
  cart: Record<string, number>;
  onAddTile: (id: string, qty: number) => void;
}) {
  const byCategory = new Map<string, InventoryItem[]>();
  for (const item of items) {
    const bucket = byCategory.get(item.category);
    if (bucket) bucket.push(item);
    else byCategory.set(item.category, [item]);
  }
  const ordered = categories.filter((category) => byCategory.has(category.id));

  const statusRank: Record<InventoryItemStatus, number> = {
    "86": 0,
    critical: 1,
    low: 2,
    ok: 3,
    over: 4
  };

  return (
    <Card className="gap-0 overflow-hidden p-0">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3 sm:px-[18px]">
        <div className="flex items-center gap-2">
          <Package className="size-4 text-muted-foreground" />
          <span className="text-sm font-semibold">Stock health by category</span>
          <span className="hidden text-xs text-muted-foreground sm:inline">· click a flagged tile to add</span>
        </div>
        <div className="flex flex-wrap items-center gap-3.5 text-[11px] text-muted-foreground">
          {HEATMAP_LEGEND.map((entry) => (
            <span key={entry.label} className="inline-flex items-center gap-1.5">
              <span className={cn("size-2.5 rounded-sm", entry.swatch)} />
              {entry.label}
            </span>
          ))}
        </div>
      </div>
      <div className="px-4 pb-[18px] pt-1 sm:px-[18px]">
        {ordered.map((category) => {
          const list = (byCategory.get(category.id) ?? [])
            .slice()
            .sort((a, b) => statusRank[statusOf(a)] - statusRank[statusOf(b)]);
          const categoryValue = list.reduce((sum, item) => sum + item.cost_cents * item.on_hand, 0);
          return (
            <div key={category.id} className="mt-3.5">
              <div className="mb-2 flex items-baseline gap-2.5">
                <span className="text-[13px] font-semibold">{category.name}</span>
                <span className="text-[11px] tabular-nums text-muted-foreground">{list.length} SKUs</span>
                <span className="size-[3px] rounded-sm bg-border" />
                <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
                  {formatCentsCompact(categoryValue)} on hand
                </span>
              </div>
              <div className="grid grid-cols-[repeat(auto-fill,minmax(158px,1fr))] gap-2">
                {list.map((item) => {
                  const status = statusOf(item);
                  const classes = tileClasses(status);
                  const headline = tileHeadline(status);
                  const flagged = status === "low" || status === "critical" || status === "86";
                  const inCart = cart[item.id] != null;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      disabled={!flagged || inCart}
                      onClick={() => {
                        if (flagged && !inCart) onAddTile(item.id, suggestedQty(item));
                      }}
                      title={flagged ? (inCart ? "In reorder" : "Click to add to reorder") : undefined}
                      className={cn(
                        "rounded-lg border px-2.5 py-2.5 text-left transition",
                        classes.container,
                        flagged && !inCart && "cursor-pointer hover:brightness-[0.98]",
                        inCart && "ring-1 ring-accent",
                        !flagged && "cursor-default"
                      )}
                    >
                      <div className="flex items-start justify-between gap-1.5">
                        <span
                          className={cn(
                            "text-xs font-semibold leading-tight",
                            status === "86" ? "text-primary-foreground" : "text-foreground"
                          )}
                        >
                          {item.name}
                        </span>
                        {inCart ? (
                          <Plus className="mt-0.5 size-3 flex-none text-accent" />
                        ) : (
                          <span className={cn("mt-1 size-1.5 flex-none rounded-sm", classes.dot)} />
                        )}
                      </div>
                      <div className="mt-1.5 flex items-baseline gap-1.5">
                        <span
                          className={cn("font-mono text-base font-semibold tabular-nums", classes.bigNumber)}
                          style={{ letterSpacing: "-0.02em" }}
                        >
                          {headline.value}
                        </span>
                        <span className={cn("text-[10px]", classes.sub)}>{headline.caption}</span>
                      </div>
                      <div className="mt-1.5 flex items-center gap-1.5">
                        <ParBar item={item} status={status} className="h-1 w-full min-w-[40px]" />
                        <span className={cn("whitespace-nowrap font-mono text-[10px] tabular-nums", classes.sub)}>
                          {item.on_hand}/{item.par_min}
                        </span>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

// ── reorder review drawer (Sheet) ────────────────────────────────────────────

function ReorderDrawer({
  open,
  onOpenChange,
  cart,
  byId,
  onSetQty,
  onRemove,
  onSend,
  sending
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  cart: Record<string, number>;
  byId: Record<string, InventoryItem>;
  onSetQty: (id: string, qty: number) => void;
  onRemove: (id: string) => void;
  onSend: () => void;
  sending: boolean;
}) {
  const ids = Object.keys(cart).filter((id) => byId[id]);
  const lines = ids.map((id) => ({ item: byId[id]!, qty: cart[id]! }));

  // Same grouping key as buildPosFromCart, so the "N POs" promise below matches
  // exactly what sendPOs dispatches.
  const byVendor = new Map<string, { item: InventoryItem; qty: number }[]>();
  for (const line of lines) {
    const vendor = line.item.vendor.trim() || NO_VENDOR_LABEL;
    const bucket = byVendor.get(vendor);
    if (bucket) bucket.push(line);
    else byVendor.set(vendor, [line]);
  }
  const vendors = [...byVendor.keys()];
  const total = lines.reduce((sum, line) => sum + line.qty * line.item.cost_cents, 0);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex w-full flex-col gap-0 p-0 sm:max-w-[432px]">
        <SheetHeader className="border-b px-5 py-4">
          <SheetTitle className="text-base">Reorder draft</SheetTitle>
          <SheetDescription className="text-xs">
            {lines.length === 0
              ? "Add items from the action queue, or use “Add all below par”."
              : `${lines.length} item${lines.length === 1 ? "" : "s"} · ${vendors.length} vendor${
                  vendors.length === 1 ? "" : "s"
                } · ${vendors.length} PO${vendors.length === 1 ? "" : "s"}`}
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto p-4">
          {lines.length === 0 ? (
            <div className="flex h-full min-h-[320px] flex-col items-center justify-center gap-3 text-center">
              <div className="flex size-12 items-center justify-center rounded-xl bg-secondary text-muted-foreground">
                <Package className="size-5" />
              </div>
              <div className="text-sm font-semibold">Reorder draft is empty</div>
              <p className="max-w-[240px] text-xs text-muted-foreground">
                Add items from the action queue to build purchase orders by vendor.
              </p>
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              {vendors.map((vendor) => {
                const vendorLines = byVendor.get(vendor) ?? [];
                const vendorTotal = vendorLines.reduce(
                  (sum, line) => sum + line.qty * line.item.cost_cents,
                  0
                );
                return (
                  <Card key={vendor} className="gap-0 overflow-hidden p-0">
                    <div className="flex items-center justify-between border-b bg-secondary px-3.5 py-2.5">
                      <div className="flex min-w-0 items-center gap-2">
                        <Truck className="size-3.5 flex-none text-muted-foreground" />
                        <span className="whitespace-nowrap text-[13px] font-semibold">{vendor}</span>
                        <ToneBadge tone="outline" className="flex-none text-[10px]">
                          {vendorLines.length} line{vendorLines.length === 1 ? "" : "s"}
                        </ToneBadge>
                      </div>
                      <span className="font-mono text-[13px] font-semibold tabular-nums">
                        {formatCents(vendorTotal)}
                      </span>
                    </div>
                    <div className="divide-y divide-border">
                      {vendorLines.map(({ item, qty }) => (
                        <div key={item.id} className="flex items-center gap-2.5 px-3.5 py-2.5">
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-[13px] font-semibold">{item.name}</div>
                            <div className="font-mono text-[11px] tabular-nums text-muted-foreground">
                              {formatCents(item.cost_cents)}/{item.unit} · on hand {item.on_hand}
                            </div>
                          </div>
                          <CartStepper value={qty} unit={item.unit} onChange={(next) => onSetQty(item.id, next)} />
                          <span className="w-[62px] text-right font-mono text-[13px] font-semibold tabular-nums">
                            {formatCents(qty * item.cost_cents)}
                          </span>
                          <button
                            type="button"
                            onClick={() => onRemove(item.id)}
                            className="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-secondary"
                            aria-label={`Remove ${item.name}`}
                          >
                            <X className="size-3.5" />
                          </button>
                        </div>
                      ))}
                    </div>
                  </Card>
                );
              })}
            </div>
          )}
        </div>

        {lines.length > 0 ? (
          <div className="border-t p-4">
            <div className="mb-3 flex items-center justify-between">
              <span className="text-[13px] text-muted-foreground">Estimated total</span>
              <span
                className="font-mono text-xl font-semibold tabular-nums"
                style={{ letterSpacing: "-0.02em" }}
              >
                {formatCents(total)}
              </span>
            </div>
            <Button className="h-11 w-full text-sm" onClick={onSend} disabled={sending}>
              <Truck className="size-4" />
              {sending
                ? "Sending…"
                : `Send ${vendors.length} ${vendors.length === 1 ? "PO" : "POs"} to vendors`}
            </Button>
          </div>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

// ── tab shell ────────────────────────────────────────────────────────────────

export interface OverviewTabProps {
  data: InventoryDataset;
  onPickItem: (id: string) => void;
  onJump: (tabId: string) => void;
  onCount: (updates: Record<string, number>) => void;
}

export function OverviewTab({ data, onJump, onCount }: OverviewTabProps) {
  const items = data.items;
  const [cart, setCart] = React.useState<Record<string, number>>({});
  // SKUs with a (stubbed) PO sent — dropped from the queue so the UI mirrors the
  // intended "ordered items leave the action list" behavior.
  const [ordered, setOrdered] = React.useState<Record<string, true>>({});
  const [drawerOpen, setDrawerOpen] = React.useState(false);
  const [sending, setSending] = React.useState(false);
  const { mutateAsync: createPo } = useCreatePurchaseOrder();

  const byId = React.useMemo<Record<string, InventoryItem>>(
    () => Object.fromEntries(items.map((item) => [item.id, item])),
    [items]
  );
  const categoryName = React.useMemo<Record<string, string>>(
    () => Object.fromEntries(data.categories.map((category) => [category.id, category.name])),
    [data.categories]
  );

  // Real food cost from analytics (cost_daily_mv via /api/costs). A 7-day window
  // feeds both the headline figure and the daily COGS-% sparkline, replacing the
  // former seeded cogs_trend / net_sales_trend (ADR-0573). Null until costed sales
  // exist in the window.
  const costsQuery = useCosts(7);
  const costMetrics = costsQuery.data?.metrics;
  const theoreticalCogsCents = costMetrics?.food_cost_cents?.value ?? null;
  const foodCostPct = costMetrics?.food_cost_pct?.value ?? null;
  const coveragePct = costMetrics?.cost_coverage_pct?.value ?? null;
  // Real daily food-cost-% series for the sparkline; only days with costed sales.
  const cogsSeries = React.useMemo<CogsPoint[]>(() => {
    const target = data.cogs_target_pct;
    return (costsQuery.data?.costTrend ?? [])
      .filter((point): point is { business_date: string; value: number } => point.value != null)
      .map((point) => {
        const pct = point.value * 100;
        return {
          date: point.business_date,
          day: weekdayLabel(point.business_date),
          pct,
          over: pct > target
        };
      });
  }, [costsQuery.data?.costTrend, data.cogs_target_pct]);

  // ── headline metrics (all derived from live items / trends) ──
  const total = items.length;
  const statusCounts = React.useMemo(() => {
    const counts: Record<InventoryItemStatus, number> = { ok: 0, low: 0, critical: 0, over: 0, "86": 0 };
    for (const item of items) counts[statusOf(item)] += 1;
    return counts;
  }, [items]);
  const atPar = statusCounts.ok + statusCounts.over;
  const urgentCount = statusCounts.critical + statusCounts["86"];
  const healthScore = total > 0 ? Math.round((atPar / total) * 100 - statusCounts["86"] * 3) : 0;

  const inventoryValueCents = items.reduce((sum, item) => sum + item.cost_cents * item.on_hand, 0);

  const wasteValueCents = data.waste_log.reduce(
    (sum, entry) => sum + entry.qty * (byId[entry.sku]?.cost_cents ?? 0),
    0
  );

  const queue = React.useMemo(() => buildQueue(items, ordered), [items, ordered]);
  const cartCount = Object.keys(cart).length;

  const metrics: MetricCell[] = [
    {
      label: "Inventory value",
      value: formatCentsCompact(inventoryValueCents),
      sub: `${total} SKUs`,
      delta: null,
      inverse: false
    },
    {
      label: "Food cost · 7d",
      value: foodCostPct == null ? "—" : formatRate(foodCostPct),
      sub:
        theoreticalCogsCents == null
          ? `target ${data.cogs_target_pct}%`
          : `target ${data.cogs_target_pct}% · ${formatCentsCompact(theoreticalCogsCents)} COGS`,
      delta: null,
      inverse: true
    },
    {
      label: "Cost coverage",
      value: coveragePct == null ? "—" : formatRate(coveragePct, 0),
      sub: "of menu sales costed",
      delta: null,
      inverse: false
    },
    {
      label: "Waste today",
      value: formatCentsCompact(wasteValueCents),
      sub: `${data.waste_log.length} event${data.waste_log.length === 1 ? "" : "s"}`,
      delta: null,
      inverse: true
    }
  ];

  // ── cart actions ──
  const addToCart = React.useCallback(
    (id: string, qty: number) => {
      setCart((current) => ({ ...current, [id]: qty }));
      toast.success("Added to reorder", { description: byId[id]?.name });
    },
    [byId]
  );
  const setQty = React.useCallback((id: string, qty: number) => {
    setCart((current) => ({ ...current, [id]: Math.max(1, qty) }));
  }, []);
  const removeFromCart = React.useCallback((id: string) => {
    setCart((current) => {
      const next = { ...current };
      delete next[id];
      return next;
    });
  }, []);
  const addAllBelowPar = React.useCallback(() => {
    setCart((current) => {
      const next = { ...current };
      for (const row of queue) {
        if (next[row.item.id] == null) next[row.item.id] = row.qty;
      }
      return next;
    });
    setDrawerOpen(true);
    toast.success("Added all below-par items", {
      description: `${queue.length} item${queue.length === 1 ? "" : "s"}`
    });
  }, [queue]);

  // Inline count → the same POST /api/inventory/counts mutation the rest of the
  // app uses. TanStack invalidation refreshes every derived metric on this tab.
  const handleCount = React.useCallback(
    (id: string, onHand: number) => {
      onCount({ [id]: onHand });
      toast.success("Count updated", {
        description: `${byId[id]?.name ?? "Item"} · ${onHand} ${byId[id]?.unit ?? ""}`.trim()
      });
    },
    [onCount, byId]
  );

  // Send the reorder cart as one PO per vendor through the same POST /api/inventory/pos
  // mutation the New PO builder uses. Outcomes are per vendor: items on a created PO
  // are marked ordered and leave the cart; items on a failed PO stay in the draft so
  // the send can be retried. The drawer closes only when every PO went out.
  const sendPOs = React.useCallback(async () => {
    const pos = buildPosFromCart(cart, byId);
    if (pos.length === 0 || sending) return;
    setSending(true);
    const results = await Promise.allSettled(pos.map((po) => createPo(po)));
    setSending(false);
    const sent = pos.filter((_, index) => results[index]?.status === "fulfilled");
    const failed = pos.filter((_, index) => results[index]?.status === "rejected");
    if (sent.length > 0) {
      const sentIds = sent.flatMap((po) => po.lines.map((line) => line.sku));
      setOrdered((current) => {
        const next = { ...current };
        for (const id of sentIds) next[id] = true;
        return next;
      });
      setCart((current) => {
        const next = { ...current };
        for (const id of sentIds) delete next[id];
        return next;
      });
      toast.success(`Sent ${sent.length} PO${sent.length === 1 ? "" : "s"} to vendors`, {
        description: sent.map((po) => po.vendor).join(", ")
      });
    }
    if (failed.length > 0) {
      toast.error(`Could not send ${failed.length} PO${failed.length === 1 ? "" : "s"}`, {
        description: `${failed.map((po) => po.vendor).join(", ")} — kept in the reorder draft.`
      });
    } else {
      setDrawerOpen(false);
    }
  }, [cart, byId, sending, createPo]);

  return (
    <div className="flex flex-col gap-4">
      <HeadlineRibbon
        healthScore={healthScore}
        atPar={atPar}
        total={total}
        urgentCount={urgentCount}
        metrics={metrics}
        spark={
          <CogsSpark
            series={cogsSeries}
            targetPct={data.cogs_target_pct}
            loading={costsQuery.isLoading}
          />
        }
      />

      <div className="grid items-start gap-4 lg:grid-cols-[1fr_312px]">
        <Card className="gap-0 overflow-hidden p-0">
          <div className="flex items-center justify-between gap-3 border-b px-4 py-3.5 sm:px-[18px]">
            <div className="flex items-center gap-2.5">
              <div className="flex size-9 items-center justify-center rounded-lg bg-trend-down-bg text-trend-down">
                <AlertTriangle className="size-[18px]" />
              </div>
              <div>
                <div className="text-[15px] font-semibold tracking-tight">Needs action before service</div>
                <div className="text-xs text-muted-foreground">
                  <span className="font-medium text-trend-down">{urgentCount} urgent</span> ·{" "}
                  {statusCounts.low} low · {cartCount} in reorder
                </div>
              </div>
            </div>
            <Button
              className="whitespace-nowrap"
              size="sm"
              disabled={queue.length === 0}
              onClick={addAllBelowPar}
            >
              <Package className="size-3.5" />
              Add all below par
            </Button>
          </div>
          {queue.length === 0 ? (
            <div className="flex flex-col items-center gap-2.5 px-4 py-11 text-center">
              <div className="flex size-11 items-center justify-center rounded-full bg-trend-up-bg text-accent">
                <ChevronRight className="size-5" />
              </div>
              <div className="text-sm font-semibold">All caught up</div>
              <p className="max-w-[320px] text-xs text-muted-foreground">
                Nothing below par right now. Sent purchase orders show under Receiving.
              </p>
            </div>
          ) : (
            <div className="divide-y divide-border">
              {queue.map((row) => (
                <ActionQueueRow
                  key={row.item.id}
                  row={row}
                  vendorName={row.item.vendor || "No vendor"}
                  categoryName={categoryName[row.item.category] ?? row.item.category}
                  inCart={cart[row.item.id] != null}
                  cartQty={cart[row.item.id] ?? row.qty}
                  onAdd={addToCart}
                  onSetQty={setQty}
                  onRemove={removeFromCart}
                  onCount={handleCount}
                />
              ))}
            </div>
          )}
        </Card>

        <div className="flex flex-col gap-4">
          <ArrivingToday pos={data.pos} />
          <ActivityFeed activity={data.activity} />
        </div>
      </div>

      <div className="grid items-start gap-4 lg:grid-cols-[1fr_360px]">
        <MenuMarginMovers
          recipes={data.recipes}
          byId={byId}
          targetPct={data.cogs_target_pct}
          onJump={onJump}
        />
        <TheoreticalCostCard
          foodCostPct={foodCostPct}
          theoreticalCogsCents={theoreticalCogsCents}
          coveragePct={coveragePct}
          wasteValueCents={wasteValueCents}
          targetPct={data.cogs_target_pct}
          loading={costsQuery.isLoading}
        />
      </div>

      <CategoryHeatmap
        categories={data.categories}
        items={items}
        cart={cart}
        onAddTile={addToCart}
      />

      <ReorderDrawer
        open={drawerOpen}
        onOpenChange={setDrawerOpen}
        cart={cart}
        byId={byId}
        onSetQty={setQty}
        onRemove={removeFromCart}
        onSend={sendPOs}
        sending={sending}
      />
    </div>
  );
}
