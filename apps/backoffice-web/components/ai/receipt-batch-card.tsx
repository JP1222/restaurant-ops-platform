"use client";

import { useEffect, useState } from "react";
import { Check, Link2, Loader2, Minus, PackagePlus, Plus, Sparkles } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { useEmojiSuggest, useMatchSuggest } from "@/hooks/use-inventory";
import { bestCatalogMatch } from "@/lib/inventory/receipt-match";
import { formatUnitCost } from "@/lib/format";
import { cn } from "@/lib/utils";
import {
  applyMatchSuggestions,
  baseProductName,
  categoryFromText,
  convertForReceive,
  looksLikePackUnit,
  resolveScanPacks,
} from "@rop/contracts/match";
import type {
  InventoryCategoryId,
  InventoryDataset,
  InventoryReceiptParseResult,
} from "@rop/contracts";

const NEW_TARGET = "__new__";
// Fallback bucket for a new SKU whose name gives no category signal. A deterministic
// categoryFromText guess (frozen-dessert-aware) is tried first; only when it returns null does
// the line land in generic "Other Food" (never silently "dairy") — the operator can recategorize
// from Inventory > Items. Mirrors the crew scan default (ADR scan-multi-size D6 / ADR-0538 D2).
const DEFAULT_NEW_CATEGORY: InventoryCategoryId = "food";

export interface ReceiptBatchSource {
  vendor: string;
  date?: string;
}

// One resolved line emitted on confirm. The `sku | name+category+unit` split maps
// straight onto InventoryAdHocReceiveLine; the display fields drive the wrap-up.
// `description`/`brand`/`pack` ride along so the receive learns a vendor alias (ADR
// alias-learning D2) for matched AND new lines.
export interface ReceiptApplyLine {
  sku?: string;
  name?: string;
  category?: InventoryCategoryId;
  unit: string;
  qty: number;
  unitCostCents?: number;
  description?: string;
  brand?: string;
  pack?: string;
  // AI-suggested emoji glyph, applied only when this line inline-creates a NEW item.
  icon?: string;
  // ADR-882: a NEW pack (size) to create for this line's new item. qty then counts THESE packs and
  // the API multiplies by base_qty_per_pack. Set only for a grouped (same-product, multi-size) line.
  newPack?: { label: string; base_qty_per_pack: number };
  // ADR-882: a ref tying same-product-different-size NEW lines into ONE item with many packs (the
  // receive creates the item from the first line bearing the ref and attaches each line's pack).
  itemGroup?: string;
  itemId?: string;
  displayName: string;
  isNew: boolean;
  onHandBefore?: number;
  onHandAfter?: number;
}

interface RowState {
  description: string;
  canonicalName?: string;
  brand?: string;
  pack?: string;
  qty: number;
  unit: string;
  unitCostCents?: number;
  include: boolean;
  target: string;
  aiConfidence?: number;
  asPack: boolean;
  // AI-suggested emoji for a still-new line ("" / undefined = none, shows the category glyph).
  icon?: string;
  // ADR-882 Phase 4 — same-product-different-size grouping (mirrors crew scan-flow). When
  // `itemGroup` is set this line is one size of a multi-size NEW item: it shares the group ref so
  // the receive creates ONE item with many packs (ADR-0737). `newUnit` is that item's base unit
  // (the family's most granular unit for a group, else the printed line unit). `packLabel` /
  // `packBaseQty` describe this size's pack (base_qty in `newUnit`, cross-unit-converted from the
  // printed size); `needsPackInput` = the size couldn't auto-convert so the operator must enter it.
  // Lone / matched lines leave these blank and behave exactly as before.
  itemGroup: string; // "" = not grouped
  newUnit: string; // the NEW item's base unit (family base for a group, else the line unit)
  packLabel: string; // "" = no pack
  packBaseQty: string; // base units per pack, in `newUnit`; "" = unset
  needsPackInput: boolean;
}

function buildRows(
  lines: InventoryReceiptParseResult["lines"],
  items: InventoryDataset["items"],
  aliases: InventoryDataset["item_aliases"],
  vendor: string,
): RowState[] {
  const matched = lines.map((line) => ({
    line,
    matchId: bestCatalogMatch(line.description, items, {
      aliases,
      vendor,
      canonicalName: line.canonical_name,
    }),
  }));
  // ADR-882 Phase 4: collapse same-product-different-size lines into ONE item with many packs.
  // resolveScanPacks suggests a family group + the pack's base_qty cross-unit-converted into the
  // family's base unit — an editable, operator-confirmed default (ADR-0538 D4), split-able below.
  const packPlan = resolveScanPacks(
    matched.map(({ line, matchId }, index) => ({
      index,
      matchId: matchId || null,
      canonicalName: line.canonical_name,
      description: line.description,
    })),
    items.map((it) => ({ id: it.id, name: it.name, unit: it.unit })),
  );
  return matched.map(({ line, matchId }, index) => {
    const item = matchId ? items.find((it) => it.id === matchId) : undefined;
    const rp = packPlan[index];
    // Phase 4b wires the FAMILY case only (mirrors crew): >=2 NEW lines that are one product at
    // different sizes become ONE new item with many packs (the screenshot scenario). The
    // new-size-of-an-EXISTING-item suggestion (rp.targetItemId) renders as a matched row, which has
    // no pack editor — deferred. A non-family line stays flat exactly as before.
    const itemGroup = rp?.itemGroup ?? "";
    // A NEW family item is created in the family's resolved base unit (e.g. "oz"); else the line's.
    const newUnit = (itemGroup && rp?.baseUnit) || (line.unit ?? "");
    return {
      description: line.description,
      canonicalName: line.canonical_name,
      brand: line.brand,
      pack: line.pack,
      qty: Math.max(0, Math.round(line.qty)),
      unit: line.unit ?? "",
      unitCostCents: line.unit_price_cents,
      include: true,
      target: matchId || NEW_TARGET,
      asPack: Boolean(
        item && item.pack_qty > 1 && looksLikePackUnit(line.unit ?? "", item.purchase_unit),
      ),
      itemGroup,
      newUnit,
      packLabel: itemGroup ? rp?.pack?.label ?? "" : "",
      packBaseQty: itemGroup && rp?.pack ? String(rp.pack.baseQtyPerPack) : "",
      needsPackInput: itemGroup ? rp?.needsPackInput ?? false : false,
    };
  });
}

function Stepper({
  value,
  unit,
  onChange,
}: {
  value: number;
  unit: string;
  onChange: (next: number) => void;
}) {
  return (
    <div className="border-input flex items-center rounded-md border p-0.5">
      <button
        type="button"
        aria-label="Decrease quantity"
        className="hover:bg-muted grid size-6 place-items-center rounded-sm"
        onClick={() => onChange(Math.max(0, value - 1))}
      >
        <Minus className="size-3.5" />
      </button>
      <input
        type="number"
        aria-label="Quantity"
        value={value}
        min={0}
        onChange={(event) => onChange(Math.max(0, Math.round(Number(event.target.value) || 0)))}
        className="w-9 [appearance:textfield] bg-transparent text-center font-mono text-sm tabular-nums outline-none [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
      />
      <button
        type="button"
        aria-label="Increase quantity"
        className="hover:bg-muted grid size-6 place-items-center rounded-sm"
        onClick={() => onChange(value + 1)}
      >
        <Plus className="size-3.5" />
      </button>
      {unit ? <span className="text-muted-foreground px-1.5 text-xs">{unit}</span> : null}
    </div>
  );
}

interface ReceiptBatchCardProps {
  lines: InventoryReceiptParseResult["lines"];
  source: ReceiptBatchSource;
  items: InventoryDataset["items"];
  aliases: InventoryDataset["item_aliases"];
  applied: boolean;
  appliedSummary?: string;
  pending?: boolean;
  onApply: (lines: ReceiptApplyLine[]) => void;
  onCancel: () => void;
}

export function ReceiptBatchCard({
  lines,
  source,
  items,
  aliases,
  applied,
  appliedSummary,
  pending = false,
  onApply,
  onCancel,
}: ReceiptBatchCardProps) {
  const [rows, setRows] = useState<RowState[]>(() =>
    buildRows(lines, items, aliases, source.vendor),
  );
  const matchSuggest = useMatchSuggest();
  const emojiSuggest = useEmojiSuggest();

  // AI semantic-match tier (ADR-0587): once, ask the model to resolve the lines the
  // deterministic alias→fuzzy tiers left as new-SKU. Best-effort — a disabled/failed call
  // just leaves the deterministic result, and only accepted (>= threshold, real-item)
  // suggestions upgrade still-new rows. Skipped once applied or when nothing is residual.
  useEffect(() => {
    if (applied) return;
    const built = buildRows(lines, items, aliases, source.vendor);
    const residual = built
      .map((row, index) => ({ index, text: (row.canonicalName || row.description).trim() }))
      .filter(({ index, text }) => built[index]?.target === NEW_TARGET && text.length > 0);
    if (residual.length === 0) return;
    let cancelled = false;
    void (async () => {
      try {
        const { suggestions, threshold } = await matchSuggest.mutateAsync({
          lines: residual,
          candidates: items.map((it) => ({ id: it.id, name: it.name })),
        });
        if (cancelled) return;
        const accepted = applyMatchSuggestions(
          suggestions,
          new Set(items.map((it) => it.id)),
          threshold,
        );
        if (accepted.size === 0) return;
        setRows((cur) =>
          cur.map((row, index) => {
            const hit = accepted.get(index);
            if (!hit || row.target !== NEW_TARGET) return row;
            const item = items.find((it) => it.id === hit.itemId);
            const asPack = Boolean(
              item && item.pack_qty > 1 && looksLikePackUnit(row.unit, item.purchase_unit),
            );
            // The AI matched this line to a real item, so it's no longer a NEW family member —
            // drop any size-grouping the deterministic pass suggested (ADR-882) and receive it into
            // the matched item normally.
            return {
              ...row,
              target: hit.itemId,
              aiConfidence: hit.confidence,
              asPack,
              itemGroup: "",
              newUnit: row.unit,
              packLabel: "",
              packBaseQty: "",
              needsPackInput: false,
            };
          }),
        );
      } catch {
        // best-effort: keep the deterministic rows
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run once for this parse result
  }, []);

  // AI emoji-icon tier: once, ask the model for an emoji per NEW-SKU line so a freshly-created
  // item lands with an icon instead of the bare category fallback (the same "milk → 🥛" assist
  // the add-item dialog gives). Best-effort + cosmetic: only still-new rows are decorated, a
  // matched row ignores its icon at confirm, and a disabled/failed call just leaves no icon.
  useEffect(() => {
    if (applied) return;
    const built = buildRows(lines, items, aliases, source.vendor);
    const newLines = built
      .map((row, index) => ({ index, name: (row.canonicalName || row.description).trim() }))
      .filter(({ index, name }) => built[index]?.target === NEW_TARGET && name.length > 0);
    if (newLines.length === 0) return;
    let cancelled = false;
    void (async () => {
      try {
        const { suggestions } = await emojiSuggest.mutateAsync({ names: newLines });
        if (cancelled) return;
        const byIndex = new Map(suggestions.filter((s) => s.emoji).map((s) => [s.index, s.emoji]));
        if (byIndex.size === 0) return;
        setRows((cur) =>
          cur.map((row, index) => {
            const glyph = byIndex.get(index);
            // Only decorate a still-new, icon-less row; never touch a matched/edited one.
            if (!glyph || row.target !== NEW_TARGET || row.icon) return row;
            return { ...row, icon: glyph };
          }),
        );
      } catch {
        // best-effort: a freshly-created item just falls back to its category glyph
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run once for this parse result
  }, []);

  const setRow = (index: number, patch: Partial<RowState>) =>
    setRows((cur) => cur.map((row, i) => (i === index ? { ...row, ...patch } : row)));

  const itemFor = (row: RowState) =>
    row.target === NEW_TARGET ? undefined : items.find((it) => it.id === row.target);

  const active = rows.filter((row) => row.include && row.qty > 0);
  const totalUnits = active.reduce((sum, row) => sum + row.qty, 0);

  const resolve = (row: RowState): ReceiptApplyLine => {
    const item = itemFor(row);
    // ADR-882: a grouped NEW line books a new_pack (this size); qty then counts THOSE packs and the
    // server multiplies by base_qty. Only set for a grouped line with a parsed/entered base qty.
    const newPack =
      row.itemGroup && row.packLabel.trim() !== "" && Number(row.packBaseQty) > 0
        ? { label: row.packLabel.trim(), base_qty_per_pack: Number(row.packBaseQty) }
        : undefined;
    if (item) {
      // Convert "2 cases @ $50" → "24 each @ $4.17" when received as a pack (ADR-0592);
      // operator-confirmed on the row, server math unchanged.
      const { qty, unitCostCents } = convertForReceive(
        row.qty,
        row.unitCostCents,
        item.pack_qty,
        row.asPack,
      );
      return {
        sku: item.id,
        unit: item.unit,
        qty,
        unitCostCents,
        // Raw printed text + AI metadata so the receive learns this vendor's wording
        // for the matched item (ADR-0586 D2).
        description: row.description,
        brand: row.brand,
        pack: row.pack,
        itemId: item.id,
        displayName: item.name,
        isNew: false,
        onHandBefore: item.on_hand,
        onHandAfter: item.on_hand + qty,
      };
    }
    // A NEW item is created with the model's CLEAN canonical name (brand/pack stripped,
    // ADR-0586 D4), while the raw printed text is preserved as the alias. A grouped family member
    // is named by its BASE product (size stripped) so the shared item isn't named after one size.
    const name = row.itemGroup
      ? baseProductName(row.canonicalName || row.description)
      : row.canonicalName?.trim() || row.description.trim();
    // A new_pack line booked `qty` packs -> qty * base_qty base units; else qty is already base.
    const bookedBase = newPack ? row.qty * newPack.base_qty_per_pack : row.qty;
    return {
      name,
      category: categoryFromText(name) ?? DEFAULT_NEW_CATEGORY,
      unit: row.newUnit.trim() || "each",
      qty: row.qty,
      unitCostCents: row.unitCostCents,
      description: row.description,
      brand: row.brand,
      pack: row.pack,
      icon: row.icon,
      ...(newPack ? { newPack } : {}),
      ...(row.itemGroup ? { itemGroup: row.itemGroup } : {}),
      displayName: name,
      isNew: true,
      onHandBefore: 0,
      onHandAfter: bookedBase,
    };
  };

  if (applied) {
    return (
      <div
        className="bg-card rounded-xl border"
        style={{ borderColor: "color-mix(in oklch, var(--accent) 45%, var(--border))" }}
        data-testid="receipt-batch-applied"
      >
        <div
          className="flex items-center gap-2 px-3.5 py-3 text-sm font-medium"
          style={{ color: "var(--trend-up)" }}
        >
          <span className="bg-accent text-accent-foreground grid size-6 shrink-0 place-items-center rounded-full">
            <Check className="size-3.5" />
          </span>
          <span>
            {appliedSummary ??
              `Receiving applied · ${active.length} ${active.length === 1 ? "line" : "lines"} from ${source.vendor || "the receipt"}.`}
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-card overflow-hidden rounded-xl border" data-testid="receipt-batch-card">
      <div className="flex items-center gap-2.5 border-b px-3.5 py-3">
        <span className="bg-accent-soft text-accent grid size-8 shrink-0 place-items-center rounded-md">
          <PackagePlus className="size-4" />
        </span>
        <div className="min-w-0">
          <div className="text-sm font-semibold leading-tight">Confirm receiving</div>
          <div className="text-muted-foreground mt-0.5 text-xs">
            Review quantities, then apply to on-hand
          </div>
        </div>
        <span className="text-muted-foreground ml-auto shrink-0 font-mono text-xs">
          {source.vendor || "Receipt"}
          {source.date ? ` · ${source.date}` : ""}
        </span>
      </div>

      {rows.map((row, index) => {
        const item = itemFor(row);
        const isNew = row.target === NEW_TARGET;
        const unit = item ? item.unit : row.unit;
        // What actually commits, after any operator-confirmed pack conversion (ADR-0592),
        // so the on-hand preview matches what the receive will write.
        const converted = convertForReceive(row.qty, row.unitCostCents, item?.pack_qty ?? 1, row.asPack);
        const after = (item ? item.on_hand : 0) + converted.qty;
        // New items show the model's CLEAN canonical name; the raw printed text drops to
        // the subline (ADR-0586 D4) so the operator sees both. A grouped family member shows its
        // BASE product name (size stripped) — the shared item isn't named after one size (ADR-882).
        const newName = row.itemGroup
          ? baseProductName(row.canonicalName || row.description)
          : row.canonicalName?.trim() || row.description.trim();
        const shownName = item ? item.name : newName;
        const rawText = row.description.trim();
        const showRaw = rawText.length > 0 && rawText.toLowerCase() !== shownName.toLowerCase();
        return (
          <div
            key={index}
            className={cn(
              "grid grid-cols-[auto_1fr_auto] items-center gap-2.5 border-b px-3.5 py-2.5 transition-opacity",
              !row.include && "opacity-40",
            )}
            style={isNew ? { background: "var(--band-warn-bg)" } : undefined}
          >
            <Checkbox
              checked={row.include}
              onCheckedChange={(checked) => setRow(index, { include: checked === true })}
              aria-label={`Include ${item ? item.name : row.description}`}
              className="data-checked:border-accent! data-checked:bg-accent!"
            />
            <div className="min-w-0">
              <div className="flex items-center gap-1.5 text-sm font-medium">
                {isNew && row.icon ? (
                  <span className="shrink-0 leading-none">{row.icon}</span>
                ) : null}
                <span className="truncate">{shownName}</span>
                {isNew ? (
                  <span
                    className="shrink-0 rounded px-1.5 py-0.5 text-[0.6rem] font-bold uppercase tracking-wide"
                    style={{ color: "var(--band-warn)", background: "var(--band-warn-bg)" }}
                  >
                    New SKU
                  </span>
                ) : null}
                {!isNew && row.aiConfidence != null ? (
                  <span className="bg-accent-soft text-accent inline-flex shrink-0 items-center gap-0.5 rounded px-1.5 py-0.5 text-[0.6rem] font-bold uppercase tracking-wide">
                    <Sparkles className="size-2.5" /> AI {Math.round(row.aiConfidence * 100)}%
                  </span>
                ) : null}
              </div>
              {showRaw ? (
                <div className="text-muted-foreground mt-0.5 truncate font-mono text-[0.7rem]">
                  &ldquo;{rawText}&rdquo;
                </div>
              ) : null}
              {item ? (
                <>
                  <div className="text-muted-foreground mt-0.5 font-mono text-xs tabular-nums">
                    {item.on_hand} &rarr;{" "}
                    <span className="font-semibold" style={{ color: "var(--trend-up)" }}>
                      {after}
                    </span>{" "}
                    {unit} on hand
                  </div>
                  {item.pack_qty > 1 ? (
                    <div className="mt-1 flex flex-wrap items-center gap-2 text-xs">
                      <Checkbox
                        id={`aspack-${index}`}
                        checked={row.asPack}
                        onCheckedChange={(v) => setRow(index, { asPack: v === true })}
                        className="data-checked:border-accent! data-checked:bg-accent!"
                      />
                      <label htmlFor={`aspack-${index}`} className="text-muted-foreground cursor-pointer">
                        by {item.purchase_unit.trim() || "pack"} (&times;{item.pack_qty})
                      </label>
                      {row.asPack && converted.unitCostCents != null ? (
                        <span className="text-muted-foreground tabular-nums">
                          {formatUnitCost(converted.unitCostCents)}/{item.unit}
                        </span>
                      ) : null}
                    </div>
                  ) : null}
                </>
              ) : (
                <div className="mt-1 space-y-1.5">
                  {row.itemGroup ? (
                    <div className="bg-accent-soft text-accent flex flex-wrap items-center gap-1.5 rounded-md px-2 py-1 text-[0.7rem]">
                      <Link2 className="size-3 shrink-0" />
                      <span className="font-semibold">Same item</span>
                      <span className="opacity-75">grouped sizes &rarr; one item, many packs</span>
                      <span className="flex-1" />
                      <button
                        type="button"
                        onClick={() =>
                          setRow(index, {
                            itemGroup: "",
                            newUnit: row.unit,
                            packLabel: "",
                            packBaseQty: "",
                            needsPackInput: false,
                          })
                        }
                        className="border-input bg-background rounded border px-1.5 py-0.5 font-semibold"
                      >
                        Split
                      </button>
                    </div>
                  ) : null}
                  <div className="flex items-center gap-2">
                    <label
                      className="shrink-0 text-xs"
                      htmlFor={`map-${index}`}
                      style={{ color: "var(--band-warn)" }}
                    >
                      Map to
                    </label>
                    <select
                      id={`map-${index}`}
                      value={row.target}
                      onChange={(event) => {
                        const value = event.target.value;
                        const picked = items.find((it) => it.id === value);
                        const asPack = Boolean(
                          picked && picked.pack_qty > 1 && looksLikePackUnit(row.unit, picked.purchase_unit),
                        );
                        // Mapping onto a real item un-groups the row — a matched line has no pack
                        // editor; ADR-882 grouping is for NEW lines only.
                        setRow(index, {
                          target: value,
                          asPack,
                          ...(value === NEW_TARGET
                            ? {}
                            : { itemGroup: "", packLabel: "", packBaseQty: "", needsPackInput: false }),
                        });
                      }}
                      className="border-input bg-background focus:ring-ring h-7 min-w-0 flex-1 rounded-md border px-1.5 text-xs focus:outline-none focus:ring-2"
                    >
                      <option value={NEW_TARGET}>+ Create &ldquo;{newName}&rdquo;</option>
                      {items.map((it) => (
                        <option key={it.id} value={it.id}>
                          {it.name}
                        </option>
                      ))}
                    </select>
                  </div>
                  {row.itemGroup ? (
                    <div className="flex items-center gap-2">
                      <input
                        value={row.packLabel}
                        onChange={(event) => setRow(index, { packLabel: event.target.value })}
                        placeholder="Pack (e.g. 28 oz)"
                        aria-label="Pack label"
                        className="border-input bg-background focus:ring-ring h-7 min-w-0 flex-1 rounded-md border px-1.5 text-xs focus:outline-none focus:ring-2"
                      />
                      <input
                        type="number"
                        step="0.0001"
                        inputMode="decimal"
                        value={row.packBaseQty}
                        onChange={(event) => setRow(index, { packBaseQty: event.target.value, needsPackInput: false })}
                        placeholder={`Qty / pack (${row.newUnit || "?"})`}
                        aria-label="Base quantity per pack"
                        className="border-input bg-background focus:ring-ring h-7 w-32 rounded-md border px-1.5 text-xs tabular-nums focus:outline-none focus:ring-2"
                        style={row.needsPackInput ? { borderColor: "var(--band-warn)" } : undefined}
                      />
                    </div>
                  ) : null}
                  {row.itemGroup && row.needsPackInput ? (
                    <div className="text-[0.7rem]" style={{ color: "var(--band-warn)" }}>
                      Enter the pack size for this line.
                    </div>
                  ) : null}
                </div>
              )}
            </div>
            <Stepper value={row.qty} unit={unit} onChange={(next) => setRow(index, { qty: next })} />
          </div>
        );
      })}

      <div className="flex items-center gap-2 px-3.5 py-2.5">
        <span className="text-muted-foreground text-xs">
          <span className="text-foreground font-semibold tabular-nums">{active.length}</span> lines ·{" "}
          <span className="text-foreground font-semibold tabular-nums">{totalUnits}</span> units in
        </span>
        <span className="flex-1" />
        <Button type="button" variant="outline" size="sm" disabled={pending} onClick={onCancel}>
          Cancel
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={pending || active.length === 0}
          onClick={() => onApply(active.map(resolve))}
          data-testid="receipt-batch-confirm"
        >
          {pending ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
          {pending ? "Applying…" : "Confirm receiving"}
        </Button>
      </div>
    </div>
  );
}
