"use client";

import * as React from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog";
import { printLabel, renderBarcodeDataUrl } from "@/lib/print-label";

// Preview + print a Code128 label for an internal house code (barcode-onboarding ADR, D4). The
// floor sticks it on the bin and scans it like any other barcode. Rendering + printing are fully
// client-side (lib/print-label).
export function PrintLabelDialog({
  code,
  itemName,
  open,
  onOpenChange
}: {
  code: string;
  itemName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  // Derived (not effect-driven state): render the Code128 preview from the code when open. Guards
  // `open` first so it never touches `document` during SSR (the dialog only opens client-side).
  const preview = React.useMemo(() => {
    if (!open || !code) {
      return null;
    }
    try {
      return renderBarcodeDataUrl(code);
    } catch {
      return null;
    }
  }, [open, code]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Print label</DialogTitle>
          <DialogDescription>
            Internal code <span className="font-mono">{code}</span> for {itemName}. Print it on the
            Dymo, stick it on the bin, and the floor scans it like any other barcode.
          </DialogDescription>
        </DialogHeader>
        <div className="flex min-h-28 items-center justify-center rounded-md border border-border bg-background p-4">
          {preview ? (
            // eslint-disable-next-line @next/next/no-img-element -- a client-side data-URL barcode, not a remote asset
            <img src={preview} alt={`Barcode ${code}`} className="max-h-24" />
          ) : (
            <span className="text-sm text-muted-foreground">Rendering…</span>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => void navigator.clipboard?.writeText(code)}>
            Copy code
          </Button>
          <Button onClick={() => printLabel(code, itemName)}>Print</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
