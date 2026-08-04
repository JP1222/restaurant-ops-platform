"use client";

import * as React from "react";
import { Archive, Calculator, ChefHat, ClipboardCheck, Pencil, Slash } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { formatCents, formatUnitCost } from "@/lib/format";
import { STATUS_LABEL, STATUS_TONE, statusOf } from "@/lib/inventory/helpers";
import { cn } from "@/lib/utils";
import type { InventoryDataset, InventoryItem, InventoryItemSave } from "@rop/contracts";
import { vendorPricesForItem } from "@rop/contracts/match";

import { ItemIconControl } from "./item-icon-control";
import { ItemPackagingSection } from "./item-packaging-section";
import { ParBar } from "./par-bar";
import { ToneBadge } from "./status-badge";

// Cost & purchase->usage conversion editor (catalog S3b). Buy by the purchase unit
// (a Case/Jug/...) for a price covering `pack` usage-units; the per-usage cost is
// derived. Keyed by item id at the call site so each opened item gets fresh state.
function CostConversionSection({
  item,
  onSave
}: {
  item: InventoryItem;
  onSave: (id: string, body: InventoryItemSave) => void;
}) {
  const [editing, setEditing] = React.useState(false);
  const [purchaseUnit, setPurchaseUnit] = React.useState(item.purchase_unit);
  const [packQty, setPackQty] = React.useState(String(item.pack_qty));
  const [price, setPrice] = React.useState((item.purchase_cost_cents / 100).toFixed(2));

  const packNum = parseFloat(packQty) || 0;
  const priceCents = Math.round((parseFloat(price) || 0) * 100);
  const derivedCents = packNum > 0 ? priceCents / packNum : item.cost_cents;

  const save = () => {
    onSave(item.id, {
      purchase_unit: purchaseUnit.trim(),
      pack_qty: packNum > 0 ? packNum : 1,
      purchase_cost_cents: priceCents
    });
    setEditing(false);
  };

  return (
    <section className="rounded-lg border border-border p-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm font-medium">
          <Calculator className="size-4 text-muted-foreground" />
          Cost &amp; conversion
        </div>
        {!editing ? (
          <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
            <Pencil className="size-3.5" />
            Edit
          </Button>
        ) : null}
      </div>

      {!editing ? (
        <div className="mt-3 space-y-1.5 text-sm">
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Usage cost</span>
            <span className="font-mono tabular-nums">
              {formatUnitCost(item.cost_cents)}/{item.unit}
            </span>
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="text-muted-foreground">Purchase</span>
            <span className="truncate text-right font-mono tabular-nums">
              {item.purchase_unit
                ? `${item.purchase_unit} · ${item.pack_qty} ${item.unit} · ${formatCents(item.purchase_cost_cents)}`
                : "Not set up"}
            </span>
          </div>
        </div>
      ) : (
        <div className="mt-3 space-y-3">
          <div className="grid grid-cols-2 gap-2">
            <label className="space-y-1">
              <span className="text-[11px] text-muted-foreground">Purchase unit</span>
              <Input
                value={purchaseUnit}
                onChange={(e) => setPurchaseUnit(e.target.value)}
                placeholder="Case"
              />
            </label>
            <label className="space-y-1">
              <span className="text-[11px] text-muted-foreground">
                Price ($ per {purchaseUnit || "unit"})
              </span>
              <Input
                value={price}
                inputMode="decimal"
                onChange={(e) => setPrice(e.target.value)}
                placeholder="52.00"
              />
            </label>
          </div>
          <label className="block space-y-1">
            <span className="text-[11px] text-muted-foreground">
              Pack size ({item.unit} per {purchaseUnit || "purchase unit"})
            </span>
            <Input
              value={packQty}
              inputMode="decimal"
              onChange={(e) => setPackQty(e.target.value)}
              placeholder="1000"
            />
          </label>
          <div className="rounded-md border border-accent/30 bg-accent-soft/60 px-3 py-2 text-xs">
            <span className="text-muted-foreground">
              1 {purchaseUnit || "unit"} ({packNum || 0} {item.unit}) = {formatCents(priceCents)}{" "}
            </span>
            <span className="font-medium text-foreground">
              → {formatUnitCost(derivedCents)}/{item.unit}
            </span>
          </div>
          <div className="flex items-center justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setEditing(false)}>
              Cancel
            </Button>
            <Button size="sm" onClick={save}>
              Save
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}

// Inline par editor (catalog D1). par_min/par_max are per-location state, so this
// saves through a path distinct from the cost editor. Mounted only while editing so
// its inputs always seed from the current item (no stale state across items).
function ParEditForm({
  item,
  onSave,
  onCancel
}: {
  item: InventoryItem;
  onSave: (parMin: number, parMax: number) => void;
  onCancel: () => void;
}) {
  const [parMin, setParMin] = React.useState(String(item.par_min));
  const [parMax, setParMax] = React.useState(String(item.par_max));
  const min = parseFloat(parMin);
  const max = parseFloat(parMax);
  const valid = Number.isFinite(min) && Number.isFinite(max) && min >= 0 && max >= min;

  return (
    <div className="mt-3 space-y-3 rounded-lg border border-border p-3">
      <div className="grid grid-cols-2 gap-2">
        <label className="space-y-1">
          <span className="text-[11px] text-muted-foreground">Par min ({item.unit})</span>
          <Input
            value={parMin}
            inputMode="decimal"
            onChange={(e) => setParMin(e.target.value)}
          />
        </label>
        <label className="space-y-1">
          <span className="text-[11px] text-muted-foreground">Par max ({item.unit})</span>
          <Input
            value={parMax}
            inputMode="decimal"
            onChange={(e) => setParMax(e.target.value)}
          />
        </label>
      </div>
      {!valid && (
        <p className="text-[11px] text-trend-down">Par max must be ≥ par min, and both ≥ 0.</p>
      )}
      <div className="flex items-center justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="sm" disabled={!valid} onClick={() => onSave(min, max)}>
          Save
        </Button>
      </div>
    </div>
  );
}

// Count: record the actual counted on-hand. The submitted number REPLACES on_hand
// (the API posts a count_adjust stock movement for the variance, keeping the ledger
// honest). Defaults to the current on_hand so a small correction is a quick edit.
function CountForm({
  item,
  onSave,
  onCancel
}: {
  item: InventoryItem;
  onSave: (count: number) => void;
  onCancel: () => void;
}) {
  const [count, setCount] = React.useState(String(item.on_hand));
  const value = parseFloat(count);
  const valid = Number.isFinite(value) && value >= 0;
  return (
    <div className="mt-3 space-y-3 rounded-lg border border-border p-3">
      <label className="space-y-1">
        <span className="text-[11px] text-muted-foreground">Counted on hand ({item.unit})</span>
        <Input
          value={count}
          inputMode="decimal"
          onChange={(e) => setCount(e.target.value)}
          autoFocus
        />
      </label>
      {!valid && <p className="text-[11px] text-trend-down">Enter a number ≥ 0.</p>}
      <div className="flex items-center justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="sm" disabled={!valid} onClick={() => onSave(value)}>
          Save count
        </Button>
      </div>
    </div>
  );
}

interface ItemDetailContentProps {
  item: InventoryItem;
  data: InventoryDataset;
  onToggle86: (id: string) => void;
  onSaveItem: (id: string, body: InventoryItemSave) => void;
  onUpdatePar: (id: string, parMin: number, parMax: number) => void;
  onArchiveItem: (id: string) => void;
  onCount: (updates: Record<string, number>) => void;
  mobile: boolean;
}

function ItemDetailContent({
  item,
  data,
  onToggle86,
  onSaveItem,
  onUpdatePar,
  onArchiveItem,
  onCount,
  mobile
}: ItemDetailContentProps) {
  const status = statusOf(item);
  const valueCents = item.cost_cents * item.on_hand;
  const [editingPar, setEditingPar] = React.useState(false);
  const [editingCount, setEditingCount] = React.useState(false);
  // Reset the editors when the sheet swaps to a different item — the "adjust state
  // during render" pattern (https://react.dev/reference/react/useState), not an
  // effect, so there's no extra commit/flash.
  const [parEditItemId, setParEditItemId] = React.useState(item.id);
  if (parEditItemId !== item.id) {
    setParEditItemId(item.id);
    setEditingPar(false);
    setEditingCount(false);
  }

  const usage = React.useMemo(() => {
    const seed = item.id.split("-").pop()!.split("").reduce((a, c) => a + c.charCodeAt(0), 0);
    return Array.from(
      { length: 14 },
      (_, i) => Math.max(0.4, ((Math.sin(seed + i * 0.7) + 1) / 2) * (item.par_max * 0.18) + 0.6)
    );
  }, [item.id, item.par_max]);
  const usageMax = Math.max(...usage);
  const usageAvg = usage.reduce((a, b) => a + b, 0) / usage.length;
  const daysOfCover = item.on_hand / usageAvg;

  const linked = data.recipes
    .filter((r) => r.lines.some((l) => l.sku === item.id))
    .map((r) => ({ r, qty: r.lines.find((l) => l.sku === item.id)!.qty }));

  const categoryName = data.categories.find((c) => c.id === item.category)?.name ?? item.category;

  // Per-vendor last cost learned from receiving (ADR-0586 Phase 2B), cheapest first.
  const vendorPrices = vendorPricesForItem(item.id, data.item_aliases);

  return (
    <div className="flex h-full flex-col">
      <header
        className={cn(
          "flex flex-none items-start gap-3 border-b border-border",
          mobile ? "px-4 py-3 pr-12" : "p-5 pr-12"
        )}
      >
        <ItemIconControl item={item} onPickIcon={(icon) => onSaveItem(item.id, { icon })} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="truncate text-lg font-semibold tracking-tight">{item.name}</h2>
            <ToneBadge tone={STATUS_TONE[status]} dot>
              {STATUS_LABEL[status]}
            </ToneBadge>
          </div>
          <p className="mt-0.5 truncate font-mono text-xs text-muted-foreground">
            {item.sku} · {categoryName} · {item.vendor}
          </p>
        </div>
      </header>

      <div
        className={cn(
          "flex-1 overflow-y-auto",
          mobile ? "space-y-5 px-4 py-4" : "space-y-6 p-5"
        )}
      >
        <section>
          <div className="mb-2 flex items-end justify-between">
            <div>
              <div className="text-xs text-muted-foreground">On hand</div>
              <div className="text-3xl font-medium tracking-tight tabular-nums">
                {item.on_hand}{" "}
                <span className="text-base font-normal text-muted-foreground">{item.unit}</span>
              </div>
            </div>
            <div className="text-right">
              <div className="text-xs text-muted-foreground">Value</div>
              <div className="text-xl font-medium tabular-nums">{formatCents(valueCents)}</div>
            </div>
          </div>
          <ParBar item={item} status={status} className="w-full" />
          <div className="mt-1.5 flex justify-between font-mono text-[11px] tabular-nums text-muted-foreground">
            <span>0</span>
            <span>
              par {item.par_min} / {item.par_max}
            </span>
            <span>
              {item.par_max} {item.unit}
            </span>
          </div>
          {editingPar ? (
            <ParEditForm
              item={item}
              onCancel={() => setEditingPar(false)}
              onSave={(min, max) => {
                onUpdatePar(item.id, min, max);
                setEditingPar(false);
              }}
            />
          ) : null}
          {editingCount ? (
            <CountForm
              item={item}
              onCancel={() => setEditingCount(false)}
              onSave={(count) => {
                onCount({ [item.id]: count });
                setEditingCount(false);
              }}
            />
          ) : null}
        </section>

        <CostConversionSection key={item.id} item={item} onSave={onSaveItem} />

        <ItemPackagingSection key={`pack-${item.id}`} item={item} />

        <section className="grid grid-cols-3 gap-2">
          <div className="rounded-lg border border-border p-3">
            <div className="text-[11px] text-muted-foreground">Unit cost</div>
            <div className="mt-1 font-mono text-sm font-medium tabular-nums">
              {formatUnitCost(item.cost_cents)}
            </div>
          </div>
          <div className="rounded-lg border border-border p-3">
            <div className="text-[11px] text-muted-foreground">Days of cover</div>
            <div
              className={cn(
                "mt-1 font-mono text-sm font-medium tabular-nums",
                daysOfCover < 1.5
                  ? "text-trend-down"
                  : daysOfCover < 3
                    ? "text-amber-600"
                    : ""
              )}
            >
              {daysOfCover.toFixed(1)} d
            </div>
          </div>
          <div className="rounded-lg border border-border p-3">
            <div className="text-[11px] text-muted-foreground">Shelf life</div>
            <div className="mt-1 font-mono text-sm font-medium tabular-nums">
              {item.shelf_days >= 999 ? "—" : `${item.shelf_days} d`}
            </div>
          </div>
        </section>

        {vendorPrices.length > 0 ? (
          <section>
            <div className="mb-2 flex items-center justify-between">
              <div className="text-sm font-medium">Vendor prices</div>
              <div className="text-xs text-muted-foreground">last paid · per {item.unit}</div>
            </div>
            <div className="space-y-1">
              {vendorPrices.map((vp, i) => (
                <div
                  key={vp.vendor}
                  className="flex items-center justify-between rounded-lg border border-border px-3 py-2 text-sm"
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="truncate">{vp.vendor}</span>
                    {i === 0 && vendorPrices.length > 1 ? (
                      <span className="bg-accent-soft text-accent shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium">
                        cheapest
                      </span>
                    ) : null}
                  </span>
                  <span className="font-mono tabular-nums">{formatUnitCost(vp.lastCostCents)}</span>
                </div>
              ))}
            </div>
          </section>
        ) : null}

        <section>
          <div className="mb-2 flex items-center justify-between">
            <div className="text-sm font-medium">Usage — last 14 days</div>
            <div className="text-xs text-muted-foreground">
              Avg{" "}
              <span className="font-mono tabular-nums text-foreground">
                {usageAvg.toFixed(1)}
              </span>{" "}
              {item.unit}/day
            </div>
          </div>
          <div
            className="grid h-20 items-end gap-1"
            style={{ gridTemplateColumns: "repeat(14, minmax(0, 1fr))" }}
          >
            {usage.map((v, i) => (
              <div
                key={i}
                className={cn("rounded-sm bg-accent/80", i >= 12 && "bg-accent")}
                style={{ height: `${(v / usageMax) * 100}%` }}
                title={`${v.toFixed(1)} ${item.unit}`}
              />
            ))}
          </div>
          <div className="mt-1 flex justify-between font-mono text-[10px] tabular-nums text-muted-foreground">
            <span>14d ago</span>
            <span>today</span>
          </div>
        </section>

        {linked.length > 0 && (
          <section>
            <div className="mb-2 text-sm font-medium">
              Used in {linked.length} recipe{linked.length !== 1 ? "s" : ""}
            </div>
            <div className="space-y-1.5">
              {linked.map(({ r, qty }) => (
                <div
                  key={r.id}
                  className="flex items-center gap-3 rounded-md border border-border p-2.5"
                >
                  <div className="flex size-7 items-center justify-center rounded bg-secondary">
                    <ChefHat className="size-3.5 text-muted-foreground" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{r.name}</div>
                    <div className="text-xs text-muted-foreground">
                      {qty} {item.unit} per serving · {r.sold_today} sold today
                    </div>
                  </div>
                  <div className="font-mono text-xs tabular-nums text-muted-foreground">
                    ≈ {(qty * r.sold_today).toFixed(1)} {item.unit}/day
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}

        <section className="rounded-lg border border-border bg-secondary/30 p-4">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <ClipboardCheck className="size-4 text-muted-foreground" />
            <span className="text-muted-foreground">Last counted</span>
            <span className="font-mono tabular-nums">{item.last_counted}</span>
            <ToneBadge tone="outline" className="ml-auto text-[10px]">
              Variance -1.8%
            </ToneBadge>
          </div>
        </section>

        <section>
          <Button
            variant="outline"
            size="sm"
            className="w-full text-trend-down hover:text-trend-down"
            onClick={() => onArchiveItem(item.id)}
          >
            <Archive className="size-3.5" />
            Archive item
          </Button>
          <p className="mt-1.5 text-[11px] text-muted-foreground">
            Hides it from the active list and reorder. History and recipes are kept; restore it
            from the Items tab&rsquo;s Archived filter.
          </p>
        </section>
      </div>

      <footer
        className={cn(
          "flex flex-none items-center gap-2 border-t border-border",
          mobile ? "p-3" : "p-4"
        )}
        style={
          mobile
            ? { paddingBottom: "calc(0.75rem + env(safe-area-inset-bottom))" }
            : undefined
        }
      >
        <Button
          variant="outline"
          size={mobile ? "lg" : "default"}
          onClick={() => setEditingPar(true)}
          disabled={editingPar}
        >
          <Pencil className="size-3.5" />
          {mobile ? "Par" : "Edit par"}
        </Button>
        <Button
          variant="outline"
          size={mobile ? "lg" : "default"}
          onClick={() => setEditingCount(true)}
          disabled={editingCount}
        >
          <ClipboardCheck className="size-3.5" />
          Count
        </Button>
        <div className="ml-auto" />
        <Button
          variant={item.flagged_86 ? "default" : "outline"}
          size={mobile ? "lg" : "default"}
          onClick={() => onToggle86(item.id)}
        >
          <Slash className="size-3.5" />
          {item.flagged_86 ? "Un-86" : "86 on KDS"}
        </Button>
      </footer>
    </div>
  );
}

export interface ItemDetailSheetProps {
  openId: string | null;
  data: InventoryDataset;
  onClose: () => void;
  onToggle86: (id: string) => void;
  onSaveItem: (id: string, body: InventoryItemSave) => void;
  onUpdatePar: (id: string, parMin: number, parMax: number) => void;
  onArchiveItem: (id: string) => void;
  onCount: (updates: Record<string, number>) => void;
  mobile: boolean;
}

export function ItemDetailSheet({
  openId,
  data,
  onClose,
  onToggle86,
  onSaveItem,
  onUpdatePar,
  onArchiveItem,
  onCount,
  mobile
}: ItemDetailSheetProps) {
  const item = openId ? data.items.find((it) => it.id === openId) : null;
  const open = Boolean(item);

  return (
    <Sheet open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <SheetContent
        side={mobile ? "bottom" : "right"}
        className={cn(
          "p-0 sm:max-w-[560px]",
          mobile && "max-h-[92vh] rounded-t-2xl border-t"
        )}
      >
        <SheetTitle className="sr-only">{item ? item.name : "Item detail"}</SheetTitle>
        {item ? (
          <ItemDetailContent
            item={item}
            data={data}
            onToggle86={onToggle86}
            onSaveItem={onSaveItem}
            onUpdatePar={onUpdatePar}
            onArchiveItem={onArchiveItem}
            onCount={onCount}
            mobile={mobile}
          />
        ) : null}
      </SheetContent>
    </Sheet>
  );
}
