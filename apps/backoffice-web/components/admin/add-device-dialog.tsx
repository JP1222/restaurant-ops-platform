"use client";

import { useEffect, useState } from "react";
import { Check, Copy } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import type { KdsDevicePairCreateResponse, KdsDeviceRole } from "@rop/contracts";
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
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Segmented } from "@/components/settings/segmented";
import { useCreatePairing } from "@/hooks/use-admin-devices";

interface AddDeviceDialogProps {
  merchantId: string;
}

const ROLE_LABEL: Record<KdsDeviceRole, string> = {
  KDS: "KDS board",
  DISPLAY: "Order-ready display"
};

const ROLE_OPTIONS = [
  { value: "KDS", label: ROLE_LABEL.KDS },
  { value: "DISPLAY", label: ROLE_LABEL.DISPLAY }
];

function formatCountdown(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${String(secs).padStart(2, "0")}`;
}

export function AddDeviceDialog({ merchantId }: AddDeviceDialogProps) {
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState("");
  const [role, setRole] = useState<KdsDeviceRole>("KDS");
  const [pairing, setPairing] = useState<KdsDevicePairCreateResponse | null>(null);
  const [remaining, setRemaining] = useState(0);
  const [copied, setCopied] = useState(false);
  const pair = useCreatePairing();

  // Tick the claim countdown down to zero. The claim code is one-time + short-
  // lived; once it expires the panel switches to a "generate a new one" state.
  // `remaining` is seeded in generate() (not here) so the effect only owns the
  // timer — seeding it in the effect body would cascade an extra render.
  useEffect(() => {
    if (!pairing) return;
    const id = setInterval(() => {
      setRemaining((prev) => {
        if (prev <= 1) {
          clearInterval(id);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(id);
  }, [pairing]);

  function reset() {
    setLabel("");
    setRole("KDS");
    setPairing(null);
    setRemaining(0);
    setCopied(false);
    pair.reset();
  }

  async function generate(nextLabel: string, nextRole: KdsDeviceRole) {
    const trimmed = nextLabel.trim();
    if (!trimmed) return;
    const response = await pair.mutateAsync({ merchantId, label: trimmed, role: nextRole });
    setPairing(response);
    setRemaining(response.expiresInSeconds);
  }

  async function copyLink() {
    if (!pairing) return;
    try {
      await navigator.clipboard.writeText(pairing.pairUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard blocked (insecure context / permissions) — the link text
      // below is selectable, so the manager can still copy it by hand.
    }
  }

  const expired = pairing !== null && remaining === 0;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) reset();
      }}
    >
      <DialogTrigger asChild>
        <Button>Pair a device</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{pairing ? "Pair this device" : "Pair a device"}</DialogTitle>
          <DialogDescription>
            {pairing
              ? "Open the link on the device or scan the code. It binds once and stays locked to this store — no login, no store id."
              : "Generate a one-time link a KDS screen or order-ready display opens once to lock itself to this store."}
          </DialogDescription>
        </DialogHeader>

        {pairing ? (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              {ROLE_LABEL[pairing.role]} · <span className="font-medium text-foreground">{pairing.label}</span>
            </p>

            <div className="flex flex-col items-center gap-3">
              {/* QR is always dark-on-white: inverted codes fail many scanners,
                  and the white wrapper keeps it scannable in dark mode too. */}
              <div className={expired ? "rounded-lg bg-white p-3 opacity-30" : "rounded-lg bg-white p-3"}>
                <QRCodeSVG
                  value={pairing.pairUrl}
                  size={176}
                  level="M"
                  marginSize={1}
                  title={`Pair ${pairing.label}`}
                />
              </div>
              <div
                className={
                  expired
                    ? "font-mono text-2xl font-semibold tracking-[0.2em] tabular-nums text-muted-foreground line-through"
                    : "select-all font-mono text-2xl font-semibold tracking-[0.2em] tabular-nums"
                }
              >
                {pairing.claimCode}
              </div>
            </div>

            <div className="flex items-center gap-2">
              <Input readOnly value={pairing.pairUrl} className="font-mono text-xs" />
              <Button type="button" variant="outline" size="sm" onClick={copyLink}>
                {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
                {copied ? "Copied" : "Copy"}
              </Button>
            </div>

            {expired ? (
              <Alert variant="destructive">
                <AlertTitle>Pairing code expired</AlertTitle>
                <AlertDescription>
                  This code was one-time and timed out unused. Generate a fresh one to try again.
                </AlertDescription>
              </Alert>
            ) : (
              <p className="text-center text-sm text-muted-foreground tabular-nums">
                Expires in {formatCountdown(remaining)}
              </p>
            )}

            <DialogFooter>
              {expired ? (
                <Button
                  type="button"
                  disabled={pair.isPending}
                  onClick={() => generate(pairing.label, pairing.role)}
                >
                  {pair.isPending ? "Generating..." : "Generate new code"}
                </Button>
              ) : (
                <Button type="button" onClick={() => setOpen(false)}>
                  Done
                </Button>
              )}
            </DialogFooter>
          </div>
        ) : (
          <form
            className="space-y-4"
            onSubmit={async (event) => {
              event.preventDefault();
              await generate(label, role);
            }}
          >
            <div className="space-y-1">
              <Label htmlFor="device-label">Label</Label>
              <Input
                id="device-label"
                value={label}
                onChange={(event) => setLabel(event.target.value)}
                placeholder="Kitchen pad 1"
                maxLength={120}
                required
                autoFocus
              />
            </div>

            <div className="space-y-1.5">
              <Label>Device type</Label>
              <Segmented
                value={role}
                onValueChange={(next) => setRole(next === "DISPLAY" ? "DISPLAY" : "KDS")}
                options={ROLE_OPTIONS}
                aria-label="Device type"
              />
              <p className="text-xs text-muted-foreground">
                {role === "DISPLAY"
                  ? "A customer-facing order-ready screen."
                  : "A kitchen board for cooks."}
              </p>
            </div>

            {pair.isError ? (
              <Alert variant="destructive">
                <AlertTitle>Could not start pairing</AlertTitle>
                <AlertDescription>
                  {pair.error instanceof Error ? pair.error.message : "Unknown error"}
                </AlertDescription>
              </Alert>
            ) : null}

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={pair.isPending || label.trim().length === 0}>
                {pair.isPending ? "Generating..." : "Generate pairing link"}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
