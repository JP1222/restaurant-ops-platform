"use client";

import { useRef, useState } from "react";
import { Plus, Smile, Sparkles } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useCreateItem, useEmojiSuggest } from "@/hooks/use-inventory";
import type { InventoryCategory, InventoryItemCreate, InventoryUnitKind } from "@rop/contracts";

import { EmojiGrid } from "./emoji-grid";

const SELECT_CLASS =
  "h-9 w-full rounded-md border border-border bg-background px-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring";

export function AddItemDialog({
  categories,
  mobile
}: {
  categories: InventoryCategory[];
  mobile: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [icon, setIcon] = useState("");
  const [iconOpen, setIconOpen] = useState(false);
  const [sku, setSku] = useState("");
  const [category, setCategory] = useState<string>(categories[0]?.id ?? "");
  const [unit, setUnit] = useState("");
  const [unitKind, setUnitKind] = useState<InventoryUnitKind>("count");
  const [parMin, setParMin] = useState("");
  const [parMax, setParMax] = useState("");
  const [vendor, setVendor] = useState("");
  const [purchaseUnit, setPurchaseUnit] = useState("");
  const [packQty, setPackQty] = useState("");
  const [price, setPrice] = useState("");
  const create = useCreateItem();
  const emojiSuggest = useEmojiSuggest();
  // Once the operator opens the picker (pick OR clear), auto-suggestion stops for good — a
  // manual choice is never overwritten, and we don't re-suggest after a deliberate clear.
  const iconTouched = useRef(false);

  // AI emoji-icon suggestion, fired when the name field settles (onBlur) and only when the
  // item still has no icon (the user's decision: suggest only when empty). Best-effort +
  // cosmetic: a failed/empty suggestion just leaves the Smile placeholder. The post-await
  // re-check guards a race where the operator picks an icon while the call is in flight.
  async function maybeSuggestIcon(candidate: string) {
    const trimmed = candidate.trim();
    if (!trimmed || icon || iconTouched.current || emojiSuggest.isPending) return;
    try {
      const res = await emojiSuggest.mutateAsync({ names: [{ index: 0, name: trimmed }] });
      const glyph = res.suggestions.find((s) => s.index === 0)?.emoji ?? "";
      if (glyph && !iconTouched.current) {
        setIcon((current) => (current ? current : glyph));
      }
    } catch {
      // best-effort + cosmetic — leave the icon empty (the UI falls back to a category glyph)
    }
  }

  function reset() {
    setName("");
    setIcon("");
    setIconOpen(false);
    iconTouched.current = false;
    setSku("");
    setCategory(categories[0]?.id ?? "");
    setUnit("");
    setUnitKind("count");
    setParMin("");
    setParMax("");
    setVendor("");
    setPurchaseUnit("");
    setPackQty("");
    setPrice("");
    create.reset();
  }

  const min = parseFloat(parMin);
  const max = parseFloat(parMax);
  const parValid = Number.isFinite(min) && Number.isFinite(max) && min >= 0 && max >= min;
  const valid = name.trim() !== "" && category !== "" && unit.trim() !== "" && parValid;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) reset();
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm">
          <Plus className="size-3.5" />
          {mobile ? "Add" : "Add item"}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <form
          className="space-y-3"
          onSubmit={async (event) => {
            event.preventDefault();
            if (!valid) return;
            const packNum = parseFloat(packQty);
            const priceCents = Math.round((parseFloat(price) || 0) * 100);
            const payload: InventoryItemCreate = {
              name: name.trim(),
              sku: sku.trim() || undefined,
              category: category as InventoryItemCreate["category"],
              unit: unit.trim(),
              unit_kind: unitKind,
              par_min: min,
              par_max: max,
              vendor: vendor.trim() || undefined,
              purchase_unit: purchaseUnit.trim() || undefined,
              pack_qty: Number.isFinite(packNum) && packNum > 0 ? packNum : undefined,
              purchase_cost_cents: priceCents > 0 ? priceCents : undefined,
              icon: icon || undefined
            };
            await create.mutateAsync(payload);
            setOpen(false);
            reset();
          }}
        >
          <DialogHeader>
            <DialogTitle>Add item</DialogTitle>
            <DialogDescription>
              Creates a catalog SKU. On-hand starts at 0 — receive or count to set stock.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-1">
            <Label htmlFor="add-item-name">Name</Label>
            <div className="flex items-center gap-2">
              <Popover open={iconOpen} onOpenChange={setIconOpen}>
                <PopoverTrigger asChild>
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    aria-label="Pick icon"
                    className="size-9 flex-none text-lg"
                  >
                    {icon ? (
                      icon
                    ) : emojiSuggest.isPending ? (
                      <Sparkles className="size-4 animate-pulse text-muted-foreground" />
                    ) : (
                      <Smile className="size-4 text-muted-foreground" />
                    )}
                  </Button>
                </PopoverTrigger>
                <PopoverContent align="start" className="w-72 p-0">
                  <EmojiGrid
                    selected={icon}
                    onPick={(e) => {
                      iconTouched.current = true;
                      setIcon(e);
                      setIconOpen(false);
                    }}
                  />
                  {icon ? (
                    <div className="border-t border-border p-2">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          iconTouched.current = true;
                          setIcon("");
                          setIconOpen(false);
                        }}
                      >
                        Clear icon
                      </Button>
                    </div>
                  ) : null}
                </PopoverContent>
              </Popover>
              <Input
                id="add-item-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                onBlur={(event) => void maybeSuggestIcon(event.target.value)}
                maxLength={120}
                required
                autoFocus
                className="flex-1"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label htmlFor="add-item-category">Category</Label>
              <select
                id="add-item-category"
                value={category}
                onChange={(event) => setCategory(event.target.value)}
                className={SELECT_CLASS}
              >
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="add-item-unit">Unit</Label>
              <Input
                id="add-item-unit"
                value={unit}
                onChange={(event) => setUnit(event.target.value)}
                placeholder="lb / ml / each"
                maxLength={24}
                required
              />
            </div>
          </div>

          <div className="space-y-1">
            <Label htmlFor="add-item-unit-kind">Unit type</Label>
            <select
              id="add-item-unit-kind"
              value={unitKind}
              onChange={(event) => setUnitKind(event.target.value as InventoryUnitKind)}
              className={SELECT_CLASS}
            >
              <option value="count">Count</option>
              <option value="weight">Weight</option>
              <option value="volume">Volume</option>
            </select>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label htmlFor="add-item-parmin">Par min</Label>
              <Input
                id="add-item-parmin"
                value={parMin}
                inputMode="decimal"
                onChange={(event) => setParMin(event.target.value)}
                required
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="add-item-parmax">Par max</Label>
              <Input
                id="add-item-parmax"
                value={parMax}
                inputMode="decimal"
                onChange={(event) => setParMax(event.target.value)}
                required
              />
            </div>
          </div>
          {!parValid && (parMin !== "" || parMax !== "") ? (
            <p className="text-xs text-trend-down">Par max must be ≥ par min, and both ≥ 0.</p>
          ) : null}

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label htmlFor="add-item-sku">
                SKU <span className="text-muted-foreground">(optional)</span>
              </Label>
              <Input
                id="add-item-sku"
                value={sku}
                onChange={(event) => setSku(event.target.value)}
                placeholder="Auto-generated"
                maxLength={60}
                className="font-mono"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="add-item-vendor">
                Vendor <span className="text-muted-foreground">(optional)</span>
              </Label>
              <Input
                id="add-item-vendor"
                value={vendor}
                onChange={(event) => setVendor(event.target.value)}
                maxLength={120}
              />
            </div>
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div className="space-y-1">
              <Label htmlFor="add-item-punit">Purchase unit</Label>
              <Input
                id="add-item-punit"
                value={purchaseUnit}
                onChange={(event) => setPurchaseUnit(event.target.value)}
                placeholder="Case"
                maxLength={60}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="add-item-pack">Pack qty</Label>
              <Input
                id="add-item-pack"
                value={packQty}
                inputMode="decimal"
                onChange={(event) => setPackQty(event.target.value)}
                placeholder="1000"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="add-item-price">Price $</Label>
              <Input
                id="add-item-price"
                value={price}
                inputMode="decimal"
                onChange={(event) => setPrice(event.target.value)}
                placeholder="52.00"
              />
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            Purchase unit, pack size, and price are optional — together they derive the per-unit
            cost. You can set them later from the item.
          </p>

          {create.isError ? (
            <Alert variant="destructive">
              <AlertTitle>Could not add item</AlertTitle>
              <AlertDescription>
                {create.error instanceof Error ? create.error.message : "Unknown error"}
              </AlertDescription>
            </Alert>
          ) : null}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={create.isPending || !valid}>
              {create.isPending ? "Adding…" : "Add item"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
