"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  ChefHat,
  Link2,
  Minus,
  Package,
  Plus,
  RefreshCw,
  Save,
  Search,
  Trash2
} from "lucide-react";
import type { InventoryItem, InventoryRecipeModifierLine } from "@rop/contracts";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList
} from "@/components/ui/command";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useInventory } from "@/hooks/use-inventory";
import { useRecipeDetail } from "@/hooks/use-recipe-detail";
import { formatCents } from "@/lib/format";
import { cn } from "@/lib/utils";

import { ToneBadge } from "./status-badge";

const COGS_TARGET = 28;

type Line = { sku: string; qty: number };
type Mod = InventoryRecipeModifierLine;
type ItemMap = Record<string, InventoryItem>;

function fmtQty(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(3)));
}

function fcTone(pct: number): "accent" | "warn" | "danger" {
  if (pct <= COGS_TARGET) return "accent";
  if (pct <= COGS_TARGET + 4) return "warn";
  return "danger";
}

function lineCost(sku: string, qty: number, byId: ItemMap): number {
  return (byId[sku]?.cost_cents ?? 0) * qty;
}

function QtyStepper({
  value,
  unit,
  onChange,
  allowNegative = false
}: {
  value: number;
  unit: string;
  onChange: (v: number) => void;
  allowNegative?: boolean;
}) {
  const step = Math.abs(value) < 1 ? 0.25 : 1;
  const dec = Number((value - step).toFixed(3));
  return (
    <div className="inline-flex items-center rounded-md border border-input bg-background">
      <button
        type="button"
        aria-label="Decrease quantity"
        onClick={() => onChange(allowNegative ? dec : Math.max(0, dec))}
        className="flex size-7 items-center justify-center text-muted-foreground hover:text-foreground"
      >
        <Minus className="size-3.5" />
      </button>
      <input
        value={fmtQty(value)}
        inputMode="decimal"
        onChange={(e) => {
          const v = parseFloat(e.target.value);
          onChange(Number.isNaN(v) ? 0 : v);
        }}
        className="h-7 w-12 border-x border-input bg-transparent text-center font-mono text-sm tabular-nums outline-none"
      />
      <button
        type="button"
        aria-label="Increase quantity"
        onClick={() => onChange(Number((value + step).toFixed(3)))}
        className="flex size-7 items-center justify-center text-muted-foreground hover:text-foreground"
      >
        <Plus className="size-3.5" />
      </button>
      {unit ? <span className="px-2 text-xs text-muted-foreground">{unit}</span> : null}
    </div>
  );
}

function IngredientPicker({
  items,
  exclude,
  onPick,
  label = "Search ingredients to add…"
}: {
  items: InventoryItem[];
  exclude: string[];
  onPick: (id: string) => void;
  label?: string;
}) {
  const [open, setOpen] = React.useState(false);
  const available = items.filter((i) => !exclude.includes(i.id));
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="flex h-9 w-full items-center gap-2 rounded-lg border border-dashed border-border bg-secondary/30 px-3 text-sm text-muted-foreground hover:border-solid hover:bg-background"
        >
          <Search className="size-4" /> {label}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[var(--radix-popover-trigger-width)] p-0">
        <Command>
          <CommandInput placeholder="Search ingredients…" />
          <CommandList>
            <CommandEmpty>No ingredient found.</CommandEmpty>
            <CommandGroup>
              {available.map((i) => (
                <CommandItem
                  key={i.id}
                  value={`${i.name} ${i.category}`}
                  onSelect={() => {
                    onPick(i.id);
                    setOpen(false);
                  }}
                >
                  <span className="min-w-0 flex-1 truncate">{i.name}</span>
                  <span className="text-xs text-muted-foreground">{i.category}</span>
                  <span className="ml-2 font-mono text-xs tabular-nums text-muted-foreground">
                    {formatCents(i.cost_cents)}/{i.unit}
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function RailStat({ label, value, valueClass }: { label: string; value: string; valueClass?: string }) {
  return (
    <div className="rounded-lg border border-border p-2.5">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={cn("mt-0.5 font-mono text-sm font-medium tabular-nums", valueClass)}>{value}</div>
    </div>
  );
}

function CostRail({
  sellCents,
  costCents,
  componentCount
}: {
  sellCents: number;
  costCents: number;
  componentCount: number;
}) {
  const pct = sellCents > 0 ? (costCents / sellCents) * 100 : 0;
  const margin = sellCents - costCents;
  const tone = fcTone(pct);
  const toneText =
    tone === "accent"
      ? "text-trend-up"
      : tone === "warn"
        ? "text-amber-600 dark:text-amber-400"
        : "text-trend-down";
  const toneBar = tone === "accent" ? "bg-trend-up" : tone === "warn" ? "bg-amber-500" : "bg-trend-down";
  const label = tone === "accent" ? "On target" : tone === "warn" ? "Slightly high" : "Over target";
  const gaugePct = Math.min(100, (pct / 45) * 100);
  const targetPct = (COGS_TARGET / 45) * 100;
  return (
    <div className="space-y-4">
      <div>
        <div className="flex items-baseline justify-between">
          <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Food cost</span>
          <ToneBadge tone={tone}>{label}</ToneBadge>
        </div>
        <div className={cn("mt-1 font-mono text-5xl font-medium tabular-nums", toneText)}>
          {pct.toFixed(1)}
          <span className="text-2xl">%</span>
        </div>
        <div className="relative mt-2 mb-6 h-2 rounded-full bg-secondary">
          <div className={cn("h-full rounded-full transition-all", toneBar)} style={{ width: `${gaugePct}%` }} />
          <div className="absolute -top-1 h-4 w-px bg-foreground/60" style={{ left: `${targetPct}%` }} />
          <div
            className="absolute -bottom-5 -translate-x-1/2 text-[10px] font-medium text-muted-foreground"
            style={{ left: `${targetPct}%` }}
          >
            target {COGS_TARGET}%
          </div>
        </div>
      </div>
      <div className="grid grid-cols-3 gap-2">
        <RailStat label="Sell" value={formatCents(sellCents)} />
        <RailStat label="Cost" value={formatCents(costCents)} />
        <RailStat label="Margin" value={formatCents(margin)} valueClass="text-trend-up" />
      </div>
      <div className="rounded-lg border border-accent/30 bg-accent-soft/60 p-3">
        <div className="flex items-start gap-2">
          <RefreshCw className="mt-0.5 size-4 flex-none text-accent" />
          <div className="text-xs text-foreground/80">
            <span className="font-medium text-foreground">Auto-depletion ready.</span> Every Clover sale of this
            item subtracts these {componentCount} components from stock automatically.
          </div>
        </div>
      </div>
      <p className="text-[11px] text-muted-foreground">
        Cost reflects the base recipe. Modifier options add cost per order on top.
      </p>
    </div>
  );
}

function ModifierConsumption({
  mods,
  byId,
  items,
  onRemove,
  onAdd
}: {
  mods: Mod[];
  byId: ItemMap;
  items: InventoryItem[];
  onRemove: (index: number) => void;
  onAdd: (mod: Mod) => void;
}) {
  const [adding, setAdding] = React.useState(false);
  const [group, setGroup] = React.useState("");
  const [option, setOption] = React.useState("");
  const [sku, setSku] = React.useState<string | null>(null);
  const [qty, setQty] = React.useState(1);

  // Group the flat modifier list by group -> option while keeping each row's
  // original index, so removal targets the right element of the editable array.
  const groups = React.useMemo(() => {
    const map = new Map<string, Map<string, Array<{ index: number; sku: string; qty: number }>>>();
    mods.forEach((m, index) => {
      const opts = map.get(m.group) ?? new Map<string, Array<{ index: number; sku: string; qty: number }>>();
      const rows = opts.get(m.option) ?? [];
      rows.push({ index, sku: m.sku, qty: m.qty });
      opts.set(m.option, rows);
      map.set(m.group, opts);
    });
    return map;
  }, [mods]);

  const reset = () => {
    setGroup("");
    setOption("");
    setSku(null);
    setQty(1);
    setAdding(false);
  };
  const canAdd = group.trim().length > 0 && option.trim().length > 0 && sku !== null;
  const submit = () => {
    if (!canAdd || sku === null) {
      return;
    }
    onAdd({ group: group.trim(), option: option.trim(), sku, qty });
    reset();
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Modifier consumption</CardTitle>
        <CardDescription>
          What each Clover modifier option draws from stock on top of the base recipe. A negative quantity (e.g.
          &ldquo;No Boba&rdquo;) credits stock back; an option with no rows has no inventory impact.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {groups.size === 0 ? (
          <div className="rounded-lg border border-dashed border-border px-3 py-6 text-center text-sm text-muted-foreground">
            No modifier consumption mapped yet.
          </div>
        ) : (
          [...groups.entries()].map(([g, opts]) => (
            <div key={g} className="rounded-lg border border-border">
              <div className="border-b border-border px-3.5 py-2.5 text-sm font-medium">{g}</div>
              <div className="divide-y divide-border">
                {[...opts.entries()].map(([opt, rows]) => (
                  <div key={opt} className="px-3.5 py-2.5">
                    <div className="text-sm">{opt}</div>
                    <div className="mt-2 flex flex-wrap items-center gap-1.5">
                      {rows.map((r) => {
                        const it = byId[r.sku];
                        const negative = r.qty < 0;
                        return (
                          <span
                            key={r.index}
                            className={cn(
                              "inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs",
                              negative
                                ? "border-trend-up/30 bg-trend-up-bg text-trend-up"
                                : "border-border bg-secondary/50"
                            )}
                          >
                            <span className="font-medium">{it?.name ?? r.sku}</span>
                            <span className="font-mono tabular-nums opacity-80">
                              {r.qty > 0 ? "+" : "−"}
                              {fmtQty(Math.abs(r.qty))} {it?.unit ?? ""}
                            </span>
                            <button
                              type="button"
                              aria-label="Remove consumption"
                              onClick={() => onRemove(r.index)}
                              className="text-muted-foreground hover:text-destructive"
                            >
                              <Trash2 className="size-3" />
                            </button>
                          </span>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))
        )}

        {adding ? (
          <div className="space-y-2 rounded-lg border border-border bg-secondary/20 p-3">
            <div className="grid grid-cols-2 gap-2">
              <Input placeholder="Group (e.g. Boba)" value={group} onChange={(e) => setGroup(e.target.value)} />
              <Input
                placeholder="Option (e.g. Extra Boba)"
                value={option}
                onChange={(e) => setOption(e.target.value)}
              />
            </div>
            <IngredientPicker
              items={items}
              exclude={[]}
              onPick={setSku}
              label={sku ? (byId[sku]?.name ?? "Ingredient selected") : "Choose ingredient…"}
            />
            <div className="flex items-center justify-between gap-2">
              <QtyStepper value={qty} unit={sku ? (byId[sku]?.unit ?? "") : ""} onChange={setQty} allowNegative />
              <div className="flex items-center gap-2">
                <Button variant="ghost" size="sm" onClick={reset}>
                  Cancel
                </Button>
                <Button size="sm" onClick={submit} disabled={!canAdd}>
                  Add consumption
                </Button>
              </div>
            </div>
            <p className="text-[11px] text-muted-foreground">
              Tip: use a negative quantity for an option that removes an ingredient (e.g. &ldquo;No Boba&rdquo;).
            </p>
          </div>
        ) : (
          <Button variant="outline" size="sm" onClick={() => setAdding(true)}>
            <Plus className="size-3.5" /> Add modifier consumption
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

export function RecipeEditor({ recipeId }: { recipeId: string }) {
  const router = useRouter();
  const { data: dataset } = useInventory();
  const { data: recipe, isLoading, isError, save, isSaving, saved } = useRecipeDetail(recipeId);

  const [draft, setDraft] = React.useState<{ id: string; lines: Line[]; mods: Mod[] } | null>(null);

  React.useEffect(() => {
    if (saved) {
      router.push("/inventory");
    }
  }, [saved, router]);

  const byId = React.useMemo<ItemMap>(
    () => Object.fromEntries((dataset?.items ?? []).map((i) => [i.id, i])),
    [dataset]
  );

  if (isLoading || !recipe) {
    return (
      <div className="mx-auto w-full max-w-[1400px] py-24 text-center text-sm text-muted-foreground">
        {isError ? "Couldn’t load this recipe. Confirm inventory-api is reachable, then retry." : "Loading recipe…"}
      </div>
    );
  }

  // Effective editable state, derived during render (no setState-in-effect): the
  // live draft when it belongs to this recipe, otherwise seeded from the loaded
  // recipe. An edit commits a full draft, which then takes over.
  const seeded = {
    id: recipe.id,
    lines: recipe.lines.map((l) => ({ sku: l.sku, qty: l.qty })),
    mods: recipe.modifiers.map((m) => ({ ...m }))
  };
  const state = draft && draft.id === recipe.id ? draft : seeded;
  const { lines, mods } = state;
  const commit = (next: { lines?: Line[]; mods?: Mod[] }) =>
    setDraft({ id: recipe.id, lines: next.lines ?? lines, mods: next.mods ?? mods });

  const baseCost = lines.reduce((s, l) => s + lineCost(l.sku, l.qty, byId), 0);
  const fcPct = recipe.sell_cents > 0 ? (baseCost / recipe.sell_cents) * 100 : 0;

  const setQty = (i: number, qty: number) =>
    commit({ lines: lines.map((l, idx) => (idx === i ? { ...l, qty } : l)) });
  const removeLine = (i: number) => commit({ lines: lines.filter((_, idx) => idx !== i) });
  const addLine = (sku: string) => {
    if (!lines.some((l) => l.sku === sku)) {
      commit({ lines: [...lines, { sku, qty: 1 }] });
    }
  };
  const removeMod = (i: number) => commit({ mods: mods.filter((_, idx) => idx !== i) });
  const addMod = (mod: Mod) => commit({ mods: [...mods, mod] });

  const onSave = () => save({ lines, modifiers: mods });

  return (
    <div className="mx-auto w-full max-w-[1400px] space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="outline" size="icon" onClick={() => router.push("/inventory")} aria-label="Back to inventory">
          <ArrowLeft className="size-4" />
        </Button>
        <div className="flex size-10 flex-none items-center justify-center rounded-xl bg-secondary">
          <ChefHat className="size-5 text-muted-foreground" />
        </div>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h1 className="truncate text-xl font-medium tracking-tight">{recipe.name}</h1>
            <ToneBadge tone={fcTone(fcPct)}>{fcPct.toFixed(1)}% FC</ToneBadge>
          </div>
          <div className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
            <span>{recipe.category}</span>
            <span>·</span>
            <span className="font-mono tabular-nums">{formatCents(recipe.sell_cents)}</span>
            {recipe.clover_item_id ? (
              <>
                <span>·</span>
                <span className="inline-flex items-center gap-1">
                  <Link2 className="size-3 text-accent" /> Linked to Clover
                </span>
              </>
            ) : null}
          </div>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <Button variant="outline" onClick={() => router.push("/inventory")}>
            Cancel
          </Button>
          <Button onClick={onSave} disabled={isSaving}>
            <Save className="size-4" /> {isSaving ? "Saving…" : "Save recipe"}
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[1fr_320px]">
        <div className="space-y-5">
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between gap-2">
                <div>
                  <CardTitle>Base recipe</CardTitle>
                  <CardDescription>Consumed on every order, before modifiers.</CardDescription>
                </div>
                <ToneBadge tone="neutral">
                  {lines.length} items · {formatCents(baseCost)}
                </ToneBadge>
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="overflow-hidden rounded-lg border border-border">
                <div className="flex items-center gap-3 border-b border-border bg-secondary/30 px-3 py-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  <span className="w-8" />
                  <span className="flex-1">Ingredient</span>
                  <span className="w-[150px] text-center">Quantity</span>
                  <span className="w-16 text-right">Cost</span>
                  <span className="w-7" />
                </div>
                {lines.length === 0 ? (
                  <div className="px-3 py-6 text-center text-sm text-muted-foreground">
                    No ingredients yet. Search below to add what this item consumes on every sale.
                  </div>
                ) : (
                  <div className="divide-y divide-border">
                    {lines.map((l, i) => {
                      const it = byId[l.sku];
                      return (
                        <div key={l.sku} className="flex items-center gap-3 px-3 py-2">
                          <span className="flex size-8 flex-none items-center justify-center rounded-md bg-secondary text-muted-foreground">
                            <Package className="size-4" />
                          </span>
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-sm font-medium">{it?.name ?? l.sku}</div>
                            <div className="text-xs text-muted-foreground">
                              {it ? `${it.category} · ${formatCents(it.cost_cents)}/${it.unit}` : "Unknown item"}
                            </div>
                          </div>
                          <QtyStepper value={l.qty} unit={it?.unit ?? ""} onChange={(q) => setQty(i, q)} />
                          <div className="w-16 text-right font-mono text-sm tabular-nums">
                            {formatCents(lineCost(l.sku, l.qty, byId))}
                          </div>
                          <button
                            type="button"
                            aria-label="Remove ingredient"
                            onClick={() => removeLine(i)}
                            className="flex size-7 flex-none items-center justify-center rounded-md text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                          >
                            <Trash2 className="size-4" />
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
              <IngredientPicker
                items={dataset?.items ?? []}
                exclude={lines.map((l) => l.sku)}
                onPick={addLine}
              />
            </CardContent>
          </Card>

          <ModifierConsumption
            mods={mods}
            byId={byId}
            items={dataset?.items ?? []}
            onRemove={removeMod}
            onAdd={addMod}
          />
        </div>

        <div className="lg:sticky lg:top-16 lg:self-start">
          <Card>
            <CardContent className="pt-6">
              <CostRail sellCents={recipe.sell_cents} costCents={baseCost} componentCount={lines.length} />
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
