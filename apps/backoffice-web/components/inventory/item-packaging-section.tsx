"use client";

import * as React from "react";
import { Barcode, Boxes, Plus, Printer, Trash2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select";
import { InventoryApiError, useItemPackEditor, useMintBarcode } from "@/hooks/use-inventory";
import type { InventoryBarcodeSource, InventoryItem, InventoryItemPack } from "@rop/contracts";

import { PrintLabelDialog } from "./print-label-dialog";

// Sentinel for "no specific pack" in the barcode pack picker — Radix Select forbids an
// empty-string item value, so map this to undefined on submit.
const ITEM_LEVEL = "__item_level__";

function saveErrorText(error: unknown): string {
  if (error instanceof InventoryApiError) {
    if (error.status === 409 || error.code === "pack_exists") {
      return "A pack with that name already exists for this vendor.";
    }
    if (error.status === 400 || error.code === "unknown_pack") {
      return "That pack doesn't belong to this item.";
    }
    if (error.status === 401) {
      return "Your session expired — sign in again.";
    }
  }
  return "Couldn't save. Try again.";
}

// Pack add/edit form (ADR-0737). base qty is in the item's base unit; vendor scopes the
// pack so two vendors' differently-sized "cases" coexist on one item.
function PackForm({
  item,
  pack,
  busy,
  onSubmit,
  onCancel
}: {
  item: InventoryItem;
  pack: InventoryItemPack | null;
  busy: boolean;
  onSubmit: (body: {
    label: string;
    base_qty_per_pack: number;
    vendor?: string;
    is_purchase_default?: boolean;
  }) => Promise<void>;
  onCancel: () => void;
}) {
  const [label, setLabel] = React.useState(pack?.label ?? "");
  const [baseQty, setBaseQty] = React.useState(pack ? String(pack.base_qty_per_pack) : "");
  const [vendor, setVendor] = React.useState(pack?.vendor ?? "");
  const [isDefault, setIsDefault] = React.useState(pack?.is_purchase_default ?? false);
  const [error, setError] = React.useState<string | null>(null);

  const qtyNum = parseFloat(baseQty) || 0;
  const valid = label.trim().length > 0 && qtyNum > 0;

  const submit = async () => {
    if (!valid || busy) return;
    setError(null);
    try {
      await onSubmit({
        label: label.trim(),
        base_qty_per_pack: qtyNum,
        vendor: vendor.trim() || undefined,
        is_purchase_default: isDefault
      });
    } catch (e) {
      setError(saveErrorText(e));
    }
  };

  return (
    <div className="space-y-3 rounded-lg border border-border bg-muted/30 p-3">
      <div className="grid grid-cols-2 gap-2">
        <label className="space-y-1">
          <span className="text-[11px] text-muted-foreground">Pack name</span>
          <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Case" />
        </label>
        <label className="space-y-1">
          <span className="text-[11px] text-muted-foreground">Base qty ({item.unit})</span>
          <Input
            value={baseQty}
            onChange={(e) => setBaseQty(e.target.value)}
            inputMode="decimal"
            placeholder="24"
          />
        </label>
      </div>
      <label className="space-y-1">
        <span className="text-[11px] text-muted-foreground">Vendor (optional)</span>
        <Input
          value={vendor}
          onChange={(e) => setVendor(e.target.value)}
          placeholder="All vendors"
        />
      </label>
      <label className="flex items-center gap-2 text-sm">
        <Checkbox checked={isDefault} onCheckedChange={(v) => setIsDefault(v === true)} />
        Default purchase pack
      </label>
      {qtyNum > 0 ? (
        <p className="text-[11px] text-muted-foreground">
          1 {label.trim() || "pack"} = {qtyNum} {item.unit}
        </p>
      ) : null}
      {error ? <p className="text-[11px] text-trend-down">{error}</p> : null}
      <div className="flex items-center justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button size="sm" onClick={submit} disabled={!valid || busy}>
          {pack ? "Save" : "Add pack"}
        </Button>
      </div>
    </div>
  );
}

// Barcode add form (ADR-0737): map a UPC/printed code to the item, optionally a pack.
function BarcodeForm({
  item,
  busy,
  onSubmit,
  onCancel
}: {
  item: InventoryItem;
  busy: boolean;
  onSubmit: (body: {
    code: string;
    pack_id?: string;
    source: InventoryBarcodeSource;
  }) => Promise<void>;
  onCancel: () => void;
}) {
  const [code, setCode] = React.useState("");
  const [packId, setPackId] = React.useState(ITEM_LEVEL);
  const [source, setSource] = React.useState<InventoryBarcodeSource>("manufacturer");
  const [error, setError] = React.useState<string | null>(null);
  const packs = item.packs ?? [];

  const submit = async () => {
    if (!code.trim() || busy) return;
    setError(null);
    try {
      await onSubmit({
        code: code.trim(),
        pack_id: packId === ITEM_LEVEL ? undefined : packId,
        source
      });
      setCode("");
    } catch (e) {
      setError(saveErrorText(e));
    }
  };

  return (
    <div className="space-y-3 rounded-lg border border-border bg-muted/30 p-3">
      <label className="space-y-1">
        <span className="text-[11px] text-muted-foreground">Barcode / UPC</span>
        <Input
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="0123456789012"
          inputMode="numeric"
        />
      </label>
      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1">
          <span className="text-[11px] text-muted-foreground">Maps to</span>
          <Select value={packId} onValueChange={setPackId}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ITEM_LEVEL}>Item (any pack)</SelectItem>
              {packs.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <span className="text-[11px] text-muted-foreground">Source</span>
          <Select value={source} onValueChange={(v) => setSource(v as InventoryBarcodeSource)}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="manufacturer">Manufacturer</SelectItem>
              <SelectItem value="internal">Internal</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
      {error ? <p className="text-[11px] text-trend-down">{error}</p> : null}
      <div className="flex items-center justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button size="sm" onClick={submit} disabled={!code.trim() || busy}>
          Add barcode
        </Button>
      </div>
    </div>
  );
}

// Packs + barcodes management for one item (ADR-0737). Slots into the item detail drawer
// under the cost/conversion editor.
export function ItemPackagingSection({ item }: { item: InventoryItem }) {
  const { savePack, deletePack, saveBarcode, deleteBarcode, isSaving, isDeleting } =
    useItemPackEditor(item.id);
  const mint = useMintBarcode(item.id);
  // null = closed; "new" = add form; a pack id = editing that pack.
  const [packForm, setPackForm] = React.useState<string | null>(null);
  const [addingBarcode, setAddingBarcode] = React.useState(false);
  // The internal code whose print dialog is open (null = closed).
  const [printCode, setPrintCode] = React.useState<string | null>(null);

  const packs = item.packs ?? [];
  const barcodes = item.barcodes ?? [];
  const busy = isSaving || isDeleting;
  const packLabel = (id: string | null | undefined) =>
    id ? (packs.find((p) => p.id === id)?.label ?? "—") : "Item";

  return (
    <section className="rounded-lg border border-border p-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm font-medium">
          <Boxes className="size-4 text-muted-foreground" />
          Packaging
        </div>
        {packForm === null ? (
          <Button variant="outline" size="sm" onClick={() => setPackForm("new")}>
            <Plus className="size-3.5" />
            Add pack
          </Button>
        ) : null}
      </div>

      <div className="mt-3 space-y-2">
        {packForm === "new" ? (
          <PackForm
            item={item}
            pack={null}
            busy={busy}
            onSubmit={async (body) => {
              await savePack(body);
              setPackForm(null);
            }}
            onCancel={() => setPackForm(null)}
          />
        ) : null}

        {packs.length === 0 && packForm === null ? (
          <p className="text-[13px] text-muted-foreground">
            No packs yet. Add one so the floor can receive and count by the case or bag.
          </p>
        ) : null}

        {packs.map((p) =>
          packForm === p.id ? (
            <PackForm
              key={p.id}
              item={item}
              pack={p}
              busy={busy}
              onSubmit={async (body) => {
                await savePack(body, p.id);
                setPackForm(null);
              }}
              onCancel={() => setPackForm(null)}
            />
          ) : (
            <div
              key={p.id}
              className="flex items-center justify-between rounded-lg border border-border px-3 py-2"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">{p.label}</span>
                  {p.is_purchase_default ? <Badge variant="secondary">Default</Badge> : null}
                  {p.vendor ? (
                    <span className="text-[11px] text-muted-foreground">{p.vendor}</span>
                  ) : null}
                </div>
                <div className="font-mono text-[11px] tabular-nums text-muted-foreground">
                  = {p.base_qty_per_pack} {item.unit}
                </div>
              </div>
              <div className="flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setPackForm(p.id)}
                  disabled={busy || packForm !== null}
                >
                  Edit
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => void deletePack(p.id)}
                  disabled={busy || packForm !== null}
                  aria-label={`Delete ${p.label}`}
                >
                  <Trash2 className="size-3.5 text-muted-foreground" />
                </Button>
              </div>
            </div>
          )
        )}
      </div>

      <div className="mt-5 flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm font-medium">
          <Barcode className="size-4 text-muted-foreground" />
          Barcodes
        </div>
        {!addingBarcode ? (
          <div className="flex items-center gap-1.5">
            <Button
              variant="outline"
              size="sm"
              disabled={busy || mint.isPending}
              onClick={async () => {
                const res = await mint.mutateAsync({});
                setPrintCode(res.code);
              }}
            >
              <Printer className="size-3.5" />
              {mint.isPending ? "Minting…" : "Mint internal"}
            </Button>
            <Button variant="outline" size="sm" onClick={() => setAddingBarcode(true)}>
              <Plus className="size-3.5" />
              Add barcode
            </Button>
          </div>
        ) : null}
      </div>

      <div className="mt-3 space-y-2">
        {addingBarcode ? (
          <BarcodeForm
            item={item}
            busy={busy}
            onSubmit={async (body) => {
              await saveBarcode(body);
              setAddingBarcode(false);
            }}
            onCancel={() => setAddingBarcode(false)}
          />
        ) : null}

        {barcodes.length === 0 && !addingBarcode ? (
          <p className="text-[13px] text-muted-foreground">
            No barcodes. Add a UPC so the floor can scan to receive or count.
          </p>
        ) : null}

        {barcodes.map((b) => (
          <div
            key={b.code}
            className="flex items-center justify-between rounded-lg border border-border px-3 py-2"
          >
            <div className="min-w-0">
              <div className="font-mono text-sm tabular-nums">{b.code}</div>
              <div className="text-[11px] text-muted-foreground">
                {packLabel(b.pack_id)} · {b.source}
              </div>
            </div>
            <div className="flex items-center gap-1">
              {b.source === "internal" ? (
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => setPrintCode(b.code)}
                  aria-label={`Print label ${b.code}`}
                >
                  <Printer className="size-3.5 text-muted-foreground" />
                </Button>
              ) : null}
              <Button
                variant="ghost"
                size="icon"
                onClick={() => void deleteBarcode(b.code)}
                disabled={busy}
                aria-label={`Delete barcode ${b.code}`}
              >
                <Trash2 className="size-3.5 text-muted-foreground" />
              </Button>
            </div>
          </div>
        ))}
      </div>

      <PrintLabelDialog
        code={printCode ?? ""}
        itemName={item.name}
        open={printCode !== null}
        onOpenChange={(next) => {
          if (!next) {
            setPrintCode(null);
          }
        }}
      />
    </section>
  );
}
