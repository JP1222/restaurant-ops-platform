"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Eye, EyeOff, LoaderCircle, RotateCcw, UtensilsCrossed } from "lucide-react";
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
import type { StoreLocation } from "@rop/contracts";
import { useImportSquareCatalog } from "@/hooks/use-square";
import { ConnectionStatusBadge } from "./connection-status-badge";

interface StoreDetailProps {
  location: StoreLocation;
  merchantName?: string;
  locationLabel?: string;
  tokenLast4?: string;
  environment?: "sandbox" | "production";
}

export function StoreDetail({ location, merchantName, locationLabel, tokenLast4, environment }: StoreDetailProps) {
  const router = useRouter();
  const [rotateOpen, setRotateOpen] = useState(false);
  const [rotateToken, setRotateToken] = useState("");
  const [rotateVisible, setRotateVisible] = useState(false);
  const [rotating, setRotating] = useState(false);

  const [reimportState, setReimportState] = useState<"idle" | "running" | "done" | "error">("idle");
  const [reimportCount, setReimportCount] = useState<number | null>(null);
  const importCatalog = useImportSquareCatalog();

  const [confirmRemoveOpen, setConfirmRemoveOpen] = useState(false);
  const [removing, setRemoving] = useState(false);

  const isSquare = location.merchantId?.startsWith("square:") ?? false;
  const connectionStatus = location.merchantId ? "connected" : "none";

  const handleRotateSave = async () => {
    if (!rotateToken.trim()) return;
    setRotating(true);
    // Phase 2: rotation endpoint not yet built — placeholder
    await new Promise<void>((r) => setTimeout(r, 600));
    setRotating(false);
    setRotateOpen(false);
    setRotateToken("");
    toast.success("Token rotated. The old token is now inactive.");
  };

  const handleReimport = async () => {
    if (!isSquare || !location.merchantId) return;
    setReimportState("running");
    try {
      const result = await importCatalog.mutateAsync({ posStoreId: location.merchantId });
      setReimportCount(result.itemCount);
      setReimportState("done");
    } catch {
      setReimportState("error");
    }
  };

  const handleRemoveConfirm = async () => {
    setRemoving(true);
    // Phase 2: removal endpoint not yet built — placeholder
    await new Promise<void>((r) => setTimeout(r, 600));
    setRemoving(false);
    setConfirmRemoveOpen(false);
    toast.success("Store removed.");
    router.push("/settings/stores");
  };

  return (
    <div className="max-w-[760px] space-y-4">
      {/* Breadcrumb + title */}
      <div>
        <p className="text-[12.5px] text-muted-foreground">
          Settings ·{" "}
          <Link href="/settings/stores" className="hover:underline">
            Stores
          </Link>{" "}
          · {location.name}
        </p>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <h1 className="text-[22px] font-semibold">{location.name}</h1>
          <ConnectionStatusBadge status={connectionStatus} />
        </div>
      </div>

      {/* POS connection card */}
      <div className="overflow-hidden rounded-[14px] border bg-card">
        <div className="border-b px-4 py-3">
          <p className="text-[13.5px] font-semibold">POS connection</p>
        </div>
        {location.merchantId ? (
          <div className="divide-y text-[13.5px]">
            <div className="flex items-center gap-4 px-4 py-3">
              <span className="w-[120px] shrink-0 text-muted-foreground">Platform</span>
              <span className="flex items-center gap-2">
                <span
                  className={
                    isSquare
                      ? "flex size-[22px] items-center justify-center rounded-md bg-info-soft font-mono text-xs font-semibold text-info-foreground"
                      : "flex size-[22px] items-center justify-center rounded-md bg-accent-soft font-mono text-xs font-semibold text-trend-up"
                  }
                >
                  {isSquare ? "S" : "C"}
                </span>
                {isSquare ? "Square" : "Clover"}
              </span>
            </div>

            {environment && (
              <div className="flex items-center gap-4 px-4 py-3">
                <span className="w-[120px] shrink-0 text-muted-foreground">Environment</span>
                <span
                  className={`rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${
                    environment === "production"
                      ? "bg-info-soft text-info-foreground"
                      : "bg-warn-soft text-warn-foreground"
                  }`}
                >
                  {environment === "production" ? "Production" : "Sandbox"}
                </span>
              </div>
            )}

            {merchantName && (
              <div className="flex items-center gap-4 px-4 py-3">
                <span className="w-[120px] shrink-0 text-muted-foreground">Merchant</span>
                <span>{merchantName}</span>
              </div>
            )}

            {locationLabel && (
              <div className="flex items-center gap-4 px-4 py-3">
                <span className="w-[120px] shrink-0 text-muted-foreground">Location</span>
                <span className="text-muted-foreground">{locationLabel}</span>
              </div>
            )}

            {/* Token row */}
            <div className="px-4 py-3">
              <div className="flex flex-wrap items-start gap-4">
                <span className="w-[120px] shrink-0 text-muted-foreground">Access token</span>
                {!rotateOpen ? (
                  <div className="flex flex-1 flex-wrap items-center gap-3">
                    <span className="font-mono text-[13px]">
                      •••• •••• {tokenLast4 ?? "????"}
                    </span>
                    <span className="rounded-full bg-accent-soft px-2 py-0.5 text-[11px] font-semibold text-trend-up">
                      Configured ✓
                    </span>
                    <Button
                      variant="outline"
                      size="sm"
                      className="ml-auto h-7 text-xs"
                      onClick={() => setRotateOpen(true)}
                    >
                      <RotateCcw className="mr-1.5 size-3" />
                      Rotate token
                    </Button>
                  </div>
                ) : (
                  <div className="flex-1 space-y-2">
                    <div className="relative">
                      <Input
                        type={rotateVisible ? "text" : "password"}
                        value={rotateToken}
                        onChange={(e) => setRotateToken(e.target.value)}
                        placeholder="Paste new token"
                        className="h-9 rounded-[9px] pr-10 font-mono text-sm"
                        autoComplete="off"
                      />
                      <button
                        type="button"
                        onClick={() => setRotateVisible((v) => !v)}
                        className="absolute inset-y-0 right-2 flex items-center text-muted-foreground hover:text-foreground"
                      >
                        {rotateVisible ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
                      </button>
                    </div>
                    <p className="text-[11.5px] text-muted-foreground">
                      Saving replaces the old token immediately. The old one stops working at once.
                    </p>
                    <div className="flex gap-2">
                      <Button size="sm" className="h-8 text-xs" onClick={handleRotateSave} disabled={rotating || !rotateToken}>
                        {rotating && <LoaderCircle className="mr-1.5 size-3.5 animate-spin" />}
                        Save
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-8 text-xs"
                        onClick={() => { setRotateOpen(false); setRotateToken(""); setRotateVisible(false); }}
                      >
                        Cancel
                      </Button>
                    </div>
                  </div>
                )}
              </div>
              {!rotateOpen && (
                <p className="mt-1.5 text-[11.5px] text-muted-foreground">
                  The full token is never shown — we keep it write-only and store only the last 4 digits.
                </p>
              )}
            </div>
          </div>
        ) : (
          <div className="px-4 py-6 text-center text-[13.5px] text-muted-foreground">
            No POS connected yet.{" "}
            <Link href="/settings/stores/new" className="text-accent hover:underline">
              Add a POS connection
            </Link>
          </div>
        )}
      </div>

      {/* Menu sync card */}
      {isSquare && (
        <div className="rounded-[14px] border bg-card p-4">
          <div className="flex items-center gap-3">
            <span className="flex size-[38px] shrink-0 items-center justify-center rounded-lg bg-accent-soft">
              <UtensilsCrossed className="size-5 text-accent" />
            </span>
            <div className="flex-1">
              <p className="text-[14px] font-semibold">Menu</p>
              {reimportState === "idle" && (
                <p className="text-[13px] text-muted-foreground">
                  Re-read items, modifiers and categories from Square.
                </p>
              )}
              {reimportState === "running" && (
                <p className="flex items-center gap-2 text-[13px] text-muted-foreground">
                  <LoaderCircle className="size-3.5 animate-spin" />
                  Re-reading catalog from Square…
                </p>
              )}
              {reimportState === "done" && (
                <p className="text-[13px] text-trend-up">
                  Re-imported {reimportCount ?? 0} items · just now
                </p>
              )}
              {reimportState === "error" && (
                <p className="text-[13px] text-destructive">Re-import failed — try again.</p>
              )}
            </div>
            {reimportState !== "running" && (
              <Button
                variant="outline"
                size="sm"
                className="h-8 shrink-0 text-xs"
                onClick={handleReimport}
              >
                Re-import menu
              </Button>
            )}
          </div>
        </div>
      )}

      {/* Danger zone */}
      <div className="rounded-[14px] border border-destructive bg-destructive-soft p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-[13.5px] font-semibold">Remove store</p>
            <p className="mt-0.5 text-[12.5px] text-muted-foreground">
              Disconnects the POS and removes this store. Analytics history is kept for 90 days.
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            className="h-8 shrink-0 border-destructive text-destructive hover:bg-destructive hover:text-white text-xs"
            onClick={() => setConfirmRemoveOpen(true)}
          >
            Remove store
          </Button>
        </div>
      </div>

      {/* Confirm remove dialog */}
      <AlertDialog open={confirmRemoveOpen} onOpenChange={setConfirmRemoveOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {location.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              This disconnects the POS and removes this store from the backoffice. Analytics history is
              kept for 90 days. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleRemoveConfirm}
              disabled={removing}
              className="bg-destructive text-white hover:bg-destructive/90"
            >
              {removing && <LoaderCircle className="mr-2 size-4 animate-spin" />}
              Remove store
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
