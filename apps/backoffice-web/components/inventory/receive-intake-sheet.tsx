"use client";

import { useRef, useState } from "react";
import { Loader2, Plus, ScanLine, Trash2 } from "lucide-react";

import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatUnitCost } from "@/lib/format";
import {
  isVisionTimeout,
  useAdHocReceive,
  useEmojiSuggest,
  useMatchSuggest,
  useReceiptParse
} from "@/hooks/use-inventory";
import { NEW_ITEM_MATCH, bestCatalogMatch } from "@/lib/inventory/receipt-match";
import {
  defaultInventoryCategories,
  type InventoryCategoryId,
  type InventoryDataset,
  type InventoryReceiptParseResult
} from "@rop/contracts";
import {
  applyMatchSuggestions,
  convertForReceive,
  looksLikePackUnit,
  mergeReceiptLines,
  resolveLearnedAlias
} from "@rop/contracts/match";

const SELECT_CLASS =
  "h-9 w-full rounded-md border border-border bg-background px-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring";
const NEW_ITEM = NEW_ITEM_MATCH;

interface IntakeLine {
  raw: string; // raw printed vendor text (alias key + audit); "" for a hand-typed line
  description: string; // editable display/name (prefilled with the AI clean name)
  qty: string;
  unit: string;
  cost: string; // dollars; converted to cents on commit
  match: string; // existing item id | "" (unmatched) | NEW_ITEM (create)
  category: InventoryCategoryId;
  brand: string; // AI-extracted, stored on the learned alias (not the item name)
  pack: string;
  fromMemory: boolean; // matched via a learned alias (shown as a "remembered" hint)
  aiConfidence?: number; // set when the AI semantic-match tier resolved this line (0..1)
  asPack: boolean; // received in the item's purchase pack (qty/cost converted to stock units on commit)
  icon?: string; // AI-suggested emoji for a create-new line; applied at inline-create
}

function emptyLine(): IntakeLine {
  return {
    raw: "",
    description: "",
    qty: "",
    unit: "",
    cost: "",
    match: "",
    category: "food",
    brand: "",
    pack: "",
    fromMemory: false,
    asPack: false
  };
}

function lineFromParse(
  parsed: InventoryReceiptParseResult["lines"][number],
  items: InventoryDataset["items"],
  aliases: InventoryDataset["item_aliases"],
  vendor: string | undefined
): IntakeLine {
  const learned = resolveLearnedAlias(parsed.description, aliases, vendor);
  const match = bestCatalogMatch(parsed.description, items, {
    aliases,
    vendor,
    canonicalName: parsed.canonical_name
  });
  // Default the pack toggle from the invoice unit: a matched item with a real pack whose line
  // unit reads like a case/box gets pre-checked, but the operator confirms before commit.
  const matchedItem = match ? items.find((it) => it.id === match) : undefined;
  const asPack = Boolean(
    matchedItem &&
      matchedItem.pack_qty > 1 &&
      looksLikePackUnit(parsed.unit ?? "", matchedItem.purchase_unit)
  );
  return {
    raw: parsed.description,
    // Prefill the editable name with the model's CLEAN canonical name (brand/pack
    // stripped, ADR-0586 D4); the raw text is preserved separately as the alias.
    description: parsed.canonical_name?.trim() || parsed.description,
    qty: parsed.qty ? String(parsed.qty) : "",
    unit: parsed.unit ?? "",
    cost: parsed.unit_price_cents != null ? (parsed.unit_price_cents / 100).toString() : "",
    // Auto-matched -> that item; otherwise default to create-new (the operator can still
    // repoint it). On an empty catalog every line is legitimately new.
    match: match || NEW_ITEM,
    category: "food",
    brand: parsed.brand ?? "",
    pack: parsed.pack ?? "",
    fromMemory: Boolean(learned) && match === learned,
    asPack
  };
}

// Receive intake (ADR-0538 D1): one surface, fillable by hand OR pre-filled from a
// scanned invoice. Matched lines add to an existing item's stock; "create new" lines
// inline-create a catalog item from the description. Commits via the no-PO receive.
export function ReceiveIntakeSheet({
  open,
  onOpenChange,
  data
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  data: InventoryDataset;
}) {
  const [vendor, setVendor] = useState("");
  const [lines, setLines] = useState<IntakeLine[]>([emptyLine()]);
  const fileRef = useRef<HTMLInputElement>(null);
  // Last scan payload, kept so a vision timeout can offer "Try again" without
  // making the operator re-pick the photo.
  const lastScanRef = useRef<{ image_base64: string; mime_type: string } | null>(null);
  const parse = useReceiptParse();
  const receive = useAdHocReceive();
  const matchSuggest = useMatchSuggest();
  const emojiSuggest = useEmojiSuggest();

  const categories = data.categories.length > 0 ? data.categories : defaultInventoryCategories;

  const setLine = (index: number, patch: Partial<IntakeLine>) =>
    setLines((cur) => cur.map((line, i) => (i === index ? { ...line, ...patch } : line)));
  const addLine = () => setLines((cur) => [...cur, emptyLine()]);
  const removeLine = (index: number) =>
    setLines((cur) => (cur.length > 1 ? cur.filter((_, i) => i !== index) : cur));

  async function onFile(file: File) {
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
    const comma = dataUrl.indexOf(",");
    const base64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
    await runParse({ image_base64: base64, mime_type: file.type || "image/jpeg" });
  }

  async function runParse(payload: { image_base64: string; mime_type: string }) {
    lastScanRef.current = payload;
    let result: InventoryReceiptParseResult;
    try {
      result = await parse.mutateAsync(payload);
    } catch {
      return; // surfaced via parse.isError / parse.error below
    }
    if (result.vendor) setVendor(result.vendor);
    // Collapse duplicate lines that resolve to the SAME catalog item (same unit + price) into
    // one row with summed qty, before the operator reviews (conservative merge — ADR-0538 D4).
    // The deterministic match here is the merge key's resolved item; a price/unit difference
    // keeps the line a separate, visible row.
    const merged = mergeReceiptLines(
      result.lines,
      result.lines.map(
        (parsed) =>
          bestCatalogMatch(parsed.description, data.items, {
            aliases: data.item_aliases,
            vendor: result.vendor,
            canonicalName: parsed.canonical_name
          }) || null
      )
    );
    const next = merged.lines.map((parsed) =>
      lineFromParse(parsed, data.items, data.item_aliases, result.vendor)
    );
    setLines(await withEmojiSuggestions(await withAiSuggestions(next)));
  }

  function retryParse() {
    const last = lastScanRef.current;
    if (last && !parse.isPending) void runParse(last);
  }

  // AI semantic-match tier (ADR-0586 Phase 2A): for lines the deterministic alias→fuzzy
  // tiers left unmatched (defaulted to create-new), ask the model to pick an existing item.
  // Best-effort — a failed/disabled/unkeyed suggest call (503/429/etc.) just leaves the
  // deterministic result, so receiving is never blocked on the AI. Only runs when there's
  // a residual, so a fully-matched scan makes no extra call.
  async function withAiSuggestions(rows: IntakeLine[]): Promise<IntakeLine[]> {
    if (rows.length === 0) return [emptyLine()];
    const residual = rows
      .map((line, index) => ({ line, index }))
      .filter(({ line }) => line.match === NEW_ITEM && (line.description || line.raw).trim().length > 0)
      .map(({ line, index }) => ({ index, text: (line.description || line.raw).trim() }));
    if (residual.length === 0) return rows;
    try {
      const candidates = data.items.map((it) => ({ id: it.id, name: it.name }));
      const { suggestions, threshold } = await matchSuggest.mutateAsync({
        lines: residual,
        candidates
      });
      const validIds = new Set(data.items.map((it) => it.id));
      const accepted = applyMatchSuggestions(suggestions, validIds, threshold);
      if (accepted.size === 0) return rows;
      return rows.map((line, index) => {
        const hit = accepted.get(index);
        if (!hit) return line;
        const item = data.items.find((it) => it.id === hit.itemId);
        const asPack = Boolean(
          item && item.pack_qty > 1 && looksLikePackUnit(line.unit, item.purchase_unit)
        );
        return { ...line, match: hit.itemId, aiConfidence: hit.confidence, asPack };
      });
    } catch {
      return rows;
    }
  }

  // AI emoji-icon tier: for lines that will inline-create a NEW item, ask the model for an
  // emoji so the created item lands with an icon instead of the bare category fallback (the
  // same "milk → 🥛" assist the add-item dialog gives). Best-effort + cosmetic — a failed /
  // disabled / unkeyed call just leaves no icon. Only runs when there's a new-item residual.
  async function withEmojiSuggestions(rows: IntakeLine[]): Promise<IntakeLine[]> {
    const newLines = rows
      .map((line, index) => ({ index, name: (line.description || line.raw).trim() }))
      .filter(({ index, name }) => rows[index]?.match === NEW_ITEM && name.length > 0);
    if (newLines.length === 0) return rows;
    try {
      const { suggestions } = await emojiSuggest.mutateAsync({ names: newLines });
      const byIndex = new Map(suggestions.filter((s) => s.emoji).map((s) => [s.index, s.emoji]));
      if (byIndex.size === 0) return rows;
      return rows.map((line, index) => {
        const glyph = byIndex.get(index);
        if (!glyph || line.match !== NEW_ITEM || line.icon) return line;
        return { ...line, icon: glyph };
      });
    } catch {
      return rows;
    }
  }

  // Committable: positive qty, and either matched to an item or set to create-new with
  // a name. Unmatched ("pick one…") lines are skipped, not an error — partial scans happen.
  const readyLines = lines.filter((line) => {
    const qty = parseFloat(line.qty);
    if (!Number.isFinite(qty) || qty <= 0) return false;
    if (line.match === NEW_ITEM) return line.description.trim() !== "";
    return line.match !== "";
  });
  const valid = readyLines.length > 0;

  async function commit() {
    if (!valid) return;
    // No explicit idempotency_key: useAdHocReceive mints one from the body so a re-tap
    // of "Receive" after a failed/lost response reuses it (server dedups), while an edit
    // to any line re-keys. See hooks/use-idempotency-key.ts.
    await receive.mutateAsync({
      vendor: vendor.trim() || undefined,
      lines: readyLines.map((line) => {
        const enteredQty = parseFloat(line.qty);
        const enteredCostCents = Math.round((parseFloat(line.cost) || 0) * 100) || undefined;
        // Raw printed text + AI metadata teach the vendor alias (ADR-0586 D2),
        // for matched AND new lines. A hand-typed line has no raw text → no alias.
        const description = line.raw.trim() || undefined;
        const brand = line.brand.trim() || undefined;
        const pack = line.pack.trim() || undefined;
        if (line.match === NEW_ITEM) {
          return {
            name: line.description.trim(),
            category: line.category,
            unit: line.unit.trim() || "each",
            qty: enteredQty,
            unit_cost_cents: enteredCostCents,
            description,
            brand,
            pack,
            icon: line.icon
          };
        }
        // Convert "2 cases @ $50" → "24 each @ $4.17" when received as a pack (ADR-0586
        // Phase 2C). The operator has already seen + confirmed this on the row.
        const item = data.items.find((it) => it.id === line.match);
        const { qty, unitCostCents } = convertForReceive(
          enteredQty,
          enteredCostCents,
          item?.pack_qty ?? 1,
          line.asPack
        );
        return { sku: line.match, qty, unit_cost_cents: unitCostCents, description, brand, pack };
      })
    });
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-[760px]">
        <DialogHeader>
          <DialogTitle>Receive delivery</DialogTitle>
          <DialogDescription>
            Scan a vendor invoice to auto-fill, or enter lines by hand. Matched lines add to an
            existing item&rsquo;s stock; &ldquo;create new&rdquo; lines add a new catalog item. No
            purchase order needed.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-0 flex-1 space-y-1">
            <Label htmlFor="receive-vendor">
              Vendor <span className="text-muted-foreground">(optional)</span>
            </Label>
            <Input
              id="receive-vendor"
              value={vendor}
              onChange={(event) => setVendor(event.target.value)}
              placeholder="Sysco"
              maxLength={120}
            />
          </div>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void onFile(file);
              event.target.value = "";
            }}
          />
          <Button
            type="button"
            variant="outline"
            disabled={parse.isPending}
            onClick={() => fileRef.current?.click()}
          >
            {parse.isPending ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <ScanLine className="size-3.5" />
            )}
            {parse.isPending ? "Reading…" : "Scan invoice"}
          </Button>
        </div>

        {parse.isError ? (
          isVisionTimeout(parse.error) ? (
            <Alert variant="destructive">
              <AlertTitle>The scan took too long</AlertTitle>
              <AlertDescription>
                Reading the invoice timed out. This is usually temporary — try again.
              </AlertDescription>
              <AlertAction>
                <Button type="button" variant="outline" size="sm" onClick={retryParse}>
                  Try again
                </Button>
              </AlertAction>
            </Alert>
          ) : (
            <Alert variant="destructive">
              <AlertTitle>Could not read the invoice</AlertTitle>
              <AlertDescription>
                {parse.error instanceof Error ? parse.error.message : "Unknown error"}
              </AlertDescription>
            </Alert>
          )
        ) : null}

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label>Lines</Label>
            <span className="text-xs text-muted-foreground">{readyLines.length} ready</span>
          </div>
          <div className="space-y-2">
            {lines.map((line, index) => (
              <div key={index} className="rounded-md border border-border p-2">
                <div className="flex items-start gap-2">
                  <Input
                    aria-label="Description"
                    value={line.description}
                    className="min-w-0 flex-1"
                    onChange={(event) => setLine(index, { description: event.target.value })}
                    placeholder="Item / description"
                    maxLength={200}
                  />
                  <Input
                    aria-label="Quantity"
                    value={line.qty}
                    inputMode="decimal"
                    className="w-16"
                    onChange={(event) => setLine(index, { qty: event.target.value })}
                    placeholder="Qty"
                  />
                  <Input
                    aria-label="Unit"
                    value={line.unit}
                    className="w-16"
                    onChange={(event) => setLine(index, { unit: event.target.value })}
                    placeholder="Unit"
                    maxLength={24}
                  />
                  <Input
                    aria-label="Unit cost"
                    value={line.cost}
                    inputMode="decimal"
                    className="w-20"
                    onChange={(event) => setLine(index, { cost: event.target.value })}
                    placeholder="$"
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="size-9 flex-none text-muted-foreground"
                    onClick={() => removeLine(index)}
                    aria-label="Remove line"
                    disabled={lines.length === 1}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </div>
                <div className="mt-2 flex items-center gap-2">
                  <select
                    aria-label="Match to item"
                    value={line.match}
                    className={SELECT_CLASS}
                    onChange={(event) => {
                      // A manual repoint clears the auto-match provenance so the hint can't lie,
                      // and re-detects the pack default for the newly chosen item.
                      const value = event.target.value;
                      const picked = data.items.find((it) => it.id === value);
                      const asPack = Boolean(
                        picked && picked.pack_qty > 1 && looksLikePackUnit(line.unit, picked.purchase_unit)
                      );
                      setLine(index, {
                        match: value,
                        fromMemory: false,
                        aiConfidence: undefined,
                        asPack
                      });
                    }}
                  >
                    <option value="">Unmatched — pick one…</option>
                    <option value={NEW_ITEM}>Create new item</option>
                    {data.items.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name}
                      </option>
                    ))}
                  </select>
                  {line.match === NEW_ITEM && line.icon ? (
                    <span className="shrink-0 text-lg leading-none" aria-hidden>
                      {line.icon}
                    </span>
                  ) : null}
                  {line.match === NEW_ITEM ? (
                    <select
                      aria-label="Category"
                      value={line.category}
                      className={`${SELECT_CLASS} w-44`}
                      onChange={(event) =>
                        setLine(index, { category: event.target.value as InventoryCategoryId })
                      }
                    >
                      {categories.map((category) => (
                        <option key={category.id} value={category.id}>
                          {category.name}
                        </option>
                      ))}
                    </select>
                  ) : null}
                </div>
                {(() => {
                  const matchedItem =
                    line.match && line.match !== NEW_ITEM
                      ? data.items.find((it) => it.id === line.match)
                      : undefined;
                  if (!matchedItem || matchedItem.pack_qty <= 1) return null;
                  const qtyNum = parseFloat(line.qty);
                  const costNum = parseFloat(line.cost);
                  const converted = convertForReceive(
                    Number.isFinite(qtyNum) ? qtyNum : 0,
                    Number.isFinite(costNum) && costNum > 0 ? Math.round(costNum * 100) : undefined,
                    matchedItem.pack_qty,
                    true
                  );
                  return (
                    <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                      <Checkbox
                        id={`aspack-${index}`}
                        checked={line.asPack}
                        onCheckedChange={(v) => setLine(index, { asPack: v === true })}
                      />
                      <label htmlFor={`aspack-${index}`} className="cursor-pointer">
                        Received by {matchedItem.purchase_unit?.trim() || "pack"} (×{matchedItem.pack_qty})
                      </label>
                      {line.asPack && Number.isFinite(qtyNum) && qtyNum > 0 ? (
                        <span className="text-muted-foreground tabular-nums">
                          = {converted.qty} {matchedItem.unit}
                          {converted.unitCostCents != null
                            ? ` · ${formatUnitCost(converted.unitCostCents)}/${matchedItem.unit}`
                            : ""}
                        </span>
                      ) : null}
                    </div>
                  );
                })()}
                {line.fromMemory ||
                line.aiConfidence != null ||
                (line.raw.trim() &&
                  line.raw.trim().toLowerCase() !== line.description.trim().toLowerCase()) ? (
                  <div className="mt-1.5 flex items-center gap-1.5 text-xs text-muted-foreground">
                    {line.fromMemory ? (
                      <span className="bg-accent-soft text-accent rounded px-1.5 py-0.5 font-medium">
                        remembered
                      </span>
                    ) : null}
                    {!line.fromMemory && line.aiConfidence != null ? (
                      <span className="bg-accent-soft text-accent rounded px-1.5 py-0.5 font-medium">
                        AI {Math.round(line.aiConfidence * 100)}%
                      </span>
                    ) : null}
                    {line.raw.trim() &&
                    line.raw.trim().toLowerCase() !== line.description.trim().toLowerCase() ? (
                      <span className="truncate font-mono">&ldquo;{line.raw.trim()}&rdquo;</span>
                    ) : null}
                  </div>
                ) : null}
              </div>
            ))}
          </div>
          <Button type="button" variant="outline" size="sm" onClick={addLine}>
            <Plus className="size-3.5" />
            Add line
          </Button>
        </div>

        {receive.isError ? (
          <Alert variant="destructive">
            <AlertTitle>Could not receive</AlertTitle>
            <AlertDescription>
              {receive.error instanceof Error ? receive.error.message : "Unknown error"}
            </AlertDescription>
          </Alert>
        ) : null}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" disabled={receive.isPending || !valid} onClick={() => void commit()}>
            {receive.isPending
              ? "Receiving…"
              : valid
                ? `Receive ${readyLines.length} line${readyLines.length === 1 ? "" : "s"}`
                : "Receive"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
