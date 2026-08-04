"use client";

import Link from "next/link";
import { ArrowUpRight, Plug, Receipt, Scale, Sigma, TriangleAlert, Users } from "lucide-react";
import type { ComponentType } from "react";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { formatCents, formatRate } from "@/lib/format";
import {
  type Band,
  evalFoodBand,
  evalLaborBand,
  evalPrimeBand,
  FOOD_TARGET,
  PRIME_TARGET,
  targetVarianceLabel
} from "@/lib/costs/bands";
import type { CostMetricValue } from "@/lib/analytics-api/types";

function SourceTag({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-full border border-border/80 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
      {children}
    </span>
  );
}

function MetricTag({ id, blocked }: { id: string; blocked?: boolean }) {
  return (
    <span className="inline-flex items-center gap-1 font-mono text-[10.5px] text-muted-foreground/80">
      <Sigma className={cn("size-3", blocked ? "text-muted-foreground/60" : "text-accent")} />
      {id}
    </span>
  );
}

function BandPill({ band }: { band: Band }) {
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium"
      style={{ background: band.bg, color: band.color }}
    >
      <span aria-hidden className="inline-block size-1.5 rounded-full" style={{ background: band.color }} />
      {band.label}
    </span>
  );
}

interface StatShellProps {
  icon: ComponentType<{ className?: string }>;
  label: string;
  source: string;
  tone?: { bg: string; color: string } | null;
  top?: React.ReactNode;
  footer?: React.ReactNode;
  children: React.ReactNode;
}

function StatShell({ icon: Icon, label, source, tone, top, footer, children }: StatShellProps) {
  return (
    <Card className="flex min-h-[208px] flex-col gap-0 py-0">
      <div className="flex items-start justify-between gap-2 px-4 pt-4">
        <div className="flex items-center gap-2">
          <span
            className="flex size-7 shrink-0 items-center justify-center rounded-md"
            style={{
              background: tone ? tone.bg : "var(--muted)",
              color: tone ? tone.color : "var(--muted-foreground)"
            }}
          >
            <Icon className="size-[15px]" />
          </span>
          <span className="text-sm font-medium">{label}</span>
        </div>
        {top}
      </div>
      <div className="flex flex-1 flex-col px-4 pb-3 pt-3">{children}</div>
      <div className="flex items-center justify-between gap-2 border-t px-4 py-2">
        <SourceTag>{source}</SourceTag>
        {footer}
      </div>
    </Card>
  );
}

function BandGauge({ value }: { value: number }) {
  const lo = 0.25;
  const hi = 0.4;
  const range = hi - lo;
  const seg = (a: number, b: number) => `${((b - a) / range) * 100}%`;
  const at = `${Math.max(0, Math.min(1, (value - lo) / range)) * 100}%`;
  return (
    <div className="mt-1">
      <div className="relative">
        <div className="flex h-2 w-full overflow-hidden rounded-full">
          <div style={{ width: seg(lo, 0.324), background: "var(--band-good)" }} />
          <div style={{ width: seg(0.324, 0.35), background: "var(--band-warn)" }} />
          <div style={{ width: seg(0.35, hi), background: "var(--band-bad)" }} />
        </div>
        <div
          className="absolute -top-1 -bottom-1 w-0.5 -translate-x-1/2 rounded-full bg-foreground"
          style={{ left: at }}
        />
      </div>
      <div className="mt-1 flex justify-between text-[10px] tabular-nums text-muted-foreground">
        <span>25%</span>
        <span>32.4%</span>
        <span>35%</span>
        <span>40%</span>
      </div>
    </div>
  );
}

export interface FoodCostCardProps {
  foodCost: CostMetricValue | undefined;
  coverage: CostMetricValue | undefined;
}

export function FoodCostCard({ foodCost, coverage }: FoodCostCardProps) {
  const value = foodCost?.value ?? null;
  const coverageValue = coverage?.value ?? null;
  const { band, gated } = evalFoodBand(value, coverageValue);

  const tone = band ? { bg: band.bg, color: band.color } : null;
  const top = band ? (
    <BandPill band={band} />
  ) : gated ? (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
      Provisional
    </span>
  ) : null;

  return (
    <StatShell
      icon={Receipt}
      label={foodCost?.label ?? "Food cost %"}
      source="Analytics"
      tone={tone}
      top={top}
      footer={<MetricTag id="food_cost_pct" />}
    >
      <div className="flex items-baseline gap-2">
        <span className="font-mono text-3xl font-semibold tabular-nums tracking-tight">
          {value == null ? "—" : formatRate(value)}
        </span>
        <span className="text-xs text-muted-foreground">
          {band && value != null ? targetVarianceLabel(value, FOOD_TARGET) : "—"}
        </span>
      </div>

      {gated ? (
        <div className="mt-3">
          <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-accent"
              style={{ width: `${Math.round((coverageValue ?? 0) * 100)}%` }}
            />
          </div>
          <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
            Only{" "}
            <span className="font-medium text-foreground">
              {coverageValue == null ? "—" : formatRate(coverageValue, 0)}
            </span>{" "}
            of item sales are costed. Food cost % is a floor until recipe coverage is
            complete — the NRA band stays hidden until then.
          </p>
          <Link
            href="/inventory?tab=recipes"
            className="mt-2 inline-flex items-center gap-1 text-[11px] font-medium text-accent hover:underline"
          >
            Add recipes <ArrowUpRight className="size-3" />
          </Link>
        </div>
      ) : value != null ? (
        <>
          <BandGauge value={value} />
          <p className="mt-auto pt-3 text-[11px] leading-relaxed text-muted-foreground">
            <span className="font-mono">Σ(units × plate cost) ÷ net sales</span> · covers{" "}
            <span className="font-medium text-foreground">
              {coverageValue == null ? "—" : formatRate(coverageValue, 0)}
            </span>{" "}
            of item sales by recipe.
          </p>
        </>
      ) : (
        <p className="mt-auto pt-3 text-[11px] leading-relaxed text-muted-foreground">
          No costed sales in this window.
        </p>
      )}
    </StatShell>
  );
}

export interface LaborCostCardProps {
  labor: CostMetricValue | undefined;
  onEdit?: () => void;
}

export function LaborCostCard({ labor, onEdit }: LaborCostCardProps) {
  const value = labor?.value ?? null;

  if (value != null) {
    const band = evalLaborBand(value);
    const tone = band ? { bg: band.bg, color: band.color } : null;
    return (
      <StatShell
        icon={Users}
        label={labor?.label ?? "Labor cost %"}
        source="Config"
        tone={tone}
        top={band ? <BandPill band={band} /> : null}
        footer={<MetricTag id="labor_cost_pct" />}
      >
        <div className="flex items-baseline gap-2">
          <span className="font-mono text-3xl font-semibold tabular-nums tracking-tight">
            {formatRate(value)}
          </span>
          <span className="text-xs text-muted-foreground">{band ? band.note : "—"}</span>
        </div>
        <div className="mt-auto flex items-end justify-between gap-2 pt-3">
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            <span className="font-mono">configured labor cost ÷ net sales</span> · updated when
            wages change.
          </p>
          <button
            type="button"
            onClick={onEdit}
            className="shrink-0 rounded-md border px-2 py-1 text-xs font-medium text-foreground transition-colors hover:bg-muted"
          >
            Edit
          </button>
        </div>
      </StatShell>
    );
  }

  return (
    <StatShell
      icon={Users}
      label="Labor cost %"
      source="Config"
      top={
        <span className="inline-flex items-center gap-1.5 rounded-full border border-dashed border-border px-2 py-0.5 text-xs font-medium text-muted-foreground">
          <Plug className="size-3" /> Not connected
        </span>
      }
      footer={<MetricTag id="labor_cost_pct" blocked />}
    >
      <div className="flex items-baseline gap-2">
        <span className="font-mono text-3xl font-semibold tabular-nums tracking-tight text-muted-foreground/45">
          —
        </span>
      </div>
      <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
        Labor cost isn&apos;t set yet. Add it to light up labor % and prime cost — we don&apos;t
        estimate it, because a guessed number would quietly corrupt prime cost.
      </p>
      <button
        type="button"
        onClick={onEdit}
        className="mt-auto inline-flex items-center gap-1.5 self-start rounded-md border px-2.5 py-1 text-xs font-medium text-foreground transition-colors hover:bg-muted"
      >
        <Plug className="size-3" /> Set labor cost
      </button>
    </StatShell>
  );
}

export interface PrimeCostCardProps {
  foodCost: CostMetricValue | undefined;
  laborCost: CostMetricValue | undefined;
  prime: CostMetricValue | undefined;
  coverage: CostMetricValue | undefined;
}

export function PrimeCostCard({ foodCost, laborCost, prime, coverage }: PrimeCostCardProps) {
  const food = foodCost?.value ?? null;
  const labor = laborCost?.value ?? null;
  const primeValue = prime?.value ?? null;
  const target = 0.65;
  const domain = 0.8;
  const targetAt = `${(target / domain) * 100}%`;

  // Lit: labor is configured, so prime resolves. Show the banded number (gated
  // on coverage, since prime contains the food leg) and the real food+labor split.
  if (primeValue != null) {
    const { band, gated } = evalPrimeBand(primeValue, coverage?.value ?? null);
    const tone = band ? { bg: band.bg, color: band.color } : null;
    const foodW = `${Math.min(100, ((food ?? 0) / domain) * 100)}%`;
    const laborW = `${Math.min(100, ((labor ?? 0) / domain) * 100)}%`;
    const top = band ? (
      <BandPill band={band} />
    ) : gated ? (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
        Provisional
      </span>
    ) : null;
    return (
      <StatShell
        icon={Sigma}
        label={prime?.label ?? "Prime cost %"}
        source="Analytics"
        tone={tone}
        top={top}
        footer={<MetricTag id="prime_cost_pct" />}
      >
        <div className="flex items-baseline gap-2">
          <span className="font-mono text-3xl font-semibold tabular-nums tracking-tight">
            {formatRate(primeValue)}
          </span>
          <span className="text-xs text-muted-foreground">
            {band
              ? targetVarianceLabel(primeValue, PRIME_TARGET)
              : gated
                ? "recipe coverage too low"
                : "—"}
          </span>
        </div>
        <div className="mt-3">
          <div className="relative h-3.5 w-full overflow-hidden rounded-full bg-muted">
            <div
              className="absolute inset-y-0 left-0"
              style={{ width: foodW, background: "var(--band-good)" }}
            />
            <div
              className="absolute inset-y-0"
              style={{ left: foodW, width: laborW, background: "var(--chart-2)" }}
            />
            <div
              className="absolute -top-1 -bottom-1 z-10 w-0.5 -translate-x-1/2 bg-foreground"
              style={{ left: targetAt }}
            />
          </div>
        </div>
        <p className="mt-auto pt-2 text-[11px] leading-relaxed text-muted-foreground">
          <span className="font-medium text-foreground">
            {food == null ? "—" : formatRate(food)}
          </span>{" "}
          food +{" "}
          <span className="font-medium text-foreground">
            {labor == null ? "—" : formatRate(labor)}
          </span>{" "}
          labor, against the ≤{formatRate(target, 0)} target.
        </p>
      </StatShell>
    );
  }

  // Deferred: no labor yet -> food locked in (green), labor span hatched-pending.
  const foodW = `${Math.min(100, ((food ?? 0) / domain) * 100)}%`;
  return (
    <StatShell
      icon={Sigma}
      label="Prime cost %"
      source="Analytics"
      top={
        <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
          <TriangleAlert className="size-3" /> Incomplete
        </span>
      }
      footer={<MetricTag id="prime_cost_pct" blocked />}
    >
      <div className="flex items-baseline gap-2">
        <span className="font-mono text-3xl font-semibold tabular-nums tracking-tight text-muted-foreground/45">
          —
        </span>
        <span className="text-xs text-muted-foreground">awaiting labor</span>
      </div>
      <div className="mt-3">
        <div className="relative h-3.5 w-full overflow-hidden rounded-full bg-muted">
          <div
            className="absolute inset-y-0 left-0 rounded-l-full"
            style={{ width: foodW, background: "var(--band-good)" }}
          />
          <div
            className="absolute inset-y-0 rounded-r-full"
            style={{
              left: foodW,
              right: 0,
              backgroundImage:
                "repeating-linear-gradient(45deg, var(--hatch) 0 5px, transparent 5px 10px)",
              backgroundColor: "var(--muted)"
            }}
          />
          <div
            className="absolute -top-1 -bottom-1 z-10 w-0.5 -translate-x-1/2 bg-foreground"
            style={{ left: targetAt }}
          />
        </div>
      </div>
      <p className="mt-auto pt-2 text-[11px] leading-relaxed text-muted-foreground">
        <span className="font-medium text-foreground">{food == null ? "—" : formatRate(food)}</span>{" "}
        food locked in (green). Labor fills the hatched span once set — then prime resolves
        against the ≤{formatRate(target, 0)} target.
      </p>
    </StatShell>
  );
}

export interface YieldVarianceCardProps {
  yieldVariance: CostMetricValue | undefined;
  actualCogs: CostMetricValue | undefined;
}

export function YieldVarianceCard({ yieldVariance, actualCogs }: YieldVarianceCardProps) {
  const variance = yieldVariance?.value ?? null;
  const actual = actualCogs?.value ?? null;

  // Not connected: no counted window yet (a store must count twice to bound one).
  if (variance == null) {
    return (
      <StatShell
        icon={Scale}
        label="Yield variance"
        source="Inventory"
        top={
          <span className="inline-flex items-center gap-1.5 rounded-full border border-dashed border-border px-2 py-0.5 text-xs font-medium text-muted-foreground">
            <Plug className="size-3" /> Not connected
          </span>
        }
        footer={<MetricTag id="yield_variance_cents" blocked />}
      >
        <div className="flex items-baseline gap-2">
          <span className="font-mono text-3xl font-semibold tabular-nums tracking-tight text-muted-foreground/45">
            —
          </span>
        </div>
        <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
          Actual COGS − theoretical COGS surfaces over-portioning and shrink. It needs two physical
          counts to bracket a window (ADR-0028) — we don&apos;t fabricate it from theoretical numbers.
        </p>
      </StatShell>
    );
  }

  // Lit: a counted window exists. Positive variance = actual above theoretical
  // (shrink / over-portioning / waste beyond recipe) -> red; negative = under recipe
  // (found stock / under-portioning) -> green.
  const over = variance > 0;
  const theoretical = actual == null ? null : actual - variance;
  const tone = over
    ? { bg: "var(--band-bad-bg)", color: "var(--band-bad)" }
    : { bg: "var(--band-good-bg)", color: "var(--band-good)" };
  const magnitude = formatCents(Math.abs(variance));
  const signed = variance > 0 ? `+${magnitude}` : variance < 0 ? `-${magnitude}` : magnitude;

  return (
    <StatShell
      icon={Scale}
      label={yieldVariance?.label ?? "Yield variance"}
      source="Inventory"
      tone={tone}
      top={
        <span
          className="inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium"
          style={{ background: tone.bg, color: tone.color }}
        >
          <span aria-hidden className="inline-block size-1.5 rounded-full" style={{ background: tone.color }} />
          {over ? "Over theoretical" : "Under theoretical"}
        </span>
      }
      footer={<MetricTag id="yield_variance_cents" />}
    >
      <div className="flex items-baseline gap-2">
        <span
          className="font-mono text-3xl font-semibold tabular-nums tracking-tight"
          style={{ color: tone.color }}
        >
          {signed}
        </span>
        <span className="text-xs text-muted-foreground">
          {over ? "shrink / over-portion" : "under recipe"}
        </span>
      </div>
      <p className="mt-auto pt-3 text-[11px] leading-relaxed text-muted-foreground">
        <span className="font-medium text-foreground">
          {actual == null ? "—" : formatCents(actual)}
        </span>{" "}
        actual −{" "}
        <span className="font-medium text-foreground">
          {theoretical == null ? "—" : formatCents(theoretical)}
        </span>{" "}
        theoretical, from counted inventory windows.
      </p>
    </StatShell>
  );
}
