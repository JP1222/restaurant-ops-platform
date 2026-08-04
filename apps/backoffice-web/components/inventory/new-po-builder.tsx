"use client";

import { useMemo, useState } from "react";
import { Plus, Trash2 } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
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
import {
  isPoNotEditable,
  useCancelPurchaseOrder,
  useCreatePurchaseOrder,
  usePurchaseOrderDetail,
  useUpdatePurchaseOrder
} from "@/hooks/use-inventory";
import { formatCents } from "@/lib/format";
import type {
  InventoryDataset,
  InventoryPurchaseOrderCreate,
  InventoryPurchaseOrderUpdate
} from "@rop/contracts";

const SELECT_CLASS =
  "h-9 w-full rounded-md border border-border bg-background px-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring";

interface DraftLine {
  sku: string;
  qty: string;
  cost: string;
  // The PO line's display name, kept only so an item archived AFTER the PO was
  // created still shows a label in the edit form (it's absent from data.items).
  name?: string;
}

const emptyLine = (): DraftLine => ({ sku: "", qty: "", cost: "" });

// PO builder (catalog D3 create + 2026-06-12 audit P1 edit). Pick a vendor, add
// catalog lines (item + qty + unit cost), see a running total, submit. Create mode
// (`editId` absent) makes a new `submitted` PO; edit mode loads an open PO's lines,
// PUTs a full replace, and exposes a destructive Cancel action. Controlled +
// conditionally mounted by the parent, so it resets fresh on each open.
export function NewPoBuilder({
  open,
  onOpenChange,
  data,
  initialVendor,
  editId
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  data: InventoryDataset;
  initialVendor?: string;
  // When set, the dialog edits this existing PO instead of creating a new one.
  editId?: string;
}) {
  const isEdit = editId != null;
  const detailQuery = usePurchaseOrderDetail(isEdit ? editId : null);
  const [vendor, setVendor] = useState(initialVendor ?? "");
  const [expected, setExpected] = useState("");
  const [lines, setLines] = useState<DraftLine[]>([emptyLine()]);
  const [seeded, setSeeded] = useState(false);
  const [confirmCancelOpen, setConfirmCancelOpen] = useState(false);

  const create = useCreatePurchaseOrder();
  const update = useUpdatePurchaseOrder();
  const cancel = useCancelPurchaseOrder();

  const itemsById = useMemo(() => new Map(data.items.map((it) => [it.id, it])), [data.items]);

  // Seed the form from the fetched PO detail exactly once (edit mode), in render
  // rather than an effect — this is React's "adjusting state when data changes"
  // pattern, which avoids the cascading re-render an effect-based sync triggers.
  // A legacy line with no stored unit cost falls back to the item's current cost
  // so the prefill is sensible rather than blank. The parent remounts this dialog
  // per PO (`key={editPoId}`), so the once-guard resets naturally between edits.
  if (isEdit && !seeded && detailQuery.data) {
    const detail = detailQuery.data;
    setSeeded(true);
    setVendor(detail.vendor);
    setExpected(detail.expected ?? "");
    setLines(
      detail.line_items.length > 0
        ? detail.line_items.map((line) => {
            const item = itemsById.get(line.sku);
            const cents = line.unit_cost_cents ?? item?.cost_cents ?? 0;
            return {
              sku: line.sku,
              qty: String(line.qty_ordered),
              cost: cents ? (cents / 100).toString() : "",
              name: line.name
            };
          })
        : [emptyLine()]
    );
  }

  const totalCents = lines.reduce((sum, line) => {
    const qty = parseFloat(line.qty);
    const cost = parseFloat(line.cost);
    if (!Number.isFinite(qty) || !Number.isFinite(cost)) return sum;
    return sum + qty * cost * 100;
  }, 0);

  const validLines = lines.filter((line) => line.sku && parseFloat(line.qty) > 0);
  const valid = vendor.trim() !== "" && validLines.length > 0;

  const setLine = (index: number, patch: Partial<DraftLine>) =>
    setLines((cur) => cur.map((line, i) => (i === index ? { ...line, ...patch } : line)));

  const pickItem = (index: number, sku: string) => {
    const item = itemsById.get(sku);
    setLine(index, { sku, cost: item ? (item.cost_cents / 100).toString() : "" });
  };

  const addLine = () => setLines((cur) => [...cur, emptyLine()]);
  const removeLine = (index: number) =>
    setLines((cur) => (cur.length > 1 ? cur.filter((_, i) => i !== index) : cur));

  const submitting = create.isPending || update.isPending;
  const mutationError = isEdit ? update.error : create.error;
  // Loading the existing PO before its lines can be edited.
  const loadingDetail = isEdit && detailQuery.isLoading;
  // The detail fetch failed (404 po_not_found, or a 502/network blip). Without
  // this branch the form would fall through to its empty defaults, and since the
  // PUT is a full replace, saving that blank form would wipe the real PO's lines.
  const detailError = isEdit && detailQuery.isError;

  const handleSubmit = async () => {
    if (!valid) return;
    const linePayload = validLines.map((line) => ({
      sku: line.sku,
      qty_ordered: parseFloat(line.qty),
      unit_cost_cents: (parseFloat(line.cost) || 0) * 100
    }));
    if (editId != null) {
      const body: InventoryPurchaseOrderUpdate = {
        vendor: vendor.trim(),
        expected: expected.trim() || undefined,
        lines: linePayload
      };
      await update.mutateAsync({ id: editId, body });
    } else {
      const body: InventoryPurchaseOrderCreate = {
        vendor: vendor.trim(),
        expected: expected.trim() || undefined,
        lines: linePayload
      };
      await create.mutateAsync(body);
    }
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-[640px]">
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            void handleSubmit();
          }}
        >
          <DialogHeader>
            <DialogTitle>{isEdit ? "Edit purchase order" : "New purchase order"}</DialogTitle>
            <DialogDescription>
              {isEdit
                ? "Adjust the vendor, expected date, or lines. Changes replace the order; receiving picks it up from there."
                : "Pick a vendor and add catalog lines. The order is created as “submitted” — receive it from the Receiving tab when it arrives."}
            </DialogDescription>
          </DialogHeader>

          {loadingDetail ? (
            <div className="py-10 text-center text-sm text-muted-foreground">Loading order…</div>
          ) : detailError ? (
            <Alert variant="destructive">
              <AlertTitle>Couldn&rsquo;t load this purchase order</AlertTitle>
              <AlertDescription>
                It may have been received or cancelled. Close and refresh the Receiving list to see its
                current state.
              </AlertDescription>
            </Alert>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label htmlFor="po-vendor">Vendor</Label>
                  <select
                    id="po-vendor"
                    value={vendor}
                    onChange={(event) => setVendor(event.target.value)}
                    className={SELECT_CLASS}
                  >
                    <option value="">Select vendor…</option>
                    {data.vendors.map((v) => (
                      <option key={v.id} value={v.name}>
                        {v.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="space-y-1">
                  <Label htmlFor="po-expected">
                    Expected <span className="text-muted-foreground">(optional)</span>
                  </Label>
                  <Input
                    id="po-expected"
                    value={expected}
                    onChange={(event) => setExpected(event.target.value)}
                    placeholder="2026-06-10"
                    maxLength={40}
                  />
                </div>
              </div>

              <div className="space-y-2">
                <Label>Lines</Label>
                <div className="space-y-2">
                  {lines.map((line, index) => (
                    <div key={index} className="flex items-end gap-2">
                      <div className="min-w-0 flex-1 space-y-1">
                        {index === 0 ? (
                          <span className="text-[11px] text-muted-foreground">Item</span>
                        ) : null}
                        <select
                          aria-label="Item"
                          value={line.sku}
                          onChange={(event) => pickItem(index, event.target.value)}
                          className={SELECT_CLASS}
                        >
                          <option value="">Select item…</option>
                          {/* An item archived after this PO was created is absent
                              from data.items; show its name so the line isn't a
                              blank dropdown the operator can't identify. */}
                          {line.sku && !itemsById.has(line.sku) ? (
                            <option value={line.sku}>{line.name ?? line.sku} (unavailable)</option>
                          ) : null}
                          {data.items.map((it) => (
                            <option key={it.id} value={it.id}>
                              {it.name}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div className="w-20 space-y-1">
                        {index === 0 ? (
                          <span className="text-[11px] text-muted-foreground">Qty</span>
                        ) : null}
                        <Input
                          aria-label="Quantity"
                          value={line.qty}
                          inputMode="decimal"
                          onChange={(event) => setLine(index, { qty: event.target.value })}
                          placeholder="0"
                        />
                      </div>
                      <div className="w-24 space-y-1">
                        {index === 0 ? (
                          <span className="text-[11px] text-muted-foreground">Unit $</span>
                        ) : null}
                        <Input
                          aria-label="Unit cost"
                          value={line.cost}
                          inputMode="decimal"
                          onChange={(event) => setLine(index, { cost: event.target.value })}
                          placeholder="0.00"
                        />
                      </div>
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
                  ))}
                </div>
                <Button type="button" variant="outline" size="sm" onClick={addLine}>
                  <Plus className="size-3.5" />
                  Add line
                </Button>
              </div>

              <div className="flex items-center justify-between rounded-md border border-border bg-secondary/30 px-3 py-2 text-sm">
                <span className="text-muted-foreground">Order total</span>
                <span className="font-mono font-medium tabular-nums">
                  {formatCents(Math.round(totalCents))}
                </span>
              </div>
            </>
          )}

          {mutationError ? (
            <Alert variant="destructive">
              <AlertTitle>
                {isEdit ? "Could not update the purchase order" : "Could not create the purchase order"}
              </AlertTitle>
              <AlertDescription>
                {isPoNotEditable(mutationError)
                  ? "This order was already received or cancelled. Close and refresh to see its current state."
                  : mutationError instanceof Error
                    ? mutationError.message
                    : "Unknown error"}
              </AlertDescription>
            </Alert>
          ) : null}

          {cancel.isError ? (
            <Alert variant="destructive">
              <AlertTitle>Could not cancel the purchase order</AlertTitle>
              <AlertDescription>
                {isPoNotEditable(cancel.error)
                  ? "This order was already received. Close and refresh to see its current state."
                  : cancel.error instanceof Error
                    ? cancel.error.message
                    : "Unknown error"}
              </AlertDescription>
            </Alert>
          ) : null}

          <DialogFooter className={isEdit ? "sm:justify-between" : undefined}>
            {isEdit ? (
              <Button
                type="button"
                variant="ghost"
                className="text-destructive hover:text-destructive"
                onClick={() => setConfirmCancelOpen(true)}
                disabled={submitting || cancel.isPending}
              >
                Cancel order
              </Button>
            ) : null}
            <div className="flex gap-2">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Close
              </Button>
              <Button type="submit" disabled={submitting || loadingDetail || detailError || !valid}>
                {submitting
                  ? isEdit
                    ? "Saving…"
                    : "Creating…"
                  : isEdit
                    ? "Save changes"
                    : "Create PO"}
              </Button>
            </div>
          </DialogFooter>
        </form>
      </DialogContent>

      {isEdit ? (
        <AlertDialog open={confirmCancelOpen} onOpenChange={setConfirmCancelOpen}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Cancel this purchase order?</AlertDialogTitle>
              <AlertDialogDescription>
                The order is removed from Receiving and can&rsquo;t be received. This can&rsquo;t be
                undone — you&rsquo;d create a new PO instead.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={cancel.isPending}>Keep order</AlertDialogCancel>
              <AlertDialogAction
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                onClick={async (event) => {
                  // preventDefault stops Radix's auto-close so the dialog stays up
                  // while the mutation runs. We then drive closing ourselves: on
                  // success close both dialogs; on failure (e.g. a 409 because the
                  // PO was received mid-edit) close ONLY the confirm dialog so the
                  // cancel.isError alert in the main dialog becomes visible. The
                  // try/catch also keeps the rejection from going unhandled.
                  event.preventDefault();
                  if (editId == null) return;
                  try {
                    await cancel.mutateAsync(editId);
                    onOpenChange(false);
                  } catch {
                    // Error surfaced by the cancel.isError alert below.
                  } finally {
                    setConfirmCancelOpen(false);
                  }
                }}
                disabled={cancel.isPending}
              >
                {cancel.isPending ? "Cancelling…" : "Cancel order"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      ) : null}
    </Dialog>
  );
}
