"use client";

import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface DangerActionProps {
  title: string;
  body: string;
  action: string;
  dialogTitle: string;
  dialogBody: string;
  confirmLabel: string;
  /** When set, the confirm button stays disabled until the operator types this. */
  requireText?: string;
  onConfirm: () => void;
}

function DangerAction({
  title,
  body,
  action,
  dialogTitle,
  dialogBody,
  confirmLabel,
  requireText,
  onConfirm,
}: DangerActionProps) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const ready = !requireText || typed === requireText;

  return (
    <div className="flex flex-wrap items-center justify-between gap-4 border-b py-4 last:border-b-0">
      <div className="min-w-0" style={{ flex: "1 1 240px" }}>
        <div className="text-sm font-medium">{title}</div>
        <p className="mt-1 max-w-[60ch] text-xs text-muted-foreground">{body}</p>
      </div>
      <Button variant="destructive" size="sm" onClick={() => setOpen(true)}>
        {action}
      </Button>

      <AlertDialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) setTyped("");
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{dialogTitle}</AlertDialogTitle>
            <AlertDialogDescription>{dialogBody}</AlertDialogDescription>
          </AlertDialogHeader>
          {requireText ? (
            <div className="space-y-1.5">
              <Label htmlFor="danger-confirm-text" className="text-xs text-muted-foreground">
                Type <span className="font-mono font-semibold text-foreground">{requireText}</span> to confirm.
              </Label>
              <Input
                id="danger-confirm-text"
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                placeholder={requireText}
                autoComplete="off"
                className="font-mono"
              />
            </div>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" disabled={!ready} onClick={onConfirm}>
              {confirmLabel}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

export function DangerPanel() {
  return (
    <div className="space-y-3">
      <div className="rounded-xl border border-destructive/30 bg-card px-6 shadow-sm">
        <DangerAction
          title="Clear local cache"
          body="Forces every device to re-pull menu, settings, and integration data on next load."
          action="Clear cache"
          dialogTitle="Clear cache on all devices?"
          dialogBody="Each connected screen will re-download its data on the next request. Brief flicker expected; no data is lost."
          confirmLabel="Clear cache"
          onConfirm={() => toast.success("Cache cleared")}
        />
        <DangerAction
          title="Reset workspace to defaults"
          body="Restores every setting on these pages to its built-in default. Integrations and team stay intact."
          action="Reset all"
          dialogTitle="Reset all settings?"
          dialogBody="Every setting returns to its built-in default. Your integrations and team stay intact, but tuned values are lost."
          confirmLabel="Reset settings"
          requireText="RESET"
          onConfirm={() => toast.success("Settings reset to defaults")}
        />
      </div>
      <p className="px-1 text-xs text-muted-foreground">
        Looking for the daily reset? It lives in{" "}
        <Link href="/settings/reset" className="font-medium text-foreground underline underline-offset-2">
          Daily Reset
        </Link>
        .
      </p>
    </div>
  );
}
