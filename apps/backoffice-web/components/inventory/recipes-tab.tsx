"use client";

import Link from "next/link";
import * as React from "react";
import {
  AlertTriangle,
  ChefHat,
  ChevronDown,
  ChevronRight,
  Download,
  Plus,
  Search
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { formatCents } from "@/lib/format";
import { downloadRecipesCsv } from "@/lib/inventory/export-csv";
import { cn } from "@/lib/utils";
import type { InventoryDataset, InventoryItem, InventoryRecipe } from "@rop/contracts";

import { NewRecipeDialog } from "./new-recipe-dialog";
import { ToneBadge } from "./status-badge";

function recipeCost(recipe: InventoryRecipe, byId: Record<string, InventoryItem>): number {
  return recipe.lines.reduce((s, l) => s + (byId[l.sku]?.cost_cents ?? 0) * l.qty, 0);
}

function RecipeCard({
  recipe,
  byId
}: {
  recipe: InventoryRecipe;
  byId: Record<string, InventoryItem>;
}) {
  const [open, setOpen] = React.useState(false);
  const cost = recipeCost(recipe, byId);
  const fcPct = (cost / recipe.sell_cents) * 100;
  const margin = recipe.sell_cents - cost;
  const tone = fcPct > 32 ? "danger" : fcPct > 28 ? "warn" : "accent";

  const bottleneck = recipe.lines.reduce(
    (best, line) => {
      const it = byId[line.sku];
      if (!it) return best;
      const possible = it.on_hand / line.qty;
      return possible < best.possible ? { line, possible } : best;
    },
    { line: null as InventoryRecipe["lines"][number] | null, possible: Number.POSITIVE_INFINITY }
  );

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-start gap-3">
          <div className="flex size-10 flex-none items-center justify-center rounded-lg bg-secondary">
            <ChefHat className="size-5 text-muted-foreground" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <CardTitle>{recipe.name}</CardTitle>
              <ToneBadge tone="outline" className="text-[10px]">
                {recipe.category}
              </ToneBadge>
            </div>
            <CardDescription className="mt-0.5">
              {recipe.lines.length} ingredients · {recipe.sold_today} sold today
            </CardDescription>
          </div>
          <ToneBadge tone={tone} className="text-[11px]">
            {fcPct.toFixed(1)}% FC
          </ToneBadge>
        </div>
      </CardHeader>
      <CardContent className="space-y-3 pt-0">
        <div className="grid grid-cols-3 gap-2">
          <div className="rounded-md border border-border p-2.5">
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Sell</div>
            <div className="mt-0.5 font-mono text-sm font-medium tabular-nums">
              {formatCents(recipe.sell_cents)}
            </div>
          </div>
          <div className="rounded-md border border-border p-2.5">
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Cost</div>
            <div className="mt-0.5 font-mono text-sm font-medium tabular-nums">
              {formatCents(cost)}
            </div>
          </div>
          <div className="rounded-md border border-border p-2.5">
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Margin</div>
            <div className="mt-0.5 font-mono text-sm font-medium tabular-nums">
              {formatCents(margin)}
            </div>
          </div>
        </div>

        {bottleneck.line && bottleneck.possible < 40 && (
          <div className="flex items-center gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs dark:border-amber-900/60 dark:bg-amber-950/40">
            <AlertTriangle className="size-3.5 flex-none text-amber-700 dark:text-amber-300" />
            <span className="text-amber-900 dark:text-amber-200">
              Limited by{" "}
              <span className="font-medium">{byId[bottleneck.line.sku]?.name}</span> — can make ~
              <span className="font-mono tabular-nums">{Math.floor(bottleneck.possible)}</span>{" "}
              more today.
            </span>
          </div>
        )}

        <div className="flex items-center justify-between gap-2">
          <button
            onClick={() => setOpen((o) => !o)}
            className="flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
          >
            {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
            {open ? "Hide" : "Show"} ingredients
          </button>
          <Button asChild size="sm" variant="outline">
            <Link href={`/inventory/recipes/${recipe.id}`}>
              Edit recipe
              <ChevronRight className="size-3.5" />
            </Link>
          </Button>
        </div>

        {open && (
          <div className="divide-y divide-border rounded-md border border-border">
            {recipe.lines.map((l, i) => {
              const it = byId[l.sku];
              if (!it) return null;
              const lineCost = it.cost_cents * l.qty;
              return (
                <div key={i} className="flex items-center gap-3 px-3 py-2 text-sm">
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium">{it.name}</div>
                    <div className="text-xs text-muted-foreground">{it.sku}</div>
                  </div>
                  <div className="text-right">
                    <div className="font-mono text-sm tabular-nums">
                      {l.qty} {it.unit}
                    </div>
                    <div className="font-mono text-xs tabular-nums text-muted-foreground">
                      {formatCents(lineCost)}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export interface RecipesTabProps {
  data: InventoryDataset;
}

export function RecipesTab({ data }: RecipesTabProps) {
  const byId = React.useMemo(
    () => Object.fromEntries(data.items.map((i) => [i.id, i])) as Record<string, InventoryItem>,
    [data.items]
  );
  const [query, setQuery] = React.useState("");
  const [newOpen, setNewOpen] = React.useState(false);

  const totalSold = data.recipes.reduce((s, r) => s + r.sold_today, 0);
  const wAvgFc =
    (data.recipes.reduce(
      (s, r) => s + (recipeCost(r, byId) / r.sell_cents) * r.sold_today,
      0
    ) /
      Math.max(1, totalSold)) *
    100;
  const totalRev = data.recipes.reduce((s, r) => s + r.sell_cents * r.sold_today, 0);
  const totalCost = data.recipes.reduce((s, r) => s + recipeCost(r, byId) * r.sold_today, 0);

  const filtered = data.recipes.filter(
    (r) => !query || r.name.toLowerCase().includes(query.toLowerCase())
  );

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Today&apos;s revenue</CardDescription>
            <CardTitle className="mt-1 text-2xl font-medium tabular-nums">
              {formatCents(totalRev)}
            </CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">
            {totalSold} units across {data.recipes.length} recipes
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Theoretical food cost</CardDescription>
            <CardTitle className="mt-1 text-2xl font-medium tabular-nums">
              {formatCents(totalCost)}
            </CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">
            From ingredient costs × volumes — actual draws may differ.
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Weighted FC %</CardDescription>
            <CardTitle
              className={cn(
                "mt-1 text-2xl font-medium tabular-nums",
                wAvgFc > 30 && "text-trend-down"
              )}
            >
              {wAvgFc.toFixed(1)}%
            </CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">
            Target {data.cogs_target_pct}%. Items above target shown in red.
          </CardContent>
        </Card>
      </div>

      <div className="flex items-center gap-2">
        <div className="relative max-w-md flex-1">
          <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="pl-8"
            placeholder="Search recipes…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <div className="ml-auto" />
        <Button
          size="sm"
          variant="outline"
          onClick={() => downloadRecipesCsv(filtered)}
          disabled={filtered.length === 0}
        >
          <Download className="size-3.5" />
          Export
        </Button>
        <Button size="sm" onClick={() => setNewOpen(true)}>
          <Plus className="size-3.5" />
          New recipe
        </Button>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {filtered.map((r) => (
          <RecipeCard key={r.id} recipe={r} byId={byId} />
        ))}
      </div>

      {newOpen ? (
        <NewRecipeDialog
          open
          onOpenChange={(next) => {
            if (!next) setNewOpen(false);
          }}
          data={data}
        />
      ) : null}
    </div>
  );
}
