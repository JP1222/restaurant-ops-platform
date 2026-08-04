"use client";

import * as React from "react";
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle,
  Package,
  Search,
  Trash2,
  Upload
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { formatCents } from "@/lib/format";
import { cn } from "@/lib/utils";
import type {
  InventoryDataset,
  InventoryWasteReasonId
} from "@rop/contracts";

import { ToneBadge } from "./status-badge";
import type { WasteSubmission } from "@/hooks/use-inventory";

interface RecordWasteContentProps {
  data: InventoryDataset;
  onClose: () => void;
  onSubmit: (entry: WasteSubmission) => void;
}

function RecordWasteContent({ data, onClose, onSubmit }: RecordWasteContentProps) {
  const [skuQuery, setSkuQuery] = React.useState("");
  const [pickedSkuId, setPickedSkuId] = React.useState<string | null>(null);
  const [qty, setQty] = React.useState("");
  const [reasonId, setReasonId] = React.useState<InventoryWasteReasonId | "">("");
  const [notes, setNotes] = React.useState("");
  const [photoAttached, setPhotoAttached] = React.useState(false);

  const picked = data.items.find((it) => it.id === pickedSkuId) ?? null;
  const matches =
    !pickedSkuId && skuQuery
      ? data.items
          .filter((it) => {
            const q = skuQuery.toLowerCase();
            return it.name.toLowerCase().includes(q) || it.sku.toLowerCase().includes(q);
          })
          .slice(0, 6)
      : [];

  const qtyNum = parseFloat(qty) || 0;
  const costCents = picked ? Math.round(picked.cost_cents * qtyNum) : 0;
  const reason = data.waste_reasons.find((r) => r.id === reasonId);

  const photoRequired =
    !!picked && !!reason && costCents >= data.waste_settings.photo_required_over_cents;
  const approvalRequired = costCents >= data.waste_settings.manager_approval_over_cents;
  const canSubmit = !!picked && qtyNum > 0 && !!reason && (!photoRequired || photoAttached);

  return (
    <div className="flex h-full flex-col">
      <header className="flex flex-none items-center gap-3 border-b border-border p-5 pr-12">
        <div className="flex size-10 flex-none items-center justify-center rounded-lg border border-amber-200 bg-amber-50 dark:border-amber-900/60 dark:bg-amber-950/40">
          <Trash2 className="size-5 text-amber-700 dark:text-amber-300" />
        </div>
        <div className="flex-1">
          <h2 className="text-lg font-semibold tracking-tight">Record waste</h2>
          <p className="text-xs text-muted-foreground">
            Adjusts on-hand and logs against COGS.
          </p>
        </div>
      </header>

      <div className="flex-1 space-y-5 overflow-y-auto p-5">
        <section className="space-y-2">
          <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            1 · Item
          </label>
          {picked ? (
            <div className="flex items-center gap-3 rounded-lg border border-border bg-secondary/30 p-3">
              <Package className="size-4 text-muted-foreground" />
              <div className="flex-1">
                <div className="text-sm font-medium">{picked.name}</div>
                <div className="font-mono text-xs text-muted-foreground">
                  {picked.sku} · On hand{" "}
                  <span className="tabular-nums">{picked.on_hand}</span> {picked.unit}
                </div>
              </div>
              <button
                onClick={() => {
                  setPickedSkuId(null);
                  setSkuQuery("");
                }}
                className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
              >
                Change
              </button>
            </div>
          ) : (
            <>
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  autoFocus
                  placeholder="Search item, SKU, or scan barcode…"
                  className="pl-8"
                  value={skuQuery}
                  onChange={(e) => setSkuQuery(e.target.value)}
                />
              </div>
              {matches.length > 0 && (
                <div className="max-h-[180px] divide-y divide-border overflow-y-auto rounded-md border border-border">
                  {matches.map((it) => (
                    <button
                      key={it.id}
                      onClick={() => {
                        setPickedSkuId(it.id);
                        setSkuQuery("");
                      }}
                      className="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-secondary/40"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-medium">{it.name}</div>
                        <div className="font-mono text-[11px] text-muted-foreground">
                          {it.sku}
                        </div>
                      </div>
                      <span className="font-mono text-xs tabular-nums text-muted-foreground">
                        {formatCents(it.cost_cents)}/{it.unit}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
        </section>

        <section className="space-y-2">
          <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            2 · Quantity
          </label>
          <div className="flex items-center gap-2">
            <Input
              type="number"
              step="0.1"
              min="0"
              placeholder="0"
              value={qty}
              onChange={(e) => setQty(e.target.value)}
              className="flex-1 font-mono tabular-nums"
              disabled={!picked}
            />
            <span className="w-12 text-sm text-muted-foreground">{picked?.unit ?? ""}</span>
            {picked && qtyNum > 0 && (
              <ToneBadge tone={costCents > 5000 ? "danger" : "outline"} className="text-xs">
                ≈ {formatCents(costCents)}
              </ToneBadge>
            )}
          </div>
          {picked && qtyNum > picked.on_hand && (
            <p className="flex items-center gap-1 text-xs text-trend-down">
              <AlertCircle className="size-3" />
              Exceeds on-hand ({picked.on_hand} {picked.unit}). Check before submitting.
            </p>
          )}
        </section>

        <section className="space-y-2">
          <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            3 · Reason
          </label>
          <div className="grid grid-cols-2 gap-2">
            {data.waste_reasons.map((r) => (
              <button
                key={r.id}
                onClick={() => setReasonId(r.id)}
                className={cn(
                  "flex items-center gap-2 rounded-md border px-2.5 py-2 text-left text-sm transition-colors",
                  reasonId === r.id
                    ? "border-foreground/40 bg-secondary"
                    : "border-border hover:bg-secondary/60"
                )}
              >
                <span
                  className="size-2.5 flex-none rounded-sm"
                  style={{ background: r.color }}
                />
                <span className="truncate">{r.label}</span>
              </button>
            ))}
          </div>
        </section>

        <section className="space-y-2">
          <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            4 · Evidence &amp; notes
          </label>
          <button
            onClick={() => setPhotoAttached((p) => !p)}
            className={cn(
              "flex w-full items-center justify-center gap-2 rounded-md border border-dashed px-3 py-3 text-sm transition-colors",
              photoAttached
                ? "border-accent bg-trend-up-bg/50 text-trend-up"
                : "border-border text-muted-foreground hover:bg-secondary/40"
            )}
          >
            {photoAttached ? (
              <>
                <CheckCircle className="size-4" /> Photo attached
              </>
            ) : (
              <>
                <Upload className="size-4" /> Attach photo (camera or upload)
              </>
            )}
          </button>
          {photoRequired && !photoAttached && (
            <p className="flex items-center gap-1 text-xs text-amber-700 dark:text-amber-300">
              <AlertTriangle className="size-3" />
              Photo required for waste over{" "}
              {formatCents(data.waste_settings.photo_required_over_cents)}.
            </p>
          )}
          <Textarea
            rows={2}
            placeholder="Notes (optional)…"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </section>

        {approvalRequired && (
          <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-xs dark:border-amber-900/60 dark:bg-amber-950/40">
            <AlertTriangle className="size-4 flex-none text-amber-700 dark:text-amber-300" />
            <span className="text-amber-900 dark:text-amber-200">
              This entry exceeds {formatCents(data.waste_settings.manager_approval_over_cents)} —
              a manager will be asked to approve before it posts to COGS.
            </span>
          </div>
        )}
      </div>

      <footer className="flex flex-none items-center gap-2 border-t border-border p-4">
        <span className="text-xs text-muted-foreground">
          {picked && qtyNum > 0 && reason && (
            <>
              Posting{" "}
              <span className="font-mono tabular-nums text-foreground">
                {formatCents(costCents)}
              </span>{" "}
              · {reason.label}
            </>
          )}
        </span>
        <div className="ml-auto" />
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button
          disabled={!canSubmit}
          onClick={() => {
            if (!picked || !reason) return;
            onSubmit({
              sku: picked.id,
              qty: qtyNum,
              reason: reason.id,
              notes,
              photo: photoAttached,
              cost_cents: costCents
            });
          }}
        >
          {approvalRequired ? "Send for approval" : "Record waste"}
        </Button>
      </footer>
    </div>
  );
}

export interface RecordWasteSheetProps {
  open: boolean;
  data: InventoryDataset;
  onClose: () => void;
  onSubmit: (entry: WasteSubmission) => void;
  mobile: boolean;
}

export function RecordWasteSheet({
  open,
  data,
  onClose,
  onSubmit,
  mobile
}: RecordWasteSheetProps) {
  return (
    <Sheet open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <SheetContent
        side={mobile ? "bottom" : "right"}
        className={cn(
          "p-0 sm:max-w-[480px]",
          mobile && "max-h-[92vh] rounded-t-2xl border-t"
        )}
      >
        <SheetTitle className="sr-only">Record waste</SheetTitle>
        <RecordWasteContent data={data} onClose={onClose} onSubmit={onSubmit} />
      </SheetContent>
    </Sheet>
  );
}
